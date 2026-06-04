import os from "node:os";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import WebSocket from "ws";
import { ServerToAgentSchema, type AgentToServer, type CodexUsage, type LocalCodexActivity, type ServerToAgent } from "@cmc/protocol";
import { loadAgentConfig, saveAgentConfig, type RepoConfig } from "./config.js";
import { Runner } from "./codex-runner.js";
import { detectLocalCodexActivity } from "./local-activity.js";
import { syncLocalChats, type SyncLocalChatsResult } from "./local-chat-sync.js";
import { runCapture } from "./process-utils.js";
import { makeRedactor } from "./redact.js";
import { scanRepos } from "./repo-scanner.js";
import { sendVscodeBridgeCommand } from "./vscode-bridge.js";

const LOCAL_CHAT_SYNC_INTERVAL_MS = 60000;
const LOCAL_ACTIVITY_INTERVAL_MS = 1000;
const LOCAL_CHAT_SYNC_SETTLE_DELAYS_MS = [3000, 10000];
const LOCAL_CHAT_SYNC_ACTIVITY_MIN_INTERVAL_MS = 30000;
const LOCAL_CHAT_SYNC_BACKPRESSURE_BYTES = 16 * 1024 * 1024;
const MAX_EDITOR_FILE_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_PREVIEW_BYTES = 8 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 6 * 1024 * 1024;
const MAX_FILE_TREE_ENTRIES = 900;
const MAX_FILE_TREE_DEPTH = 8;
const LOCAL_DEPLOY_ROOT = "/var/www";
const SERVER_PROJECTS_ROOT = "/srv/codex-agent/projects";
const FILE_TREE_IGNORED_DIRS = new Set([
  ".git",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "coverage",
  "dist",
  "build",
  "node_modules",
  "target",
  "vendor"
]);
const LOCAL_DEPLOY_IGNORED_ENTRIES = new Set([".git", ".env", ".cache", "node_modules"]);

const IMAGE_MIME_TYPES = new Map([
  [".apng", "image/apng"],
  [".avif", "image/avif"],
  [".gif", "image/gif"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".bmp", "image/bmp"],
  [".ico", "image/x-icon"]
]);
const config = loadAgentConfig();
const redact = makeRedactor(config.redactPatterns);
const token = process.env[config.tokenEnv];
if (!token) throw new Error(`Missing agent token env var: ${config.tokenEnv}`);

let currentRunner: Runner | null = null;
let currentJobId: string | undefined;
let cachedCodexUsage: CodexUsage | undefined;
let cachedCodexUsageAt = 0;
let cachedGrokUsage: CodexUsage | undefined;
let cachedGrokUsageAt = 0;
let lastLocalActivitySyncKey = "";
let lastLocalActivityStatus: LocalCodexActivity["status"] = "idle";
let lastBusyLocalChatSyncOnly: LocalChatSyncOptions["only"];
let lastLocalChatSyncStartedAt = 0;
let localChatSyncPromise: Promise<number> | null = null;
let localChatSyncQueuedReason = "";

type LocalChatSyncOptions = {
  force?: boolean;
  only?: {
    repoId?: string;
    source?: "codex" | "vscode";
    externalId?: string;
  };
  minIntervalMs?: number;
  shouldContinue?: () => boolean;
};

type BuildCommand = {
  command: string;
  args: string[];
  timeoutMs?: number;
};

function shortId(value: string | undefined): string {
  return value ? value.slice(0, 8) : "n/a";
}

function incomingSummary(message: ServerToAgent): string {
  if (message.type === "job.run") {
    return [
      `job=${shortId(message.job.id)}`,
      `repo=${message.job.repoId}`,
      `kind=${message.job.kind}`,
      `sandbox=${message.job.sandbox}`,
      `prompt=${message.job.prompt.length} chars`,
      `attachments=${message.job.attachments?.length ?? 0}`
    ].join(" ");
  }
  if ("requestId" in message) {
    const repoId = "repoId" in message ? ` repo=${message.repoId}` : "";
    const command = message.type === "vscode.command" ? ` command=${message.command}` : "";
    return `request=${shortId(message.requestId)}${repoId}${command}`;
  }
  if (message.type === "job.cancel") return `job=${shortId(message.jobId)}`;
  return "request received";
}

function logProgress(message: string): void {
  console.log(`[progress] ${message}`);
}

async function ensureGitRepo(path: string): Promise<void> {
  mkdirSync(path, { recursive: true });
  const probe = await runCapture("git", ["-C", path, "rev-parse", "--is-inside-work-tree"], undefined, 15000);
  if (probe.exitCode !== 0 || probe.stdout.trim() !== "true") {
    const init = await runCapture("git", ["-C", path, "init"], undefined, 30000);
    if (init.exitCode !== 0) throw new Error(init.stderr || "git init failed");
  }
}

async function prepareProjectFolder(path: string, githubUrl?: string): Promise<void> {
  const remoteUrl = optionalText(githubUrl);
  if (!remoteUrl) {
    await ensureGitRepo(path);
    return;
  }
  const targetPath = resolve(path);
  if (existsSync(targetPath)) {
    const stat = statSync(targetPath);
    if (!stat.isDirectory()) throw new Error("Project path exists and is not a directory.");
    const gitProbe = await runCapture("git", ["-C", targetPath, "rev-parse", "--is-inside-work-tree"], undefined, 15000);
    if (gitProbe.exitCode === 0 && gitProbe.stdout.trim() === "true") return;
    if (readdirSync(targetPath).length > 0) {
      throw new Error("Project folder is not empty. Use an empty folder or an existing Git repository for clone.");
    }
  }
  mkdirSync(dirname(targetPath), { recursive: true });
  const clone = await runCapture("git", ["clone", remoteUrl, targetPath], undefined, 180000);
  if (clone.exitCode !== 0) throw new Error(clone.stderr || clone.stdout || "git clone failed");
}

function repoPathTarget(repoId: string, rawPath = ""): { repoPath: string; filePath: string; targetPath: string } {
  const repo = config.repos.find((item) => item.id === repoId);
  if (!repo) throw new Error("Project not found in agent config.");
  const filePath = rawPath.replace(/\\/g, "/").replace(/^\.\/+/, "").trim();
  if (
    filePath.includes("\0")
    || filePath.startsWith("/")
    || /^[a-z]:\//i.test(filePath)
    || (filePath ? filePath.split("/").some((part) => !part || part === "." || part === "..") : false)
    || filePath === ".git"
    || filePath.startsWith(".git/")
  ) {
    throw new Error("Unsafe file path.");
  }
  const repoPath = resolve(repo.path);
  const targetPath = filePath ? resolve(repoPath, ...filePath.split("/")) : repoPath;
  const compareRoot = repoPath.endsWith(sep) ? repoPath : `${repoPath}${sep}`;
  const compareTarget = targetPath.endsWith(sep) ? targetPath : `${targetPath}${sep}`;
  const normalizeCase = process.platform === "win32"
    ? (value: string) => value.toLowerCase()
    : (value: string) => value;
  if (!normalizeCase(compareTarget).startsWith(normalizeCase(compareRoot))) {
    throw new Error("Unsafe file path.");
  }
  return { repoPath, filePath, targetPath };
}

function repoFileTarget(repoId: string, rawPath: string): { repoPath: string; filePath: string; targetPath: string } {
  const target = repoPathTarget(repoId, rawPath);
  if (!target.filePath) throw new Error("Unsafe file path.");
  return target;
}

function imageMimeType(path: string): string | undefined {
  const lower = path.toLowerCase();
  for (const [extension, mimeType] of IMAGE_MIME_TYPES) {
    if (lower.endsWith(extension)) return mimeType;
  }
  return undefined;
}

function listProjectFiles(repoId: string, rawPath = "") {
  const target = repoPathTarget(repoId, rawPath);
  if (!existsSync(target.targetPath) || !statSync(target.targetPath).isDirectory()) throw new Error("Folder not found.");
  const entries: Array<{ path: string; name: string; type: "file" | "directory"; depth: number; size?: number; mtimeMs?: number }> = [];

  const walk = (dirPath: string, relativeDir: string, depth: number) => {
    if (entries.length >= MAX_FILE_TREE_ENTRIES || depth > MAX_FILE_TREE_DEPTH) return;
    let children;
    try {
      children = readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    children
      .filter((entry) => !entry.isSymbolicLink())
      .filter((entry) => !(entry.isDirectory() && FILE_TREE_IGNORED_DIRS.has(entry.name)))
      .sort((left, right) => {
        if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1;
        return left.name.localeCompare(right.name);
      })
      .forEach((entry) => {
        if (entries.length >= MAX_FILE_TREE_ENTRIES) return;
        const path = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
        const fullPath = join(dirPath, entry.name);
        let stat;
        try {
          stat = statSync(fullPath);
        } catch {
          return;
        }
        if (entry.isDirectory()) {
          entries.push({ path, name: entry.name, type: "directory", depth, mtimeMs: stat.mtimeMs });
          walk(fullPath, path, depth + 1);
          return;
        }
        if (entry.isFile()) {
          entries.push({ path, name: entry.name, type: "file", depth, size: stat.size, mtimeMs: stat.mtimeMs });
        }
      });
  };

  walk(target.targetPath, target.filePath, 0);
  return { entries };
}

function readProjectFile(repoId: string, rawPath: string) {
  const target = repoFileTarget(repoId, rawPath);
  if (!existsSync(target.targetPath) || !statSync(target.targetPath).isFile()) throw new Error("File not found.");
  const stat = statSync(target.targetPath);
  const mimeType = imageMimeType(target.filePath);
  if (mimeType && stat.size > MAX_IMAGE_PREVIEW_BYTES) throw new Error("Image is too large for preview.");
  if (!mimeType && stat.size > MAX_EDITOR_FILE_BYTES) throw new Error("File is too large for the web editor.");
  const bytes = readFileSync(target.targetPath);
  if (mimeType) {
    return {
      path: target.filePath,
      content: "",
      binary: true,
      mimeType,
      dataBase64: bytes.toString("base64"),
      size: bytes.length,
      mtimeMs: stat.mtimeMs
    };
  }
  if (bytes.includes(0)) throw new Error("Binary files cannot be opened in the web editor.");
  return {
    path: target.filePath,
    content: bytes.toString("utf8"),
    binary: false,
    size: bytes.length,
    mtimeMs: stat.mtimeMs
  };
}

function writeProjectFile(repoId: string, rawPath: string, content: string) {
  const target = repoFileTarget(repoId, rawPath);
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_EDITOR_FILE_BYTES) throw new Error("File is too large for the web editor.");
  if (existsSync(target.targetPath) && statSync(target.targetPath).isDirectory()) throw new Error("Path points to a directory.");
  mkdirSync(dirname(target.targetPath), { recursive: true });
  writeFileSync(target.targetPath, content, "utf8");
  const stat = statSync(target.targetPath);
  return {
    path: target.filePath,
    size: stat.size,
    mtimeMs: stat.mtimeMs
  };
}

