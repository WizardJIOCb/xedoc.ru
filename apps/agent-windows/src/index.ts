import os from "node:os";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import WebSocket from "ws";
import { ServerToAgentSchema, type AgentToServer, type CodexUsage, type LocalCodexActivity, type ServerToAgent } from "@cmc/protocol";
import { loadAgentConfig, saveAgentConfig } from "./config.js";
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

function repoFileTarget(repoId: string, rawPath: string): { repoPath: string; filePath: string; targetPath: string } {
  const repo = config.repos.find((item) => item.id === repoId);
  if (!repo) throw new Error("Project not found in agent config.");
  const filePath = rawPath.replace(/\\/g, "/").replace(/^\.\/+/, "").trim();
  if (
    !filePath
    || filePath.includes("\0")
    || filePath.startsWith("/")
    || /^[a-z]:\//i.test(filePath)
    || filePath.split("/").some((part) => !part || part === "." || part === "..")
    || filePath === ".git"
    || filePath.startsWith(".git/")
  ) {
    throw new Error("Unsafe file path.");
  }
  const repoPath = resolve(repo.path);
  const targetPath = resolve(repoPath, ...filePath.split("/"));
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

function readProjectFile(repoId: string, rawPath: string) {
  const target = repoFileTarget(repoId, rawPath);
  if (!existsSync(target.targetPath) || !statSync(target.targetPath).isFile()) throw new Error("File not found.");
  const stat = statSync(target.targetPath);
  if (stat.size > MAX_EDITOR_FILE_BYTES) throw new Error("File is too large for the web editor.");
  const bytes = readFileSync(target.targetPath);
  if (bytes.includes(0)) throw new Error("Binary files cannot be opened in the web editor.");
  return {
    path: target.filePath,
    content: bytes.toString("utf8"),
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
      "user-agent": "codex.rodion.pro-agent",
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

async function deployProject(repoId: string): Promise<string> {
  const repo = config.repos.find((item) => item.id === repoId);
  if (!repo) throw new Error("Project not found in agent config.");
  if (!repo.serverPath) throw new Error("Project server folder is not configured.");
  if (!repo.deploy) throw new Error("Project deploy settings are not configured.");
  if (!repo.serverPath.replace(/\\/g, "/").startsWith("/var/www/")) {
    throw new Error("Refusing to deploy outside /var/www.");
  }

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
  if (build) await runStep([build.command, ...build.args].join(" "), build.command, build.args, repo.path, build.timeoutMs);

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
  if (!repo.serverPath.replace(/\\/g, "/").startsWith("/var/www/")) {
    throw new Error("Refusing to configure nginx outside /var/www.");
  }

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
    "    }"
  ];
  const httpConfig = [
    "# Generated by codex.rodion.pro",
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
    "# Generated by codex.rodion.pro",
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
  const certbotCommand = [
    "sudo certbot --nginx",
    `-d ${shellQuote(repo.domain)}`,
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
  return [...output, `SSL configured: https://${repo.domain}`].join("\n");
}

function isSafeDomain(value: string): boolean {
  return /^(?=.{1,253}$)(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z0-9-]{2,63}$/i.test(value);
}

function resolveProjectPath(projectPath: string, childPath: string): string {
  if (/^[a-z]:[\\/]/i.test(childPath) || childPath.startsWith("\\\\") || isAbsolute(childPath)) return childPath;
  return resolve(projectPath, childPath);
}

function ensureLocalDeployPathIsSafe(path: string): void {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/g, "");
  if (!normalized.startsWith("/var/www/")) throw new Error("Refusing to deploy outside /var/www.");
  if (normalized.split("/").some((part) => part === "..")) throw new Error("Deploy path is not safe.");
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

async function probeCodexUsage(force = false): Promise<CodexUsage> {
  const cacheTtlMs = 10 * 60 * 1000;
  if (!force && cachedCodexUsage && Date.now() - cachedCodexUsageAt < cacheTtlMs) return cachedCodexUsage;

  const checkedAt = new Date().toISOString();
  try {
    const executable = codexExecutable();
    const result = await runCapture(executable.command, [...executable.args, "login", "status"], undefined, 15000);
    const rawStatus = (result.stdout || result.stderr).trim();
    const signedIn = result.exitCode === 0 && /logged in/i.test(rawStatus);
    cachedCodexUsage = {
      status: signedIn ? "signed-in" : "signed-out",
      summary: signedIn
        ? "Signed in. Exact remaining Codex limit is not exposed by the local CLI yet."
        : rawStatus || "Codex account is not signed in.",
      source: "codex login status",
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
    cachedGrokUsage = {
      status: signedIn ? "signed-in" : authMissing ? "signed-out" : result.exitCode === 0 ? "signed-out" : "unavailable",
      summary: signedIn
        ? "Signed in. Exact remaining Grok Build limit is not exposed by the local CLI yet."
        : rawStatus || "Grok account is not signed in.",
      source: "grok models",
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
    hostname: os.hostname(),
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
        await ensureGitRepo(message.project.path);
        config.repos.push({
          id: message.project.id,
          name: message.project.name,
          path: message.project.path,
          githubUrl: optionalText(message.project.githubUrl),
          serverPath: optionalText(message.project.serverPath),
          domain: optionalText(message.project.domain),
          deploy: message.project.deploy ?? undefined,
          data: message.project.data ?? undefined,
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
          await ensureGitRepo(message.patch.path);
          repo = {
            id: message.repoId,
            name: message.patch.name,
            path: message.patch.path,
            githubUrl: optionalText(message.patch.githubUrl),
            serverPath: optionalText(message.patch.serverPath),
            domain: optionalText(message.patch.domain),
            deploy: message.patch.deploy ?? undefined,
            data: message.patch.data ?? undefined,
            defaultSandbox: message.patch.defaultSandbox ?? "danger-full-access",
            allowedSandboxes: message.patch.allowedSandboxes ?? ["read-only", "workspace-write", "danger-full-access"],
            testCommands: []
          };
          config.repos.push(repo);
        } else {
          if (message.patch.path) {
            await ensureGitRepo(message.patch.path);
            repo.path = message.patch.path;
          }
          if (message.patch.name) repo.name = message.patch.name;
          if ("githubUrl" in message.patch) repo.githubUrl = optionalText(message.patch.githubUrl);
          if ("serverPath" in message.patch) repo.serverPath = optionalText(message.patch.serverPath);
          if ("domain" in message.patch) repo.domain = optionalText(message.patch.domain);
          if ("deploy" in message.patch) repo.deploy = message.patch.deploy ?? undefined;
          if ("data" in message.patch) repo.data = message.patch.data ?? undefined;
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