function tarPathParts(path: string): { name: string; prefix: string } {
  const normalized = path.replace(/\\/g, "/").replace(/^\/+/, "");
  const bytes = Buffer.byteLength(normalized);
  if (bytes <= 100) return { name: normalized, prefix: "" };
  const parts = normalized.split("/");
  const name = parts.pop() ?? "";
  const prefix = parts.join("/");
  if (Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155) return { name, prefix };
  throw new Error("Archive path is too long.");
}

function writeTarOctal(header: Buffer, value: number, offset: number, length: number) {
  const text = Math.max(0, Math.floor(value)).toString(8).slice(-(length - 1)).padStart(length - 1, "0");
  header.write(text, offset, length - 1, "ascii");
  header[offset + length - 1] = 0;
}

function tarHeader(path: string, stat: { size: number; mtimeMs: number }, type: "file" | "directory") {
  const header = Buffer.alloc(512);
  const { name, prefix } = tarPathParts(path);
  header.write(name, 0, 100, "utf8");
  writeTarOctal(header, type === "directory" ? 0o755 : 0o644, 100, 8);
  writeTarOctal(header, 0, 108, 8);
  writeTarOctal(header, 0, 116, 8);
  writeTarOctal(header, type === "directory" ? 0 : stat.size, 124, 12);
  writeTarOctal(header, Math.floor(stat.mtimeMs / 1000), 136, 12);
  header.fill(0x20, 148, 156);
  header.write(type === "directory" ? "5" : "0", 156, 1, "ascii");
  header.write("ustar", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write("xedoc", 265, 32, "ascii");
  header.write("xedoc", 297, 32, "ascii");
  if (prefix) header.write(prefix, 345, 155, "utf8");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  const checksumText = checksum.toString(8).padStart(6, "0");
  header.write(checksumText, 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function createProjectDownload(repoId: string, rawPath: string) {
  const target = repoFileTarget(repoId, rawPath);
  if (!existsSync(target.targetPath)) throw new Error("File not found.");
  const rootStat = lstatSync(target.targetPath);
  if (rootStat.isSymbolicLink()) throw new Error("Symbolic links cannot be downloaded.");
  if (rootStat.isFile()) {
    if (rootStat.size > MAX_DOWNLOAD_BYTES) throw new Error("File is too large to download from the web IDE.");
    const bytes = readFileSync(target.targetPath);
    return {
      path: target.filePath,
      binary: true,
      mimeType: imageMimeType(target.filePath) || "application/octet-stream",
      dataBase64: bytes.toString("base64"),
      size: bytes.length,
      mtimeMs: rootStat.mtimeMs
    };
  }
  if (!rootStat.isDirectory()) throw new Error("File not found.");

  const chunks: Buffer[] = [];
  let totalSize = 0;
  const pushChunk = (chunk: Buffer) => {
    totalSize += chunk.length;
    if (totalSize > MAX_DOWNLOAD_BYTES) throw new Error("Folder archive is too large to download from the web IDE.");
    chunks.push(chunk);
  };
  const padFile = (size: number) => {
    const padding = (512 - (size % 512)) % 512;
    if (padding) pushChunk(Buffer.alloc(padding));
  };
  const archiveRoot = basename(target.filePath) || "project";
  const addEntry = (fullPath: string, archivePath: string) => {
    const stat = lstatSync(fullPath);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      pushChunk(tarHeader(`${archivePath}/`, { size: 0, mtimeMs: stat.mtimeMs }, "directory"));
      for (const child of readdirSync(fullPath, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
        if (child.isSymbolicLink()) continue;
        if (child.isDirectory() && FILE_TREE_IGNORED_DIRS.has(child.name)) continue;
        addEntry(join(fullPath, child.name), `${archivePath}/${child.name}`);
      }
      return;
    }
    if (!stat.isFile()) return;
    pushChunk(tarHeader(archivePath, { size: stat.size, mtimeMs: stat.mtimeMs }, "file"));
    const bytes = readFileSync(fullPath);
    pushChunk(bytes);
    padFile(bytes.length);
  };

  addEntry(target.targetPath, archiveRoot);
  pushChunk(Buffer.alloc(1024));
  const archive = Buffer.concat(chunks);
  return {
    path: `${target.filePath}.tar`,
    binary: true,
    mimeType: "application/x-tar",
    dataBase64: archive.toString("base64"),
    size: archive.length,
    mtimeMs: rootStat.mtimeMs
  };
}

async function sendProjectResult(
  send: (message: AgentToServer) => void,
  requestId: string,
  ok: boolean,
  error?: string
) {
  send({
    type: "project.result",
    requestId,
    ok,
    error,
    repos: ok ? await scanRepos(config) : undefined
  });
}

async function sendGitResult(
  send: (message: AgentToServer) => void,
  requestId: string,
  ok: boolean,
  output: string,
  error?: string
) {
  send({
    type: "git.result",
    requestId,
    ok,
    output: redact(output),
    error: error ? redact(error) : undefined,
    status: ok ? await gitStatusLineFromOutput(output) : undefined,
    repos: ok ? await scanRepos(config) : undefined
  });
}

async function sendDeployResult(
  send: (message: AgentToServer) => void,
  requestId: string,
  ok: boolean,
  output: string,
  error?: string
) {
  send({
    type: "deploy.result",
    requestId,
    ok,
    output: redact(output),
    error: error ? redact(error) : undefined,
    repos: await scanRepos(config)
  });
}

async function sendNginxResult(
  send: (message: AgentToServer) => void,
  requestId: string,
  ok: boolean,
  output: string,
  error?: string
) {
  send({
    type: "nginx.result",
    requestId,
    ok,
    output: redact(output),
    error: error ? redact(error) : undefined,
    repos: ok ? await scanRepos(config) : undefined
  });
}

async function sendSslResult(
  send: (message: AgentToServer) => void,
  requestId: string,
  ok: boolean,
  output: string,
  error?: string
) {
  send({
    type: "ssl.result",
    requestId,
    ok,
    output: redact(output),
    error: error ? redact(error) : undefined,
    repos: ok ? await scanRepos(config) : undefined
  });
}

async function gitStatusLineFromOutput(output: string): Promise<string> {
  const lastLine = output.trim().split(/\r?\n/).filter(Boolean).at(-1);
  return lastLine ?? "Git sync completed.";
}

function githubRepoSlugFromRemote(value: string): string | undefined {
  const normalized = value.trim().replace(/\.git$/i, "");
  const shorthand = normalized.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (shorthand) return `${shorthand[1]}/${shorthand[2]}`;
  const https = normalized.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:[/?#].*)?$/i);
  if (https) return `${https[1]}/${https[2]}`;
  const ssh = normalized.match(/^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/i);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  return undefined;
}

function shouldRewriteGithubRemoteToSsh(value: string): boolean {
  const trimmed = value.trim();
  return /^https:\/\/github\.com\//i.test(trimmed) || /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/i.test(trimmed);
}

function githubSshRemoteFromSlug(repoSlug: string, sshHost: string): string {
  const trimmedHost = sshHost.trim();
  const host = trimmedHost === "github.com" ? "git@github.com" : trimmedHost;
  return `${host}:${repoSlug}.git`;
}

function gitRemoteUrlForAgent(remoteUrl: string, output: string[]): string {
  const githubSshHost = process.env.CMC_GITHUB_SSH_HOST?.trim();
  if (!githubSshHost || !shouldRewriteGithubRemoteToSsh(remoteUrl)) return remoteUrl;

  const repoSlug = githubRepoSlugFromRemote(remoteUrl);
  if (!repoSlug) return remoteUrl;

  const sshRemote = githubSshRemoteFromSlug(repoSlug, githubSshHost);
  output.push(`Using GitHub SSH remote via ${githubSshHost}: ${sshRemote}`);
  return sshRemote;
}

function gitFailureHelp(text: string): string {
  if (/could not read Username for 'https:\/\/github\.com'/i.test(text)) {
    return [
      "GitHub HTTPS auth is unavailable in this non-interactive agent process.",
      "Use a GitHub token/credential helper or configure CMC_GITHUB_SSH_HOST with a writable SSH key."
    ].join("\n");
  }
  if (/marked as read only/i.test(text)) {
    return [
      "The GitHub SSH key was accepted, but it is read-only.",
      "Add a writable deploy key for this repository or use an account SSH key with write access."
    ].join("\n");
  }
  if (/Permission denied \(publickey\)/i.test(text)) {
    return [
      "GitHub rejected the SSH key.",
      "Check the SSH host configured in CMC_GITHUB_SSH_HOST and make sure its public key has write access."
    ].join("\n");
  }
  return "";
}

async function ensureGitHubRepository(
  remoteUrl: string,
  visibility: "private" | "public",
  output: string[],
  cwd: string,
  probeRemoteUrl = remoteUrl
): Promise<void> {
  const repoSlug = githubRepoSlugFromRemote(remoteUrl);
  if (!repoSlug) throw new Error("GitHub repository URL must be github.com/owner/repo or owner/repo.");
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (token) {
    await ensureGitHubRepositoryWithApi(repoSlug, visibility, output, token);
    return;
  }

  if (/^(https:\/\/|git@|[A-Za-z0-9_.-]+:)/i.test(probeRemoteUrl)) {
    const remoteCheck = await runCapture("git", ["ls-remote", probeRemoteUrl], cwd, 30000);
    output.push(`$ git ls-remote ${probeRemoteUrl}`);
    const remoteText = [remoteCheck.stdout.trim(), remoteCheck.stderr.trim()].filter(Boolean).join("\n");
    if (remoteText) output.push(remoteText);
    if (remoteCheck.exitCode === 0) {
      output.push(`GitHub remote is reachable: ${repoSlug}`);
      return;
    }
  }

  const view = await runCapture("gh", ["repo", "view", repoSlug], cwd, 30000);
  output.push(`$ gh repo view ${repoSlug}`);
  const viewText = [view.stdout.trim(), view.stderr.trim()].filter(Boolean).join("\n");
  if (viewText) output.push(viewText);
  if (view.exitCode === 0) {
    output.push(`GitHub repository already exists: ${repoSlug}`);
    return;
  }

  const createArgs = ["repo", "create", repoSlug, visibility === "public" ? "--public" : "--private"];
  const create = await runCapture("gh", createArgs, cwd, 60000);
  output.push(`$ gh ${createArgs.join(" ")}`);
  const createText = [create.stdout.trim(), create.stderr.trim()].filter(Boolean).join("\n");
  if (createText) output.push(createText);
  if (create.exitCode !== 0) {
    throw new Error(createText || `gh repo create failed with exit code ${create.exitCode}`);
  }
}

async function githubApi(
  path: string,
  token: string,
  init: RequestInit = {}
): Promise<{ status: number; ok: boolean; data: unknown; text: string }> {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      "accept": "application/vnd.github+json",
      "authorization": `Bearer ${token}`,
      "user-agent": "xedoc.ru-agent",
      "x-github-api-version": "2022-11-28",
      ...(init.headers ?? {})
    }
  });
  const text = await response.text();
  let data: unknown = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  return { status: response.status, ok: response.ok, data, text };
}

function githubApiError(result: { status: number; data: unknown; text: string }): string {
  if (result.data && typeof result.data === "object" && "message" in result.data && typeof result.data.message === "string") {
    return result.data.message;
  }
  return result.text || `GitHub API returned HTTP ${result.status}`;
}

function githubField(data: unknown, key: string): string | undefined {
  return data && typeof data === "object" && key in data && typeof data[key as keyof typeof data] === "string"
    ? data[key as keyof typeof data] as string
    : undefined;
}

async function ensureGitHubRepositoryWithApi(
  repoSlug: string,
  visibility: "private" | "public",
  output: string[],
  token: string
): Promise<void> {
  output.push(`$ GitHub API GET /repos/${repoSlug}`);
  const existing = await githubApi(`/repos/${repoSlug}`, token);
  if (existing.ok) {
    output.push(`GitHub repository already exists: ${repoSlug}`);
    return;
  }
  if (existing.status !== 404) {
    throw new Error(`GitHub repository check failed: ${githubApiError(existing)}`);
  }

  const [owner, repoName] = repoSlug.split("/");
  if (!owner || !repoName) throw new Error("GitHub repository URL must include owner and repo name.");

  const user = await githubApi("/user", token);
  if (!user.ok) throw new Error(`GitHub auth failed: ${githubApiError(user)}`);
  const login = githubField(user.data, "login");
  const createPath = login?.toLowerCase() === owner.toLowerCase() ? "/user/repos" : `/orgs/${owner}/repos`;
  output.push(`$ GitHub API POST ${createPath}`);
  const created = await githubApi(createPath, token, {
    method: "POST",
    body: JSON.stringify({
      name: repoName,
      private: visibility === "private",
      auto_init: false
    })
  });
  if (!created.ok) {
    throw new Error(`GitHub repository create failed: ${githubApiError(created)}`);
  }
  const fullName = githubField(created.data, "full_name");
  if (fullName?.toLowerCase() !== repoSlug.toLowerCase()) {
    throw new Error(`GitHub created ${fullName || "an unexpected repository"}, expected ${repoSlug}.`);
  }
  output.push(`GitHub repository created: ${repoSlug}`);
}

async function gitSync(
  repoId: string,
  message: string,
  remoteUrl?: string,
  createRemote = false,
  remoteVisibility: "private" | "public" = "private"
): Promise<string> {
  const repo = config.repos.find((item) => item.id === repoId);
  if (!repo) throw new Error("Project not found in agent config.");
  await ensureGitRepo(repo.path);

  const output: string[] = [];
  const runGit = async (args: string[], timeoutMs = 60000, allowExitCodes = [0]) => {
    const result = await runCapture("git", ["-C", repo.path, ...args], undefined, timeoutMs);
    const text = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
    output.push(`$ git ${args.join(" ")}`);
    if (text) output.push(text);
    if (!allowExitCodes.includes(result.exitCode ?? -1)) {
      const help = gitFailureHelp(text);
      throw new Error([text || `git ${args.join(" ")} failed with exit code ${result.exitCode}`, help].filter(Boolean).join("\n"));
    }
    return result;
  };
  const resolvedRemoteUrl = remoteUrl ? gitRemoteUrlForAgent(remoteUrl, output) : undefined;

  if (createRemote && remoteUrl) {
    await ensureGitHubRepository(remoteUrl, remoteVisibility, output, repo.path, resolvedRemoteUrl);
  }

  if (resolvedRemoteUrl) {
    const currentRemote = await runGit(["remote", "get-url", "origin"], 15000, [0, 2, 128]);
    if (currentRemote.exitCode === 0) await runGit(["remote", "set-url", "origin", resolvedRemoteUrl], 15000);
    else await runGit(["remote", "add", "origin", resolvedRemoteUrl], 15000);
  } else {
    await runGit(["remote", "get-url", "origin"], 15000);
  }

  await runGit(["add", "-A"], 60000);
  const staged = await runGit(["diff", "--cached", "--quiet"], 30000, [0, 1]);
  if (staged.exitCode === 1) {
    await runGit(["commit", "-m", message], 120000);
  } else {
    output.push("No staged changes to commit.");
  }

  const head = await runGit(["rev-parse", "--verify", "HEAD"], 15000, [0, 128]);
  if (head.exitCode !== 0) {
    const entries = projectFolderEntries(repo.path);
    const folderState = entries.length
      ? "The configured project folder has no committed files."
      : "The configured project folder is empty except for Git metadata.";
    throw new Error(`${folderState} Launch is using ${repo.path}. Check Project settings or create the app in this folder before GitHub sync.`);
  }

  const upstream = await runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], 15000, [0, 128]);
  let branch = (await runGit(["branch", "--show-current"], 15000)).stdout.trim();
  if (!branch) branch = "main";
  if (upstream.exitCode !== 0 && branch === "master") {
    await runGit(["branch", "-M", "main"], 30000);
    branch = "main";
  }
  await runGit(["push", "-u", "origin", branch], 120000);
  const status = await runGit(["status", "--short", "--branch"], 15000);
  return [...output, status.stdout.trim() || "Git sync completed."].filter(Boolean).join("\n");
}

function projectFolderEntries(repoPath: string): string[] {
  try {
    return readdirSync(repoPath).filter((name) => name !== ".git");
  } catch {
    return [];
  }
}

function packageCommandNeedsPackageJson(command: string): boolean {
  return new Set(["npm", "npm.cmd", "pnpm", "pnpm.cmd", "yarn", "yarn.cmd", "bun", "bun.cmd"])
    .has(basename(command).toLowerCase());
}

function ensurePackageJsonForBuild(repoPath: string, build: BuildCommand): void {
  if (!packageCommandNeedsPackageJson(build.command)) return;
  if (existsSync(join(repoPath, "package.json"))) return;
  throw new Error(`Configured project folder has no package.json: ${repoPath}. Point Project settings to the app folder or create the app in this folder before Build/Deploy.`);
}

function inferBuildCommand(repoPath: string): BuildCommand | undefined {
  const packageJsonPath = join(repoPath, "package.json");
  if (!existsSync(packageJsonPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { scripts?: Record<string, unknown> };
    if (typeof parsed.scripts?.build !== "string") return undefined;
    return {
      command: process.platform === "win32" ? "npm.cmd" : "npm",
      args: ["run", "build"],
      timeoutMs: 120000
    };
  } catch {
    return undefined;
  }
}

async function buildProject(repoId: string): Promise<string> {
  const repo = config.repos.find((item) => item.id === repoId);
  if (!repo) throw new Error("Project not found in agent config.");
  const build = repo.deploy?.buildCommand ?? inferBuildCommand(repo.path);
  if (!build) throw new Error("Project build command is not configured and package.json has no build script.");
  ensurePackageJsonForBuild(repo.path, build);
  const label = [build.command, ...build.args].join(" ");
  const result = await runCapture(build.command, build.args, repo.path, build.timeoutMs ?? 120000);
  const output = [`$ ${label}`];
  const text = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
  if (text) output.push(text);
  if (result.exitCode !== 0) throw new Error([...output, `${label} failed with exit code ${result.exitCode}`].join("\n"));
  return [...output, "Build completed."].join("\n");
}

async function gitStatusProject(repoId: string): Promise<string> {
  const repo = config.repos.find((item) => item.id === repoId);
  if (!repo) throw new Error("Project not found in agent config.");
  const status = await runCapture("git", ["status", "--short", "--branch"], repo.path, 15000);
  const staged = await runCapture("git", ["diff", "--cached", "--stat"], repo.path, 15000);
  const unstaged = await runCapture("git", ["diff", "--stat"], repo.path, 15000);
  const sections = [
    "$ git status --short --branch",
    status.stdout.trim() || status.stderr.trim() || "No status output.",
    staged.stdout.trim() ? ["", "$ git diff --cached --stat", staged.stdout.trim()].join("\n") : "",
    unstaged.stdout.trim() ? ["", "$ git diff --stat", unstaged.stdout.trim()].join("\n") : ""
  ].filter(Boolean);
  return sections.join("\n");
}

async function deployProject(repoId: string): Promise<string> {
  const repo = config.repos.find((item) => item.id === repoId);
  if (!repo) throw new Error("Project not found in agent config.");
  if (!repo.serverPath) throw new Error("Project server folder is not configured.");
  if (!repo.deploy) throw new Error("Project deploy settings are not configured.");
  ensureLocalDeployPathIsSafe(repo.serverPath);

  const output: string[] = [];
  const runStep = async (label: string, command: string, args: string[], cwd = repo.path, timeoutMs = 120000) => {
    output.push(`$ ${label}`);
    const result = await runCapture(command, args, cwd, timeoutMs);
    const text = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
    if (text) output.push(text);
    if (result.exitCode !== 0) throw new Error([...output, `${label} failed with exit code ${result.exitCode}`].join("\n"));
    return result;
  };

  const build = repo.deploy.buildCommand;
  if (build) {
    ensurePackageJsonForBuild(repo.path, build);
    await runStep([build.command, ...build.args].join(" "), build.command, build.args, repo.path, build.timeoutMs);
  }

  const sourceDir = resolveProjectPath(repo.path, repo.deploy.sourceDir);
  const remotePath = repo.serverPath.replace(/\/+$/g, "");
  const remoteSubdir = normalizeRemoteSubdir(repo.deploy.remoteSubdir);
  const deployPath = remoteSubdir ? `${remotePath}/${remoteSubdir}` : remotePath;
  if ((repo.deploy.mode ?? "ssh") === "local") {
    await deployProjectLocal(sourceDir, deployPath, repo.deploy.cleanRemote, output);
    return [...output, `Deploy completed: ${repo.domain ? `https://${repo.domain}` : deployPath}`].join("\n");
  }
  if (!repo.deploy.sshTarget) throw new Error("Project deploy SSH target is not configured.");
  const sourceForScp = `${sourceDir.replace(/\\/g, "/")}/.`;
  const quotedDeployPath = shellQuote(deployPath);
  const protectControllerRoot = [
    `if [ -e ${quotedDeployPath}/data/cmc.db ] || [ -e ${quotedDeployPath}/apps/server/dist/index.js ]; then`,
    `echo ${shellQuote(`Refusing to deploy into protected controller directory: ${deployPath}`)};`,
    "exit 12;",
    "fi"
  ].join(" ");
  const protectedCleanMarkers = [
    ".git",
    ".env",
    "data",
    "apps/server",
    "package.json",
    "pnpm-lock.yaml",
    "package-lock.json",
    "yarn.lock"
  ];
  const protectedCleanChecks = protectedCleanMarkers
    .map((marker) => `[ -e ${shellQuote(`${deployPath}/${marker}`)} ]`)
    .join(" || ");
  const protectCleanRemote = repo.deploy.cleanRemote ? [
    `if ${protectedCleanChecks}; then`,
    `echo ${shellQuote(`Refusing to clean protected deploy directory: ${deployPath}. Disable cleanRemote or deploy into a dedicated build output subfolder.`)};`,
    "exit 13;",
    "fi"
  ].join(" ") : "";
  const cleanCommand = [
    `mkdir -p ${quotedDeployPath}`,
    protectControllerRoot,
    protectCleanRemote,
    repo.deploy.cleanRemote ? `find ${quotedDeployPath} -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +` : ""
  ].filter(Boolean).join(" && ");

  await runStep(`ssh ${repo.deploy.sshTarget} prepare ${deployPath}`, "ssh", [repo.deploy.sshTarget, cleanCommand], repo.path, 60000);
  await runStep(`scp ${sourceForScp} ${repo.deploy.sshTarget}:${deployPath}/`, "scp", ["-r", sourceForScp, `${repo.deploy.sshTarget}:${deployPath}/`], repo.path, 180000);
  await runStep(`ssh ${repo.deploy.sshTarget} permissions ${deployPath}`, "ssh", [repo.deploy.sshTarget, `chown -R www-data:www-data ${quotedDeployPath} 2>/dev/null || true`], repo.path, 60000);
  return [...output, `Deploy completed: ${repo.domain ? `https://${repo.domain}` : deployPath}`].join("\n");
}

async function deployProjectLocal(sourceDir: string, deployPath: string, cleanRemote: boolean, output: string[]): Promise<void> {
  output.push(`$ local prepare ${deployPath}`);
  ensureLocalDeployPathIsSafe(deployPath);
  if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
    throw new Error([...output, `Build output folder does not exist: ${sourceDir}`].join("\n"));
  }
  const sameDirectory = resolve(sourceDir) === resolve(deployPath);
  if (sameDirectory) {
    output.push(`$ local publish ${deployPath}`);
    output.push("Project folder is already the web root; copy step skipped.");
    if (cleanRemote) output.push("Clean skipped because deploy target is the project folder.");
    return;
  }
  mkdirSync(deployPath, { recursive: true });
  if (isProtectedDeployDirectory(deployPath)) {
    throw new Error([...output, `Refusing to deploy into protected controller directory: ${deployPath}`].join("\n"));
  }
  output.push(`$ local copy ${sourceDir} -> ${deployPath}`);
  if (cleanRemote) {
    if (isProtectedCleanDirectory(deployPath)) {
      throw new Error([...output, `Refusing to clean protected deploy directory: ${deployPath}. Disable cleanRemote or deploy into a dedicated build output folder.`].join("\n"));
    }
    for (const name of readdirSync(deployPath)) {
      rmSync(join(deployPath, name), { recursive: true, force: true });
    }
  }
  for (const name of readdirSync(sourceDir)) {
    if (LOCAL_DEPLOY_IGNORED_ENTRIES.has(name)) {
      output.push(`Skipped deploy-only entry: ${name}`);
      continue;
    }
    cpSync(join(sourceDir, name), join(deployPath, name), { recursive: true, force: true });
  }
  if (process.platform !== "win32") {
    output.push(`$ chown -R www-data:www-data ${deployPath}`);
    const chown = await runCapture("chown", ["-R", "www-data:www-data", deployPath], undefined, 60000);
    const text = [chown.stdout.trim(), chown.stderr.trim()].filter(Boolean).join("\n");
    if (text) output.push(text);
    if (chown.exitCode !== 0) output.push(`chown skipped with exit code ${chown.exitCode}.`);
  }
}

async function configureNginx(repoId: string): Promise<string> {
  const repo = config.repos.find((item) => item.id === repoId);
  if (!repo) throw new Error("Project not found in agent config.");
  if (!repo.serverPath) throw new Error("Project server folder is not configured.");
  if (!repo.domain) throw new Error("Project domain is not configured.");
  if (!repo.deploy) throw new Error("Project deploy settings are not configured.");
  if ((repo.deploy.mode ?? "ssh") === "ssh" && !repo.deploy.sshTarget) throw new Error("Project deploy SSH target is not configured.");
  if (!isSafeDomain(repo.domain)) throw new Error("Project domain is not safe for nginx config.");
  ensureLocalDeployPathIsSafe(repo.serverPath);

  const remotePath = repo.serverPath.replace(/\/+$/g, "");
  const remoteSubdir = normalizeRemoteSubdir(repo.deploy.remoteSubdir);
  const webRootPath = remoteSubdir ? `${remotePath}/${remoteSubdir}` : remotePath;
  const availablePath = `/etc/nginx/sites-available/${repo.domain}`;
  const enabledPath = `/etc/nginx/sites-enabled/${repo.domain}`;
  const certificatePath = `/etc/letsencrypt/live/${repo.domain}/fullchain.pem`;
  const certificateKeyPath = `/etc/letsencrypt/live/${repo.domain}/privkey.pem`;
  const staticLocations = [
    "    location / {",
    "        try_files $uri $uri/ /index.html;",
    "    }",
    "",
    "    location ~* \\.(?:css|js|mjs|json|svg|png|jpg|jpeg|gif|webp|ico|woff2?)$ {",
    "        expires 7d;",
    "        access_log off;",
    "        try_files $uri =404;",
    "    }",
    "",
    "    location ~ /\\.(?!well-known(?:/|$)) {",
    "        deny all;",
    "        return 404;",
    "    }"
  ];
  const httpConfig = [
    "# Generated by xedoc.ru",
    "server {",
    "    listen 80;",
    "    listen [::]:80;",
    `    server_name ${repo.domain};`,
    "    client_max_body_size 25m;",
    `    root ${webRootPath};`,
    "    index index.html;",
    "",
    ...staticLocations,
    "}",
    ""
  ].join("\n");
  const sslConfig = [
    "# Generated by xedoc.ru",
    "server {",
    "    listen 80;",
    "    listen [::]:80;",
    `    server_name ${repo.domain};`,
    "    client_max_body_size 25m;",
    "    return 301 https://$host$request_uri;",
    "}",
    "",
    "server {",
    "    listen 443 ssl;",
    "    listen [::]:443 ssl;",
    `    server_name ${repo.domain};`,
    "    client_max_body_size 25m;",
    `    root ${webRootPath};`,
    "    index index.html;",
    `    ssl_certificate ${certificatePath};`,
    `    ssl_certificate_key ${certificateKeyPath};`,
    "    include /etc/letsencrypt/options-ssl-nginx.conf;",
    "    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;",
    "",
    ...staticLocations,
    "}",
    ""
  ].join("\n");
  const encodedHttpConfig = Buffer.from(httpConfig, "utf8").toString("base64");
  const encodedSslConfig = Buffer.from(sslConfig, "utf8").toString("base64");
  const preserveExistingProxyConfig = `[ -f ${shellQuote(availablePath)} ] && grep -q 'proxy_pass http://127\\.0\\.0\\.1:' ${shellQuote(availablePath)}`;
  const installConfigCommand = [
    `if ${preserveExistingProxyConfig}; then`,
    `sudo ln -sfn ${shellQuote(availablePath)} ${shellQuote(enabledPath)};`,
    "else",
    `sudo mkdir -p ${shellQuote(webRootPath)} &&`,
    `if [ -f ${shellQuote(certificatePath)} ] && [ -f ${shellQuote(certificateKeyPath)} ]; then printf %s ${shellQuote(encodedSslConfig)} | base64 -d | sudo tee ${shellQuote(availablePath)} >/dev/null; else printf %s ${shellQuote(encodedHttpConfig)} | base64 -d | sudo tee ${shellQuote(availablePath)} >/dev/null; fi &&`,
    `sudo ln -sfn ${shellQuote(availablePath)} ${shellQuote(enabledPath)};`,
    "fi"
  ].join(" ");
  const remoteCommand = [
    installConfigCommand,
    "sudo nginx -t",
    "sudo systemctl reload nginx"
  ].join(" && ");
  const localMode = (repo.deploy.mode ?? "ssh") === "local";
  const result = localMode
    ? await runCapture("bash", ["-lc", remoteCommand], repo.path, 120000)
    : await runCapture("ssh", [repo.deploy.sshTarget!, remoteCommand], repo.path, 120000);
  const output = [localMode ? `$ local configure nginx ${repo.domain}` : `$ ssh ${repo.deploy.sshTarget} configure nginx ${repo.domain}`];
  const text = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
  if (text) output.push(text);
  if (result.exitCode !== 0) throw new Error([...output, `Nginx configure failed with exit code ${result.exitCode}`].join("\n"));
  return [...output, `Nginx configured: ${repo.domain}`].join("\n");
}

async function configureSsl(repoId: string): Promise<string> {
  const repo = config.repos.find((item) => item.id === repoId);
  if (!repo) throw new Error("Project not found in agent config.");
  if (!repo.domain) throw new Error("Project domain is not configured.");
  if (!repo.deploy) throw new Error("Project deploy settings are not configured.");
  if ((repo.deploy.mode ?? "ssh") === "ssh" && !repo.deploy.sshTarget) throw new Error("Project deploy SSH target is not configured.");
  if (!isSafeDomain(repo.domain)) throw new Error("Project domain is not safe for certbot config.");

  const output: string[] = [];
  output.push(await configureNginx(repoId));
  const certificatePath = `/etc/letsencrypt/live/${repo.domain}/fullchain.pem`;
  const certificateKeyPath = `/etc/letsencrypt/live/${repo.domain}/privkey.pem`;
  const certbotCommand = [
    "sudo certbot --nginx",
    `-d ${shellQuote(repo.domain)}`,
    `--cert-name ${shellQuote(repo.domain)}`,
    "--non-interactive",
    "--agree-tos",
    "--redirect",
    "--keep-until-expiring",
    "--register-unsafely-without-email",
    "&& sudo nginx -t",
    "&& sudo systemctl reload nginx"
  ].join(" ");
  const localMode = (repo.deploy.mode ?? "ssh") === "local";
  const result = localMode
    ? await runCapture("bash", ["-lc", certbotCommand], repo.path, 300000)
    : await runCapture("ssh", [repo.deploy.sshTarget!, certbotCommand], repo.path, 300000);
  output.push(localMode ? `$ local certbot ${repo.domain}` : `$ ssh ${repo.deploy.sshTarget} certbot ${repo.domain}`);
  const text = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
  if (text) output.push(text);
  if (result.exitCode !== 0) throw new Error([...output, `SSL configure failed with exit code ${result.exitCode}`].join("\n"));

  output.push(await configureNginx(repoId));

  const httpsResolve = `${repo.domain}:443:127.0.0.1`;
  const httpResolve = `${repo.domain}:80:127.0.0.1`;
  const httpsUrl = `https://${repo.domain}/`;
  const httpUrl = `http://${repo.domain}/`;
  const verifyCommand = [
    `sudo test -f ${shellQuote(certificatePath)}`,
    `sudo test -f ${shellQuote(certificateKeyPath)}`,
    `sudo openssl x509 -checkend 604800 -noout -in ${shellQuote(certificatePath)}`,
    "sudo nginx -t",
    "sudo systemctl reload nginx",
    `https_status=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 15 --noproxy '*' --resolve ${shellQuote(httpsResolve)} ${shellQuote(httpsUrl)})`,
    `case "$https_status" in 000|"") echo "HTTPS check failed for ${repo.domain}"; exit 1;; esac`,
    `http_location=$(curl --silent --show-error --output /dev/null --write-out '%{redirect_url}' --max-time 15 --noproxy '*' --resolve ${shellQuote(httpResolve)} ${shellQuote(httpUrl)})`,
    `test "$http_location" = ${shellQuote(httpsUrl)}`,
    `printf 'Verified certificate, HTTPS status %s, HTTP redirect %s\\n' "$https_status" "$http_location"`
  ].join(" && ");
  const verify = localMode
    ? await runCapture("bash", ["-lc", verifyCommand], repo.path, 120000)
    : await runCapture("ssh", [repo.deploy.sshTarget!, verifyCommand], repo.path, 120000);
  output.push(localMode ? `$ local verify ssl ${repo.domain}` : `$ ssh ${repo.deploy.sshTarget} verify ssl ${repo.domain}`);
  const verifyText = [verify.stdout.trim(), verify.stderr.trim()].filter(Boolean).join("\n");
  if (verifyText) output.push(verifyText);
  if (verify.exitCode !== 0) throw new Error([...output, `SSL verification failed with exit code ${verify.exitCode}`].join("\n"));
  return [...output, `SSL configured and verified: ${httpsUrl}`].join("\n");
}

function isSafeDomain(value: string): boolean {
  return /^(?=.{1,253}$)(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z0-9-]{2,63}$/i.test(value);
}

function resolveProjectPath(projectPath: string, childPath: string): string {
  if (/^[a-z]:[\\/]/i.test(childPath) || childPath.startsWith("\\\\") || isAbsolute(childPath)) return childPath;
  return resolve(projectPath, childPath);
}

function ensureLocalDeployPathIsSafe(path: string): void {
  const normalized = normalizeDeployPath(path);
  if (normalized.split("/").some((part) => part === "..")) throw new Error("Deploy path is not safe.");
  const allowed =
    isPathBelowRoot(normalized, LOCAL_DEPLOY_ROOT, 1)
    || isPathBelowRoot(normalized, SERVER_PROJECTS_ROOT, 2);
  if (!allowed) {
    throw new Error(`Refusing to deploy outside ${LOCAL_DEPLOY_ROOT} or ${SERVER_PROJECTS_ROOT}/{user}/{project}.`);
  }
}

function normalizeDeployPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/g, "");
}

function isPathBelowRoot(path: string, root: string, minSegments: number): boolean {
  if (!path.startsWith(`${root}/`)) return false;
  const segments = path.slice(root.length + 1).split("/").filter(Boolean);
  return segments.length >= minSegments && segments.every((segment) => segment !== "." && segment !== "..");
}

function isProtectedDeployDirectory(path: string): boolean {
  return existsSync(join(path, "data", "cmc.db")) || existsSync(join(path, "apps", "server", "dist", "index.js"));
}

function isProtectedCleanDirectory(path: string): boolean {
  return [".git", ".env", "data", "apps/server", "package.json", "pnpm-lock.yaml", "package-lock.json", "yarn.lock"]
    .some((marker) => existsSync(join(path, ...marker.split("/"))));
}

function normalizeRemoteSubdir(value?: string): string | undefined {
  const normalized = value?.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!normalized) return undefined;
  if (normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Deploy remote subdir is not safe.");
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(normalized)) throw new Error("Deploy remote subdir is not safe.");
  return normalized;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function toolVersion(command: string, args = ["--version"]): Promise<string | undefined> {
  const executable = command === "codex" ? codexExecutable() : { command, args: [] };
  const grokCommand = command === "grok" ? grokExecutable(args) : undefined;
  const result = grokCommand
    ? await runCapture(grokCommand.command, grokCommand.args, undefined, 15000)
    : await runCapture(executable.command, [...executable.args, ...args], undefined, 15000);
  if (result.exitCode !== 0) return undefined;
  return (result.stdout || result.stderr).trim().split(/\r?\n/)[0];
}

function curlExecutable(): string {
  return process.platform === "win32" ? "curl.exe" : "curl";
}

function curlConfigQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\r?\n/g, " ")}"`;
}

function truncateText(value: string, maxLength = 300): string {
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function compactSummary(parts: Array<string | undefined>, maxLength = 300): string {
  return truncateText(parts.filter(Boolean).join(" "), maxLength);
}

function shortError(error: unknown): string {
  return truncateText(error instanceof Error ? error.message : String(error), 140);
}

async function apiGetJson(url: string, bearerToken: string, timeoutMs = 20000): Promise<unknown> {
  const curlConfig = [
    `url = ${curlConfigQuote(url)}`,
    `header = ${curlConfigQuote(`Authorization: Bearer ${bearerToken}`)}`,
    `header = ${curlConfigQuote("Content-Type: application/json")}`,
    "silent",
    "show-error",
    "location",
    "fail"
  ].join("\n");
  const result = await runCapture(curlExecutable(), ["--config", "-"], undefined, timeoutMs, `${curlConfig}\n`);
  if (result.exitCode !== 0) {
    throw new Error((result.stderr || result.stdout).trim() || `curl exited with ${result.exitCode}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error("Invalid JSON API response.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function monthStartUnixSeconds(date = new Date()): number {
  return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / 1000);
}

function sumOpenAiCosts(payload: unknown): number {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return 0;
  let total = 0;
  for (const bucket of payload.data) {
    if (!isRecord(bucket) || !Array.isArray(bucket.results)) continue;
    for (const result of bucket.results) {
      if (!isRecord(result) || !isRecord(result.amount)) continue;
      const value = result.amount.value;
      if (typeof value === "number" && Number.isFinite(value)) total += value;
    }
  }
  return total;
}

function formatUsd(value: number): string {
  const digits = value > 0 && value < 1 ? 4 : 2;
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

function formatCompactNumber(value: number): string {
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`;
  if (value >= 1_000) return `${Number((value / 1_000).toFixed(1))}K`;
  return String(value);
}

function summarizeOpenAiRateLimits(payload: unknown): string | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.data) || payload.data.length === 0) return undefined;
  const limits = payload.data.filter(isRecord);
  const preferredModel = optionalText(process.env.OPENAI_RATE_LIMIT_MODEL)?.toLowerCase();
  const selected = (preferredModel
    ? limits.find((item) => String(item.model ?? "").toLowerCase() === preferredModel)
    : limits.find((item) => String(item.model ?? "").toLowerCase().includes("gpt-5"))) ?? limits[0];
  if (!selected) return undefined;
  const model = String(selected.model ?? "model");
  const rpm = typeof selected.max_requests_per_1_minute === "number" ? `${formatCompactNumber(selected.max_requests_per_1_minute)} RPM` : undefined;
  const tpm = typeof selected.max_tokens_per_1_minute === "number" ? `${formatCompactNumber(selected.max_tokens_per_1_minute)} TPM` : undefined;
  return `project limits ${limits.length} models; ${[model, rpm, tpm].filter(Boolean).join(" ")}`;
}

async function probeOpenAiApiSummary(): Promise<string | undefined> {
  const adminKey = optionalText(process.env.OPENAI_ADMIN_KEY);
  if (!adminKey) return undefined;

  try {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const costParams = new URLSearchParams({
      start_time: String(monthStartUnixSeconds()),
      end_time: String(nowSeconds),
      bucket_width: "1d",
      limit: "31"
    });
    const costs = await apiGetJson(`https://api.openai.com/v1/organization/costs?${costParams.toString()}`, adminKey);
    const parts = [`OpenAI API month spend ${formatUsd(sumOpenAiCosts(costs))}.`];
    const projectId = optionalText(process.env.OPENAI_PROJECT_ID);
    if (projectId) {
      try {
        const limits = await apiGetJson(`https://api.openai.com/v1/organization/projects/${encodeURIComponent(projectId)}/rate_limits?limit=100`, adminKey);
        parts.push(summarizeOpenAiRateLimits(limits) ?? "project limits empty");
      } catch (error) {
        parts.push(`project limits failed: ${shortError(error)}`);
      }
    } else {
      parts.push("Set OPENAI_PROJECT_ID for model RPM/TPM.");
    }
    return compactSummary(parts);
  } catch (error) {
    return `OpenAI API probe failed: ${shortError(error)}`;
  }
}

function countApiModels(payload: unknown): number | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return undefined;
  return payload.data.length;
}

async function probeXaiApiSummary(): Promise<string | undefined> {
  const apiKey = optionalText(process.env.XAI_API_KEY);
  if (!apiKey) return undefined;

  try {
    const models = await apiGetJson("https://api.x.ai/v1/models", apiKey);
    const count = countApiModels(models);
    return `xAI API key works; ${count === undefined ? "models visible" : `${count} models visible`}. Limits are in xAI Console; API responses include per-call cost.`;
  } catch (error) {
    return `xAI API probe failed: ${shortError(error)}`;
  }
}

async function probeCodexUsage(force = false): Promise<CodexUsage> {
  const cacheTtlMs = 10 * 60 * 1000;
  if (!force && cachedCodexUsage && Date.now() - cachedCodexUsageAt < cacheTtlMs) return cachedCodexUsage;

  const checkedAt = new Date().toISOString();
  try {
    const executable = codexExecutable();
    const result = await runCapture(executable.command, [...executable.args, "login", "status"], undefined, 15000);
    const rawStatus = (result.stdout || result.stderr).trim();
    const signedIn = result.exitCode === 0 && /logged in/i.test(rawStatus);
    const apiSummary = await probeOpenAiApiSummary();
    cachedCodexUsage = {
      status: signedIn ? "signed-in" : "signed-out",
      summary: compactSummary([
        signedIn
          ? "Signed in. Exact remaining Codex CLI limit is not exposed by the local CLI."
          : rawStatus || "Codex account is not signed in.",
        apiSummary ?? "Set OPENAI_ADMIN_KEY for OpenAI API spend and project limit probes."
      ]),
      source: apiSummary ? "codex login status + OpenAI API" : "codex login status",
      checkedAt
    };
  } catch (error) {
    cachedCodexUsage = {
      status: "unavailable",
      summary: error instanceof Error ? error.message : "Could not read Codex account status.",
      source: "codex login status",
      checkedAt
    };
  }
  cachedCodexUsageAt = Date.now();
  return cachedCodexUsage;
}

async function probeGrokUsage(force = false): Promise<CodexUsage> {
  const cacheTtlMs = 10 * 60 * 1000;
  if (!force && cachedGrokUsage && Date.now() - cachedGrokUsageAt < cacheTtlMs) return cachedGrokUsage;

  const checkedAt = new Date().toISOString();
  try {
    const executable = grokExecutable(["models"]);
    const result = await runCapture(executable.command, executable.args, undefined, 30000);
    const rawStatus = (result.stdout || result.stderr).trim();
    const signedIn = result.exitCode === 0 && /logged in with grok\.com/i.test(rawStatus);
    const authMissing = /not logged in|log in|login|auth|unauthori[sz]ed/i.test(rawStatus);
    const apiSummary = await probeXaiApiSummary();
    cachedGrokUsage = {
      status: signedIn ? "signed-in" : authMissing ? "signed-out" : result.exitCode === 0 ? "signed-out" : "unavailable",
      summary: compactSummary([
        signedIn
          ? "Signed in. Exact remaining Grok Build CLI limit is not exposed by the local CLI."
          : rawStatus || "Grok account is not signed in.",
        apiSummary ?? "Set XAI_API_KEY for xAI API status; xAI team limits remain in Console."
      ]),
      source: apiSummary ? "grok models + xAI API" : "grok models",
      checkedAt
    };
  } catch (error) {
    cachedGrokUsage = {
      status: "unavailable",
      summary: error instanceof Error ? error.message : "Could not read Grok account status.",
      source: "grok models",
      checkedAt
    };
  }
  cachedGrokUsageAt = Date.now();
  return cachedGrokUsage;
}

function codexExecutable(): { command: string; args: string[] } {
  if (process.env.CMC_CODEX_NODE && process.env.CMC_CODEX_JS) {
    return { command: process.env.CMC_CODEX_NODE, args: [process.env.CMC_CODEX_JS] };
  }
  return { command: process.env.CMC_CODEX_BIN || "codex", args: [] };
}

function grokExecutable(args: string[]): { command: string; args: string[] } {
  if (process.env.CMC_GROK_BIN) {
    return { command: process.env.CMC_GROK_BIN, args };
  }
  if (process.platform === "win32") {
    const grokBin = grokWslBinCommand();
    const proxyPrefix = grokWslProxyEnvPrefix();
    return {
      command: process.env.CMC_WSL_BASH_BIN || "bash.exe",
      args: ["-lc", `exec ${proxyPrefix}${grokBin} ${args.map(shellQuote).join(" ")}`]
    };
  }
  return { command: "grok", args };
}

function grokWslBinCommand(): string {
  const configured = process.env.CMC_GROK_WSL_BIN;
  if (!configured) return "$HOME/.grok/bin/grok";
  if (configured.startsWith("~/")) return `$HOME/${configured.slice(2).split("/").map(shellQuoteSegment).join("/")}`;
  return shellQuote(configured);
}

function shellQuoteSegment(value: string): string {
  return value.replaceAll("'", "'\\''");
}

function grokWslProxyEnvPrefix(): string {
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY || process.env.https_proxy || process.env.http_proxy || process.env.all_proxy;
  const noProxy = process.env.NO_PROXY || process.env.no_proxy;
  const assignments: Array<[string, string]> = [];
  if (proxy) {
    assignments.push(
      ["HTTP_PROXY", proxy],
      ["HTTPS_PROXY", proxy],
      ["ALL_PROXY", proxy],
      ["http_proxy", proxy],
      ["https_proxy", proxy],
      ["all_proxy", proxy]
    );
  }
  if (noProxy) {
    assignments.push(["NO_PROXY", noProxy], ["no_proxy", noProxy]);
  }
  return assignments.length
    ? `env ${assignments.map(([name, value]) => `${name}=${shellQuote(value)}`).join(" ")} `
    : "";
}

function optionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function optionalServerPath(projectPath: string, value: string | undefined): string | undefined {
  const trimmed = optionalText(value);
  return trimmed === "." ? projectPath : trimmed;
}

function safeProjectSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}

function isWindowsProjectPath(value: string): boolean {
  return /^[a-z]:[\\/]/i.test(value.trim()) || value.trim().startsWith("\\\\");
}

function normalizeIncomingProjectPath(repoId: string, projectPath: string): string {
  const trimmed = projectPath.trim();
  if (process.platform !== "win32" && isWindowsProjectPath(trimmed)) {
    return join(SERVER_PROJECTS_ROOT, safeProjectSegment(config.agentId), safeProjectSegment(repoId));
  }
  return trimmed;
}

function normalizeIncomingProjectData(data: RepoConfig["data"] | null | undefined, projectPath: string): RepoConfig["data"] | undefined {
  if (!data) return undefined;
  if (process.platform !== "win32" && isWindowsProjectPath(data.path)) {
    return { ...data, path: join(projectPath, "data") };
  }
  return data;
}

function normalizeIncomingDeploy(deploy: RepoConfig["deploy"] | null | undefined): RepoConfig["deploy"] | undefined {
  if (!deploy) return undefined;
  if (!deploy.buildCommand || process.platform === "win32") return deploy;
  const command = deploy.buildCommand.command;
  if (!/\.cmd$/i.test(command)) return deploy;
  return {
    ...deploy,
    buildCommand: {
      ...deploy.buildCommand,
      command: command.slice(0, -4)
    }
  };
}

async function hello(): Promise<AgentToServer> {
  const [repos, codexVersion, grokVersion, gitVersion, codexUsage, grokUsage] = await Promise.all([
    scanRepos(config),
    toolVersion("codex"),
    toolVersion("grok"),
    toolVersion("git", ["--version"]),
    probeCodexUsage(true),
    probeGrokUsage(true)
  ]);
  return {
    type: "agent.hello",
    agentId: config.agentId,
    hostname: optionalText(process.env.CMC_AGENT_HOSTNAME) ?? os.hostname(),
    os: `${os.type()} ${os.release()}`,
    agentVersion: "0.1.0",
    codexVersion,
    grokVersion,
    gitVersion,
    codexUsage,
    grokUsage,
    localActivity: detectLocalCodexActivity(config, currentJobId),
    repos
  };
}

function localActivitySyncKey(activity: LocalCodexActivity): string {
  return [
    activity.status,
    activity.source,
    activity.repoId ?? "",
    activity.chatTitle ?? "",
    activity.updatedAt ?? "",
    activity.busySinceAt ?? ""
  ].join("|");
}

async function runLocalChatSync(
  reason: string,
  send: (message: AgentToServer) => boolean,
  options: LocalChatSyncOptions = {}
): Promise<number> {
  if (
    !options.force
    && options.minIntervalMs
    && Date.now() - lastLocalChatSyncStartedAt < options.minIntervalMs
  ) {
    logProgress(`sync: Local chat sync skipped (${reason}): throttled.`);
    return 0;
  }
  if (localChatSyncPromise) {
    localChatSyncQueuedReason = localChatSyncQueuedReason ? `${localChatSyncQueuedReason},${reason}` : reason;
    return localChatSyncPromise;
  }
  const syncPromise = runLocalChatSyncQueue(reason, send, options);
  localChatSyncPromise = syncPromise;
  try {
    return await syncPromise;
  } finally {
    if (localChatSyncPromise === syncPromise) localChatSyncPromise = null;
  }
}

async function runLocalChatSyncQueue(
  reason: string,
  send: (message: AgentToServer) => boolean,
  options: LocalChatSyncOptions
): Promise<number> {
  let sent = 0;
  let currentReason = reason;
  while (currentReason) {
    const startedAt = Date.now();
    try {
      lastLocalChatSyncStartedAt = startedAt;
      logProgress(`sync: Local chat sync started (${currentReason}).`);
      const result = await syncLocalChats(config, send, {
        force: options.force,
        only: options.only,
        shouldContinue: options.shouldContinue
      });
      sent += result.sent;
      logProgress(`sync: Local chat sync completed (${currentReason}): ${syncResultSummary(result)} in ${Date.now() - startedAt}ms.`);
    } catch (error) {
      console.error(`[progress] sync: Local chat sync failed (${currentReason}): ${error instanceof Error ? error.message : String(error)}`);
    }
    currentReason = localChatSyncQueuedReason ? `queued:${localChatSyncQueuedReason}` : "";
    localChatSyncQueuedReason = "";
  }
  return sent;
}

function syncResultSummary(result: SyncLocalChatsResult): string {
  return `${result.sent} sent, ${result.skipped} unchanged, ${result.deferred} deferred`;
}

function scheduleLocalChatSyncAfterActivity(activity: LocalCodexActivity, send: (message: AgentToServer) => boolean): void {
  const key = localActivitySyncKey(activity);
  if (activity.status === "busy") lastBusyLocalChatSyncOnly = localChatSyncOnlyFromActivity(activity);
  if (key === lastLocalActivitySyncKey) return;
  const previousStatus = lastLocalActivityStatus;
  lastLocalActivitySyncKey = key;
  lastLocalActivityStatus = activity.status;
  if (previousStatus !== "busy" || activity.status !== "idle") return;
  const only = lastBusyLocalChatSyncOnly;
  lastBusyLocalChatSyncOnly = undefined;
  void runLocalChatSync("activity:idle", send, { force: Boolean(only), only });
  for (const delay of LOCAL_CHAT_SYNC_SETTLE_DELAYS_MS) {
    setTimeout(() => void runLocalChatSync(`activity-settle:idle:${delay}`, send, { force: Boolean(only), only, minIntervalMs: only ? undefined : LOCAL_CHAT_SYNC_ACTIVITY_MIN_INTERVAL_MS }), delay);
  }
}

function localChatSyncOnlyFromActivity(activity: LocalCodexActivity): LocalChatSyncOptions["only"] {
  return activity.repoId && activity.chatSource && activity.chatExternalId
    ? { repoId: activity.repoId, source: activity.chatSource, externalId: activity.chatExternalId }
    : undefined;
}

function connect() {
  const ws = new WebSocket(config.serverUrl, {
    headers: { Authorization: `Bearer ${token}` }
  });

  const send = (message: AgentToServer) => {
    if (ws.readyState !== WebSocket.OPEN) return false;
    if (message.type === "chat.sync" && ws.bufferedAmount > LOCAL_CHAT_SYNC_BACKPRESSURE_BYTES) {
      return false;
    }
    ws.send(JSON.stringify(message));
    return true;
  };

  ws.on("open", async () => {
    console.log(`Connected to ${config.serverUrl}`);
    for (const delay of [250, 1000, 3000]) {
      setTimeout(async () => send(await hello()), delay);
    }
    setTimeout(() => void runLocalChatSync("connect", send, { force: true }), 5000);
  });

  ws.on("message", async (raw) => {
    let message: ServerToAgent;
    try {
      message = ServerToAgentSchema.parse(JSON.parse(raw.toString()));
    } catch (error) {
      console.error("Invalid server message", error);
      return;
    }
    console.log(`Incoming ${message.type}: ${incomingSummary(message)}`);

    if (message.type === "repo.scan") {
      logProgress("scan: Scanning configured projects.");
      send({
        type: "agent.heartbeat",
        currentJobId,
        localActivity: detectLocalCodexActivity(config, currentJobId),
        codexUsage: await probeCodexUsage(),
        grokUsage: await probeGrokUsage(),
        repos: await scanRepos(config)
      });
      logProgress("scan: Project scan sent.");
      return;
    }

    if (message.type === "job.cancel") {
      if (message.jobId === currentJobId) {
        logProgress(`cancel: Cancelling job ${shortId(message.jobId)}.`);
        currentRunner?.cancel();
      }
      return;
    }

    if (message.type === "project.create") {
      try {
        logProgress(`project: Creating ${message.project.name}.`);
        if (config.repos.some((repo) => repo.id === message.project.id)) throw new Error("Project id already exists.");
        const projectPath = normalizeIncomingProjectPath(message.project.id, message.project.path);
        const projectDeploy = normalizeIncomingDeploy(message.project.deploy);
        const projectData = normalizeIncomingProjectData(message.project.data, projectPath);
        await prepareProjectFolder(projectPath, message.project.cloneGit === false ? undefined : message.project.githubUrl);
        config.repos.push({
          id: message.project.id,
          name: message.project.name,
          path: projectPath,
          githubUrl: optionalText(message.project.githubUrl),
          serverPath: optionalServerPath(projectPath, message.project.serverPath),
          domain: optionalText(message.project.domain),
          deploy: projectDeploy,
          data: projectData,
          defaultSandbox: message.project.defaultSandbox,
          allowedSandboxes: message.project.allowedSandboxes,
          testCommands: []
        });
        saveAgentConfig(config);
        await sendProjectResult(send, message.requestId, true);
        logProgress(`project: Created ${message.project.name}.`);
      } catch (error) {
        await sendProjectResult(send, message.requestId, false, error instanceof Error ? error.message : String(error));
        console.error(`[progress] project: Create failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }

    if (message.type === "project.update") {
      try {
        logProgress(`project: Updating ${message.repoId}.`);
        let repo = config.repos.find((item) => item.id === message.repoId);
        if (!repo) {
          if (!message.patch.name || !message.patch.path) throw new Error("Project not found in agent config.");
          const projectPath = normalizeIncomingProjectPath(message.repoId, message.patch.path);
          const projectDeploy = normalizeIncomingDeploy(message.patch.deploy);
          const projectData = normalizeIncomingProjectData(message.patch.data, projectPath);
          await prepareProjectFolder(projectPath, message.patch.githubUrl);
          repo = {
            id: message.repoId,
            name: message.patch.name,
            path: projectPath,
            githubUrl: optionalText(message.patch.githubUrl),
            serverPath: optionalServerPath(projectPath, message.patch.serverPath),
            domain: optionalText(message.patch.domain),
            deploy: projectDeploy,
            data: projectData,
            defaultSandbox: message.patch.defaultSandbox ?? "danger-full-access",
            allowedSandboxes: message.patch.allowedSandboxes ?? ["read-only", "workspace-write", "danger-full-access"],
            testCommands: []
          };
          config.repos.push(repo);
        } else {
          if (message.patch.path) {
            const projectPath = normalizeIncomingProjectPath(message.repoId, message.patch.path);
            await prepareProjectFolder(projectPath, "githubUrl" in message.patch ? optionalText(message.patch.githubUrl) : repo.githubUrl);
            repo.path = projectPath;
          }
          if (message.patch.name) repo.name = message.patch.name;
          if ("githubUrl" in message.patch) repo.githubUrl = optionalText(message.patch.githubUrl);
          if ("serverPath" in message.patch) repo.serverPath = optionalServerPath(repo.path, message.patch.serverPath);
          if ("domain" in message.patch) repo.domain = optionalText(message.patch.domain);
          if ("deploy" in message.patch) repo.deploy = normalizeIncomingDeploy(message.patch.deploy);
          if ("data" in message.patch) repo.data = normalizeIncomingProjectData(message.patch.data, repo.path);
          if (message.patch.defaultSandbox) repo.defaultSandbox = message.patch.defaultSandbox;
          if (message.patch.allowedSandboxes) repo.allowedSandboxes = message.patch.allowedSandboxes;
        }
        if (!repo.allowedSandboxes.includes(repo.defaultSandbox)) repo.defaultSandbox = repo.allowedSandboxes[0] ?? "read-only";
        saveAgentConfig(config);
        await sendProjectResult(send, message.requestId, true);
        logProgress(`project: Updated ${message.repoId}.`);
      } catch (error) {
        await sendProjectResult(send, message.requestId, false, error instanceof Error ? error.message : String(error));
        console.error(`[progress] project: Update failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }

    if (message.type === "project.delete") {
      try {
        logProgress(`project: Deleting ${message.repoId}.`);
        const index = config.repos.findIndex((item) => item.id === message.repoId);
        if (index === -1) throw new Error("Project not found in agent config.");
        config.repos.splice(index, 1);
        saveAgentConfig(config);
        await sendProjectResult(send, message.requestId, true);
        logProgress(`project: Deleted ${message.repoId}.`);
      } catch (error) {
        await sendProjectResult(send, message.requestId, false, error instanceof Error ? error.message : String(error));
        console.error(`[progress] project: Delete failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }

    if (message.type === "git.sync") {
      try {
        logProgress(`git: Sync started for ${message.repoId}.`);
        const output = await gitSync(message.repoId, message.message, message.remoteUrl, message.createRemote, message.remoteVisibility);
        await sendGitResult(send, message.requestId, true, output);
        logProgress(`git: Sync completed for ${message.repoId}.`);
      } catch (error) {
        await sendGitResult(send, message.requestId, false, "", error instanceof Error ? error.message : String(error));
        console.error(`[progress] git: Sync failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }

    if (message.type === "project.deploy") {
      try {
        logProgress(`deploy: Deploy started for ${message.repoId}.`);
        const output = await deployProject(message.repoId);
        await sendDeployResult(send, message.requestId, true, output);
        logProgress(`deploy: Deploy completed for ${message.repoId}.`);
      } catch (error) {
        await sendDeployResult(send, message.requestId, false, "", error instanceof Error ? error.message : String(error));
        console.error(`[progress] deploy: Deploy failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }

    if (message.type === "project.command") {
      try {
        logProgress(`project-command: ${message.command} started for ${message.repoId}.`);
        const output = message.command === "build"
          ? await buildProject(message.repoId)
          : message.command === "git-status"
            ? await gitStatusProject(message.repoId)
          : "Unknown project command.";
        send({
          type: "project.command.result",
          requestId: message.requestId,
          ok: true,
          output
        });
        logProgress(`project-command: ${message.command} completed for ${message.repoId}.`);
      } catch (error) {
        console.error(`[progress] project-command: ${message.command} failed: ${error instanceof Error ? error.message : String(error)}`);
        send({
          type: "project.command.result",
          requestId: message.requestId,
          ok: false,
          error: error instanceof Error ? redact(error.message) : redact(String(error))
        });
      }
      return;
    }

    if (message.type === "project.nginx") {
      try {
        logProgress(`nginx: Configure started for ${message.repoId}.`);
        const output = await configureNginx(message.repoId);
        await sendNginxResult(send, message.requestId, true, output);
        logProgress(`nginx: Configure completed for ${message.repoId}.`);
      } catch (error) {
        await sendNginxResult(send, message.requestId, false, "", error instanceof Error ? error.message : String(error));
        console.error(`[progress] nginx: Configure failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }

    if (message.type === "project.ssl") {
      try {
        logProgress(`ssl: Configure started for ${message.repoId}.`);
        const output = await configureSsl(message.repoId);
        await sendSslResult(send, message.requestId, true, output);
        logProgress(`ssl: Configure completed for ${message.repoId}.`);
      } catch (error) {
        await sendSslResult(send, message.requestId, false, "", error instanceof Error ? error.message : String(error));
        console.error(`[progress] ssl: Configure failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }

    if (message.type === "file.read") {
      try {
        const file = readProjectFile(message.repoId, message.path);
        send({
          type: "file.result",
          requestId: message.requestId,
          ok: true,
          ...file
        });
      } catch (error) {
        send({
          type: "file.result",
          requestId: message.requestId,
          ok: false,
          error: error instanceof Error ? redact(error.message) : redact(String(error))
        });
      }
      return;
    }

    if (message.type === "file.list") {
      try {
        const tree = listProjectFiles(message.repoId, message.path);
        send({
          type: "file.result",
          requestId: message.requestId,
          ok: true,
          ...tree
        });
      } catch (error) {
        send({
          type: "file.result",
          requestId: message.requestId,
          ok: false,
          error: error instanceof Error ? redact(error.message) : redact(String(error))
        });
      }
      return;
    }

    if (message.type === "file.write") {
      try {
        const file = writeProjectFile(message.repoId, message.path, message.content);
        send({
          type: "file.result",
          requestId: message.requestId,
          ok: true,
          ...file
        });
      } catch (error) {
        send({
          type: "file.result",
          requestId: message.requestId,
          ok: false,
          error: error instanceof Error ? redact(error.message) : redact(String(error))
        });
      }
      return;
    }

    if (message.type === "file.download") {
      try {
        const file = createProjectDownload(message.repoId, message.path);
        send({
          type: "file.result",
          requestId: message.requestId,
          ok: true,
          ...file
        });
      } catch (error) {
        send({
          type: "file.result",
          requestId: message.requestId,
          ok: false,
          error: error instanceof Error ? redact(error.message) : redact(String(error))
        });
      }
      return;
    }

    if (message.type === "vscode.command") {
      console.log(`VS Code command requested: ${message.command}`);
      try {
        const result = await sendVscodeBridgeCommand(message);
        console.log(`VS Code command result: ${message.command} ${result.ok ? "ok" : result.error ?? "failed"}`);
        const sent = send({
          type: "vscode.result",
          requestId: message.requestId,
          ok: result.ok,
          output: result.output,
          error: result.error
        });
        console.log(`VS Code command result ${sent ? "sent" : "dropped"}: ${message.command}`);
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        console.error(`VS Code command failed: ${message.command}: ${messageText}`);
        const sent = send({
          type: "vscode.result",
          requestId: message.requestId,
          ok: false,
          error: messageText
        });
        console.log(`VS Code command error ${sent ? "sent" : "dropped"}: ${message.command}`);
      }
      return;
    }

    if (message.type === "chat.sync.request") {
      try {
        logProgress("sync: Manual chat sync requested.");
        const sent = await runLocalChatSync("request", send, { force: true });
        send({
          type: "chat.sync.result",
          requestId: message.requestId,
          ok: true,
          sent
        });
        logProgress(`sync: Manual chat sync sent ${sent} chats.`);
      } catch (error) {
        send({
          type: "chat.sync.result",
          requestId: message.requestId,
          ok: false,
          error: error instanceof Error ? redact(error.message) : redact(String(error))
        });
        console.error(`[progress] sync: Manual chat sync failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }

    if (message.type === "job.run") {
      if (currentRunner) {
        console.log(`Job rejected: ${shortId(message.job.id)} because another job is running.`);
        send({
          type: "job.done",
          jobId: message.job.id,
          status: "failed",
          exitCode: 1,
          finalMessage: "Agent is already running another job."
        });
        return;
      }
      currentJobId = message.job.id;
      currentRunner = new Runner();
      const startedAt = Date.now();
      console.log(`Job received: ${shortId(message.job.id)} repo=${message.job.repoId} kind=${message.job.kind}.`);
      try {
        const result = await currentRunner.run({
          config,
          job: message.job,
          sendLog: (log) => {
            const redactedMessage = redact(log.message);
            if (log.stream === "system" || log.stream === "stderr") {
              console.log(`Job log ${shortId(log.jobId)} ${log.stream}: ${redactedMessage.slice(0, 500)}`);
            }
            send({ ...log, message: redactedMessage });
          },
          sendProgress: (progress) => {
            const redactedMessage = redact(progress.message);
            const diffText = progress.filesChanged !== undefined
              ? ` (${progress.filesChanged} files, +${progress.added ?? 0} -${progress.deleted ?? 0})`
              : "";
            logProgress(`job ${shortId(progress.jobId)} ${progress.phase}: ${redactedMessage.slice(0, 500)}${diffText}`);
            send({ ...progress, message: redactedMessage });
          }
        });
        console.log(`Job finished: ${shortId(message.job.id)} ${result.status} in ${Date.now() - startedAt}ms.`);
        send({
          ...result,
          finalMessage: result.finalMessage ? redact(result.finalMessage) : undefined,
          gitStatus: result.gitStatus ? redact(result.gitStatus) : undefined,
          gitDiffStat: result.gitDiffStat ? redact(result.gitDiffStat) : undefined,
          gitDiff: result.gitDiff ? redact(result.gitDiff) : undefined
        });
      } catch (error) {
        console.error(`Job failed: ${shortId(message.job.id)} ${error instanceof Error ? error.message : String(error)}`);
        send({
          type: "job.done",
          jobId: message.job.id,
          status: "failed",
          exitCode: 1,
          finalMessage: redact(error instanceof Error ? error.message : String(error))
        });
      } finally {
        currentRunner = null;
        currentJobId = undefined;
      }
    }
  });

  const heartbeat = setInterval(async () => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const localActivity = detectLocalCodexActivity(config, currentJobId);
    send({
      type: "agent.heartbeat",
      currentJobId,
      localActivity,
      codexUsage: await probeCodexUsage(),
      grokUsage: await probeGrokUsage(),
      repos: await scanRepos(config)
    });
    scheduleLocalChatSyncAfterActivity(localActivity, send);
  }, config.heartbeatIntervalMs);
  const chatSync = setInterval(async () => {
    if (ws.readyState !== WebSocket.OPEN) return;
    await runLocalChatSync("interval", send, { shouldContinue: () => ws.bufferedAmount <= LOCAL_CHAT_SYNC_BACKPRESSURE_BYTES });
  }, Math.max(LOCAL_CHAT_SYNC_INTERVAL_MS, 5000));
  const activitySync = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const localActivity = detectLocalCodexActivity(config, currentJobId);
    send({
      type: "agent.heartbeat",
      currentJobId,
      localActivity
    });
    scheduleLocalChatSyncAfterActivity(localActivity, send);
  }, LOCAL_ACTIVITY_INTERVAL_MS);

  ws.on("close", (code, reason) => {
    clearInterval(heartbeat);
    clearInterval(chatSync);
    clearInterval(activitySync);
    const reasonText = reason?.toString() || "";
    console.log(`Disconnected (${code}${reasonText ? ` ${reasonText}` : ""}). Reconnecting soon...`);
    setTimeout(connect, 3000);
  });

  ws.on("error", (error) => {
    console.error(error.message);
  });
}

async function main() {
  const command = process.argv[2];
  if (command === "doctor") {
    console.log(await hello());
    return;
  }
  if (command === "scan-repos") {
    console.log(JSON.stringify(await scanRepos(config), null, 2));
    return;
  }
  connect();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
