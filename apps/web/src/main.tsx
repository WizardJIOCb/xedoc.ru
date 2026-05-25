import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { useRef } from "react";
import {
  Activity,
  ArrowLeft,
  Bot,
  CalendarDays,
  Camera,
  Check,
  CheckCircle2,
  ChevronDown,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Clock3,
  Database,
  Download,
  ExternalLink,
  FolderGit2,
  Github,
  GitBranch,
  KeyRound,
  Link2,
  LogOut,
  Mail,
  Menu,
  MoreHorizontal,
  MessageSquare,
  Palette,
  Paperclip,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  Save,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Square,
  PlugZap,
  Terminal,
  Trash2,
  UploadCloud,
  UserCircle,
  Wrench,
  Wifi,
  WifiOff,
  X
} from "lucide-react";
import "./styles.css";

type Sandbox = "read-only" | "workspace-write" | "danger-full-access";
type ReasoningEffort = "low" | "medium" | "high" | "xhigh";
type CodexSpeed = "standard" | "fast";
type ProjectVisibility = "private" | "public";
type UiTheme = "paper" | "graphite" | "lagoon" | "moss" | "rose";
type ProjectWizardStep = "project" | "git" | "deploy" | "data" | "ready";
type ProjectDataLocation = "local" | "server";
type ProjectDataConfig = {
  location: ProjectDataLocation;
  path: string;
};

const SANDBOXES: Sandbox[] = ["read-only", "workspace-write", "danger-full-access"];
const SANDBOX_LABELS: Record<Sandbox, string> = {
  "read-only": "read-only",
  "workspace-write": "workspace-write",
  "danger-full-access": "full-access"
};
const REASONING_OPTIONS: Array<{ value: ReasoningEffort; label: string }> = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" }
];
const CODEX_MODEL_OPTIONS = [
  { value: "gpt-5.5", label: "GPT-5.5" },
  { value: "gpt-5.4", label: "GPT-5.4" },
  { value: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
  { value: "gpt-5.3-codex", label: "GPT-5.3 Codex" }
];
const PROJECT_DOMAIN_ROOT = "codex.rodion.pro";
const DEFAULT_GITHUB_OWNER = "WizardJIOCb";
const DEFAULT_DEPLOY_SSH_TARGET = "myserver";
const DEFAULT_SERVER_ROOT = "/var/www";
const SPEED_OPTIONS: Array<{ value: CodexSpeed; label: string; note: string }> = [
  { value: "standard", label: "Standard", note: "Default speed, normal usage" },
  { value: "fast", label: "Fast", note: "Saved with run metadata" }
];
const UI_THEME_OPTIONS: Array<{ value: UiTheme; label: string; note: string; swatches: string[] }> = [
  { value: "paper", label: "Paper", note: "Светлая нейтральная", swatches: ["#f7f7f4", "#ffffff", "#202123", "#10a37f"] },
  { value: "graphite", label: "Graphite", note: "Темная контрастная", swatches: ["#101214", "#1b1f22", "#e7ece8", "#4fd1b0"] },
  { value: "lagoon", label: "Lagoon", note: "Холодная рабочая", swatches: ["#eef7f7", "#ffffff", "#16323a", "#0e7490"] },
  { value: "moss", label: "Moss", note: "Спокойная зеленая", swatches: ["#f1f6ee", "#ffffff", "#233025", "#4d7c0f"] },
  { value: "rose", label: "Rose", note: "Мягкая теплая", swatches: ["#fbf3f6", "#ffffff", "#35242a", "#be3455"] }
];
const UI_THEMES = UI_THEME_OPTIONS.map((option) => option.value);
const PROJECT_WIZARD_STEPS: Array<{ id: ProjectWizardStep; label: string }> = [
  { id: "project", label: "Project" },
  { id: "git", label: "Git" },
  { id: "deploy", label: "Deploy" },
  { id: "data", label: "Data" },
  { id: "ready", label: "Ready" }
];
const LOCAL_CHAT_SYNC_REFRESH_DELAYS_MS = [0, 800, 2000, 4000, 8000, 15000];
type VscodeCommand = "ping" | "openSidebar" | "newChat" | "newCodexPanel" | "addToThread" | "addFileToThread" | "openThread" | "reopenThread" | "refreshThreadIfOpen";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

type Agent = {
  id: string;
  user_id?: string | null;
  name: string;
  hostname?: string;
  os?: string;
  status: "online" | "offline";
  current_job_id?: string | null;
  codex_version?: string;
  git_version?: string;
  last_seen_at?: string;
  localActivity?: {
    status: "idle" | "busy";
    summary: string;
    source: string;
    detectedAt: string;
    busySinceAt?: string;
    repoId?: string;
    chatSource?: "codex" | "vscode";
    chatExternalId?: string;
    chatTitle?: string;
    updatedAt?: string;
  };
  codexUsage?: {
    status: "signed-in" | "signed-out" | "unavailable";
    summary: string;
    source: string;
    checkedAt: string;
    resetAt?: string;
    limit?: number;
    remaining?: number;
    usedPercent?: number;
  };
};

type User = {
  id: string;
  email: string;
  role: "admin" | "user";
  nickname?: string | null;
  bio?: string | null;
  avatarDataUrl?: string | null;
  blockedAt?: string | null;
  createdAt?: string;
  updatedAt?: string | null;
};

type ProfileStats = {
  chats: number;
  jobs: number;
  completedJobs: number;
  failedJobs: number;
  projects: number;
  generationSeconds: number;
};

type AdminUser = User & {
  agents: number;
  stats: ProfileStats;
  lastActiveAt?: string | null;
};

type AdminChat = Chat & {
  agentName: string;
  repoName?: string | null;
  messageCount: number;
  jobCount: number;
};

type AdminStatsPoint = {
  day: string;
  dau: number;
  wau: number;
  mau: number;
  registrations: number;
};

type AdminStatsMetric = "dau" | "wau" | "mau" | "registrations";

type OAuthProvider = {
  provider: "google" | "github" | "vk" | "mailru";
  connected: boolean;
  displayName?: string | null;
  connectedAt?: string | null;
  configured: boolean;
};

type AgentSetup = {
  agentId: string;
  platform?: "windows" | "linux";
  serverUrl: string;
  token: string;
  configJson: string;
  setupPowerShell: string;
  setupShell?: string;
  setupBatch?: string;
  setupFileName?: string;
  packageUrl?: string;
};

type DeployConfig = {
  mode?: "ssh" | "local";
  sshTarget?: string;
  sourceDir: string;
  remoteSubdir?: string;
  cleanRemote: boolean;
  buildCommand?: {
    command: string;
    args: string[];
    timeoutMs: number;
  };
};

type Repo = {
  id: string;
  agentId: string;
  name: string;
  pathMasked: string;
  githubUrl?: string;
  serverPath?: string;
  domain?: string;
  visibility?: ProjectVisibility;
  deploy?: DeployConfig;
  data?: ProjectDataConfig;
  currentBranch?: string;
  dirty: boolean;
  defaultSandbox: Sandbox;
  allowedSandboxes: Sandbox[];
  testCommands: Array<{ id: string; label: string }>;
};

type PublicProfile = {
  id: string;
  email: string;
  nickname?: string | null;
  bio?: string | null;
  avatarDataUrl?: string | null;
  createdAt?: string;
  updatedAt?: string | null;
  profileSlug: string;
  profileUrl: string;
  stats: ProfileStats;
  publicProjects: number;
};

type PublicProject = {
  id: string;
  agentId: string;
  name: string;
  domain?: string | null;
  githubUrl?: string | null;
  visibility: ProjectVisibility;
  currentBranch?: string | null;
  dirty: boolean;
  updatedAt: string;
  url?: string | null;
  chatCount: number;
  author: {
    id: string;
    email: string;
    nickname?: string | null;
    bio?: string | null;
    avatarDataUrl?: string | null;
    createdAt?: string;
    profileSlug: string;
    profileUrl: string;
  };
  latestChats: Chat[];
};

type PublicChatPayload = {
  chat: Chat;
  messages: ChatMessage[];
  jobs: Job[];
};

type Chat = {
  id: string;
  agentId: string;
  repoId: string;
  title: string;
  source?: string;
  externalId?: string | null;
  cwd?: string | null;
  hiddenAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

type ChatMessage = {
  id: string;
  chatId: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  source: string;
  externalId?: string | null;
  metadata?: Record<string, unknown>;
  createdAt: string;
  attachments?: MessageAttachment[];
};

type MessageAttachment = {
  id?: string;
  name: string;
  mimeType: string;
  size: number;
  url?: string;
  dataBase64?: string;
};

type ChatPayload = {
  chat: Chat;
  jobs: Job[];
  messages: ChatMessage[];
};

type SharedChat = {
  token: string;
  url: string;
  project?: {
    name: string;
    domain?: string | null;
    url?: string | null;
  } | null;
  title: string;
  source: string;
  externalId?: string | null;
  finalContent?: string | null;
  createdAt: string;
  updatedAt: string;
  snapshot: ChatPayload & {
    exportedAt: string;
    finalAnswer?: string | null;
  };
};

type ImagePreview = {
  src: string;
  name: string;
  mimeType: string;
  size: number;
};

type PendingAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  dataBase64: string;
  previewUrl?: string;
};

type ChatLoadingProgress = {
  phase: "request" | "download" | "parse" | "details";
  loadedBytes: number;
  totalBytes?: number;
  percent?: number;
  startedAt: number;
};

type Job = {
  id: string;
  chatId?: string | null;
  agentId: string;
  repoId: string;
  prompt: string;
  sandbox: string;
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  speed?: CodexSpeed | null;
  status: string;
  exitCode: number | null;
  finalMessage: string | null;
  gitStatus: string | null;
  gitDiffStat: string | null;
  gitDiff: string | null;
  gitDiffOmitted?: boolean;
  codexThreadId?: string | null;
  progress?: JobProgress | null;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
};

type Log = {
  id?: string;
  job_id?: string;
  jobId?: string;
  stream: "stdout" | "stderr" | "system";
  message: string;
  at: string;
};

type JobProgress = {
  jobId: string;
  phase: string;
  message: string;
  filesChanged?: number;
  added?: number;
  deleted?: number;
  files?: Array<{
    path: string;
    added: number;
    deleted: number;
  }>;
  at: string;
};

type DiffRow = {
  file: string;
  changed: number;
  bars: string;
  added: number | null;
  deleted: number | null;
};

type DiffSummary = {
  files: number;
  added: number | null;
  deleted: number | null;
};

type DiffLine = {
  type: "context" | "added" | "deleted";
  oldLine?: number;
  newLine?: number;
  text: string;
};

type FileDiff = {
  file: string;
  lines: DiffLine[];
};

type CodexAction = {
  id: string;
  command: string;
  status: string;
  output: string;
  at: string;
};

type LiveActivityEntry = {
  id: string;
  kind: "message" | "command" | "error";
  at: string;
  text?: string;
  action?: CodexAction;
};

type CollapsedRunSummary = {
  job?: Job;
  messages: ChatMessage[];
  commandCount: number;
  durationSeconds: number;
};

type ChatTimelineItem = {
  message: ChatMessage;
  collapsedRun?: CollapsedRunSummary;
};

function api(path: string, options: RequestInit = {}) {
  return fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {})
    }
  }).catch((error) => {
    if (isAbortError(error)) throw error;
    return new Response(JSON.stringify({ error: "network_error" }), {
      status: 503,
      headers: { "Content-Type": "application/json" }
    });
  });
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError"
    || error instanceof Error && error.name === "AbortError";
}

function progressPercent(progress: ChatLoadingProgress | null) {
  if (!progress) return 0;
  if (typeof progress.percent === "number") return Math.max(0, Math.min(100, Math.round(progress.percent)));
  return 0;
}

function chatLoadingPhaseLabel(phase: ChatLoadingProgress["phase"]) {
  if (phase === "request") return "Соединяюсь с сервером";
  if (phase === "download") return "Загружаю историю";
  if (phase === "parse") return "Собираю сообщения";
  return "Подтягиваю детали запуска";
}

function defaultProjectPath(name: string, agent?: Agent | null) {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9а-яё.]+/gi, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^-+|-+$/g, "");
  const safeSlug = slug || "new-project";
  return isLinuxAgent(agent) ? `/srv/codex-agent/repos/${safeSlug}` : `C:\\Projects\\${safeSlug}`;
}

function projectSlug(name: string) {
  return name
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "new-project";
}

function normalizeProjectDomain(value: string) {
  const trimmed = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\.+$/g, "");
  if (!trimmed) return "";
  return trimmed.includes(".") ? trimmed : `${trimmed}.${PROJECT_DOMAIN_ROOT}`;
}

function defaultProjectDomain(name: string) {
  return `${projectSlug(name)}.${PROJECT_DOMAIN_ROOT}`;
}

function defaultServerPathForDomain(domain: string) {
  return domain ? `${DEFAULT_SERVER_ROOT}/${domain}` : "";
}

function defaultGithubUrlForDomain(domain: string) {
  return domain ? `https://github.com/${DEFAULT_GITHUB_OWNER}/${domain}` : "";
}

function isUiTheme(value: string | null): value is UiTheme {
  return UI_THEMES.includes(value as UiTheme);
}

function defaultProjectValues(name: string, agent?: Agent | null) {
  const domain = defaultProjectDomain(name);
  return {
    path: defaultProjectPath(name, agent),
    domain,
    serverPath: defaultServerPathForDomain(domain),
    githubUrl: defaultGithubUrlForDomain(domain)
  };
}

function projectUrl(domain?: string) {
  const normalized = normalizeProjectDomain(domain ?? "");
  return normalized ? `https://${normalized}` : "";
}

function appendProjectPath(root: string, segment: string) {
  const trimmed = root.trim().replace(/[\\/]+$/g, "");
  if (!trimmed) return segment;
  const separator = /^[a-z]:\\/i.test(trimmed) || trimmed.includes("\\") ? "\\" : "/";
  return `${trimmed}${separator}${segment}`;
}

function defaultProjectDataPath(location: ProjectDataLocation, projectPath: string, serverPath: string) {
  return appendProjectPath(location === "server" ? serverPath : projectPath, "data");
}

function profileSlug(user?: Pick<User, "id" | "nickname"> | null) {
  return user?.nickname?.trim() || user?.id || "";
}

function profileUrl(user?: Pick<User, "id" | "nickname"> | null) {
  const slug = profileSlug(user);
  return slug ? `${window.location.origin}/u/${encodeURIComponent(slug)}` : "";
}

function splitCommandLine(value: string) {
  return Array.from(value.matchAll(/"([^"]*)"|'([^']*)'|[^\s]+/g)).map((match) => match[1] ?? match[2] ?? match[0]);
}

function formatBuildCommand(deploy?: DeployConfig) {
  if (!deploy?.buildCommand) return "";
  return [deploy.buildCommand.command, ...deploy.buildCommand.args].join(" ");
}

function isLinuxAgent(agent?: Agent | null) {
  const text = `${agent?.id ?? ""} ${agent?.name ?? ""} ${agent?.hostname ?? ""} ${agent?.os ?? ""}`.toLowerCase();
  return /linux|ubuntu|debian|server/.test(text);
}

function defaultBuildCommandForAgent(agent?: Agent | null) {
  return isLinuxAgent(agent) ? "npm run build" : "npm.cmd run build";
}

function hasDeployConfig(repo?: Repo | null) {
  if (!repo?.serverPath || !repo.deploy) return false;
  return (repo.deploy.mode ?? "ssh") === "local" || Boolean(repo.deploy.sshTarget);
}

function buildDeployConfig(mode: "ssh" | "local", sshTarget: string, sourceDir: string, remoteSubdir: string, cleanRemote: boolean, buildCommand: string): DeployConfig | undefined {
  const target = sshTarget.trim();
  if (mode === "ssh" && !target) return undefined;
  const parts = splitCommandLine(buildCommand.trim());
  return {
    mode,
    sshTarget: mode === "ssh" ? target : undefined,
    sourceDir: sourceDir.trim() || "dist",
    remoteSubdir: remoteSubdir.trim() || undefined,
    cleanRemote,
    buildCommand: parts[0] ? {
      command: parts[0],
      args: parts.slice(1),
      timeoutMs: 900000
    } : undefined
  };
}

function buildProjectDataConfig(location: ProjectDataLocation, path: string): ProjectDataConfig | undefined {
  const dataPath = path.trim();
  if (!dataPath) return undefined;
  return { location, path: dataPath };
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function formatDuration(totalSeconds: number) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  if (hours) return `${hours}h ${minutes}m ${remainingSeconds}s`;
  if (minutes) return `${minutes}m ${remainingSeconds}s`;
  return `${remainingSeconds}s`;
}

function formatDateTime(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
}

function chatSourceLabel(source?: string | null) {
  if (source === "codex") return "Codex";
  if (source === "vscode") return "VS Code";
  return "Web";
}

function shortChatExternalId(chat?: Pick<Chat, "externalId"> | null) {
  return chat?.externalId ? chat.externalId.slice(0, 8) : "";
}

function chatIdentityText(chat?: Pick<Chat, "source" | "externalId"> | null) {
  if (!chat) return "";
  const id = shortChatExternalId(chat);
  return id ? `${chatSourceLabel(chat.source)} · ${id}` : chatSourceLabel(chat.source);
}

function isPreviewableImage(mimeType: string) {
  return ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp"].includes(mimeType.toLowerCase());
}

function readFileAttachment(file: File): Promise<PendingAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read file."));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      const dataBase64 = comma >= 0 ? result.slice(comma + 1) : result;
      resolve({
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: file.name || `pasted-image-${Date.now()}.png`,
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        dataBase64,
        previewUrl: isPreviewableImage(file.type) ? result : undefined
      });
    };
    reader.readAsDataURL(file);
  });
}

function downloadTextFile(filename: string, content: string, type = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function progressDiffRows(files: JobProgress["files"] | undefined): DiffRow[] {
  return (files ?? []).map((file) => ({
    file: file.path,
    changed: file.added + file.deleted,
    bars: "",
    added: file.added,
    deleted: file.deleted
  }));
}

function parseUnifiedDiff(diff: string | null | undefined): FileDiff[] {
  if (!diff) return [];
  const files: FileDiff[] = [];
  let current: FileDiff | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of normalizeDisplayText(diff).split("\n")) {
    const fileHeader = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (fileHeader) {
      current = { file: fileHeader[2] || fileHeader[1] || "", lines: [] };
      files.push(current);
      continue;
    }
    if (!current) continue;

    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      current.lines.push({ type: "context", oldLine: undefined, newLine: undefined, text: line });
      continue;
    }

    if (!line || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ")) continue;
    if (line.startsWith("+")) {
      current.lines.push({ type: "added", newLine, text: line.slice(1) });
      newLine += 1;
      continue;
    }
    if (line.startsWith("-")) {
      current.lines.push({ type: "deleted", oldLine, text: line.slice(1) });
      oldLine += 1;
      continue;
    }
    if (line.startsWith(" ")) {
      current.lines.push({ type: "context", oldLine, newLine, text: line.slice(1) });
      oldLine += 1;
      newLine += 1;
    }
  }

  return files.filter((file) => file.lines.some((line) => line.type !== "context"));
}

function findFileDiffInList(fileDiffs: FileDiff[], file: string) {
  const normalized = file.replace(/\\/g, "/");
  return fileDiffs.find((item) => item.file.replace(/\\/g, "/") === normalized);
}

function diffRowsFromFileDiffs(fileDiffs: FileDiff[]): DiffRow[] {
  return fileDiffs.map((fileDiff) => {
    const added = fileDiff.lines.filter((line) => line.type === "added").length;
    const deleted = fileDiff.lines.filter((line) => line.type === "deleted").length;
    return {
      file: fileDiff.file,
      changed: added + deleted,
      bars: "",
      added,
      deleted
    };
  }).filter((row) => row.changed > 0);
}

function diffSummaryFromRows(rows: DiffRow[]) {
  const exact = rows.every((row) => row.added !== null && row.deleted !== null);
  return rows.reduce<DiffSummary>((total, row) => ({
    files: total.files + 1,
    added: exact ? (total.added ?? 0) + (row.added ?? 0) : null,
    deleted: exact ? (total.deleted ?? 0) + (row.deleted ?? 0) : null
  }), { files: 0, added: exact ? 0 : null, deleted: exact ? 0 : null });
}

function diffSummaryFromProgress(fallback?: { filesChanged?: number; added?: number; deleted?: number; files?: JobProgress["files"] } | null): DiffSummary | null {
  if (!fallback) return null;
  if (fallback.filesChanged === undefined && fallback.added === undefined && fallback.deleted === undefined && !fallback.files?.length) return null;
  return {
    files: fallback.filesChanged ?? fallback.files?.length ?? 0,
    added: fallback.added ?? 0,
    deleted: fallback.deleted ?? 0
  };
}

function diffSummaryFromStat(stat: string | null | undefined): DiffSummary | null {
  const summaryLine = stat
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^\d+\s+files?\s+changed\b/i.test(line));
  if (!summaryLine) return null;
  const files = Number(summaryLine.match(/^(\d+)\s+files?\s+changed\b/i)?.[1] ?? 0);
  const added = Number(summaryLine.match(/(\d+)\s+insertions?\(\+\)/i)?.[1] ?? 0);
  const deleted = Number(summaryLine.match(/(\d+)\s+deletions?\(-\)/i)?.[1] ?? 0);
  return { files, added, deleted };
}

function diffRows(stat: string | null, fallbackFiles?: JobProgress["files"], limit = 8): DiffRow[] {
  const fallbackRows = progressDiffRows(fallbackFiles);
  if (fallbackRows.length) return limit === Number.POSITIVE_INFINITY ? fallbackRows : fallbackRows.slice(0, limit);
  if (!stat) return [];
  const rows = stat
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^\d+\s+files?\s+changed\b/i.test(line))
    .flatMap((line) => {
      const match = line.match(/^(.*?)\s+\|\s+(\d+)\s+([+\-]+)?/);
      if (!match) return [];
      const changed = Number(match?.[2] ?? 0);
      const bars = match?.[3] ?? "";
      const exactBars = bars.length === changed;
      return [{
        file: match?.[1]?.trim() || line,
        changed,
        bars: exactBars ? bars : "",
        added: exactBars ? [...bars].filter((char) => char === "+").length : null,
        deleted: exactBars ? [...bars].filter((char) => char === "-").length : null
      }];
    });
  return limit === Number.POSITIVE_INFINITY ? rows : rows.slice(0, limit);
}

function diffSummary(stat: string | null, fallback?: { filesChanged?: number; added?: number; deleted?: number; files?: JobProgress["files"] } | null) {
  const statSummary = diffSummaryFromStat(stat);
  if (statSummary) return statSummary;
  const progressSummary = diffSummaryFromProgress(fallback);
  if (progressSummary) return progressSummary;
  const rows = diffRows(stat, undefined, Number.POSITIVE_INFINITY);
  const fromRows = diffSummaryFromRows(rows);
  return fromRows;
}

function hasProgressChanges(progress: JobProgress | null | undefined) {
  return Boolean(
    (progress?.files?.length ?? 0) > 0
    || (progress?.filesChanged ?? 0) > 0
    || (progress?.added ?? 0) > 0
    || (progress?.deleted ?? 0) > 0
  );
}

function jobDurationSeconds(job: Job) {
  const start = Date.parse(job.startedAt || job.createdAt);
  const finish = Date.parse(job.finishedAt || new Date().toISOString());
  if (!Number.isFinite(start) || !Number.isFinite(finish)) return 0;
  return Math.max(0, Math.floor((finish - start) / 1000));
}

function renderDiffRowMeta(row: DiffRow) {
  if (row.added !== null && row.deleted !== null && (row.added || row.deleted)) {
    return (
      <>
        <span className="diff-added">+{row.added}</span>
        <span className="diff-deleted">-{row.deleted}</span>
      </>
    );
  }
  return <span className="diff-neutral">{row.changed}{row.bars ? ` ${row.bars}` : ""}</span>;
}

function messageDurationSeconds(message: ChatMessage) {
  if (typeof message.metadata?.durationSeconds === "number") return Math.max(0, Math.floor(message.metadata.durationSeconds));
  const startedAt = typeof message.metadata?.startedAt === "string" ? Date.parse(message.metadata.startedAt) : NaN;
  const finishedAt = Date.parse(message.createdAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt)) return 0;
  return Math.max(0, Math.floor((finishedAt - startedAt) / 1000));
}

function messageRunDetails(message: ChatMessage, job: Job | undefined, collapsedRun?: CollapsedRunSummary) {
  const runJob = job ?? collapsedRun?.job;
  const metadataModel = typeof message.metadata?.model === "string" ? message.metadata.model : "";
  const metadataReasoning = typeof message.metadata?.reasoningEffort === "string" ? message.metadata.reasoningEffort : "";
  const metadataSpeed = typeof message.metadata?.speed === "string" ? message.metadata.speed : "";
  const model = runJob?.model || metadataModel;
  const reasoning = runJob?.reasoningEffort || metadataReasoning;
  const speed = runJob?.speed || metadataSpeed;
  const durationSeconds = collapsedRun?.durationSeconds ?? (runJob?.finishedAt ? jobDurationSeconds(runJob) : messageDurationSeconds(message));
  const settings = [
    model ? CODEX_MODEL_OPTIONS.find((option) => option.value === model)?.label ?? model : "",
    reasoning ? `Intelligence ${REASONING_OPTIONS.find((option) => option.value === reasoning)?.label ?? reasoning}` : "",
    speed ? `Speed ${SPEED_OPTIONS.find((option) => option.value === speed)?.label ?? speed}` : ""
  ].filter(Boolean);
  const timing = [
    formatDateTime(message.createdAt),
    durationSeconds > 0 ? `Работал ${formatDuration(durationSeconds)}` : ""
  ].filter(Boolean);
  return { settings, timing };
}

function parseCommandOutput(output: string) {
  const normalized = normalizeDisplayText(output).trim();
  const exitCode = normalized.match(/^Exit code:\s*([^\n]+)$/im)?.[1]?.trim();
  const wallTime = normalized.match(/^Wall time:\s*([^\n]+)$/im)?.[1]?.trim();
  const body = normalized
    .replace(/^Exit code:\s*[^\n]+\n?/im, "")
    .replace(/^Wall time:\s*[^\n]+\n?/im, "")
    .replace(/^Output:\s*\n?/im, "")
    .trim();
  return { exitCode, wallTime, body };
}

function commandStatusLabel(action: CodexAction, exitCode?: string) {
  const status = action.status.toLowerCase();
  if (status.includes("running")) return "Running";
  if (status.includes("failed") || (exitCode && exitCode !== "0")) return "Failed";
  if (status.includes("cancel")) return "Cancelled";
  return "Success";
}

function commandRunLabel(action: CodexAction, wallTime?: string) {
  const running = action.status.toLowerCase().includes("running");
  return `${running ? "Running" : "Ran"} command${wallTime ? ` for ${wallTime}` : ""}`;
}

function normalizeDisplayText(value: string) {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n")
    .replace(/\\t/g, "  ");
}

function isEscaped(text: string, index: number) {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor--) slashes += 1;
  return slashes % 2 === 1;
}

function findMarkdownToken(text: string, token: string, start: number) {
  let index = start;
  while ((index = text.indexOf(token, index)) >= 0) {
    if (!isEscaped(text, index)) return index;
    index += token.length;
  }
  return -1;
}

function safeMarkdownHref(value: string) {
  const href = value.trim();
  if (/^(https?:|mailto:|tel:)/i.test(href) || href.startsWith("/") || href.startsWith("#")) return href;
  return "";
}

function renderInlineMarkdown(text: string, keyPrefix = "inline"): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let plain = "";
  let index = 0;

  const flushPlain = () => {
    if (!plain) return;
    nodes.push(plain);
    plain = "";
  };

  const pushFormatted = (token: string, element: (children: React.ReactNode[]) => React.ReactNode) => {
    const close = findMarkdownToken(text, token, index + token.length);
    if (close <= index + token.length - 1) return false;
    const body = text.slice(index + token.length, close);
    flushPlain();
    nodes.push(element(renderInlineMarkdown(body, `${keyPrefix}:${nodes.length}`)));
    index = close + token.length;
    return true;
  };

  while (index < text.length) {
    const char = text[index] ?? "";
    if (char === "\\" && index + 1 < text.length && /[`*_~[\]()\\]/.test(text[index + 1] ?? "")) {
      plain += text[index + 1];
      index += 2;
      continue;
    }
    if (char === "`") {
      const close = findMarkdownToken(text, "`", index + 1);
      if (close > index) {
        flushPlain();
        nodes.push(<code key={`${keyPrefix}:code:${nodes.length}`}>{text.slice(index + 1, close)}</code>);
        index = close + 1;
        continue;
      }
    }
    if (char === "[") {
      const labelEnd = findMarkdownToken(text, "]", index + 1);
      const hrefStart = labelEnd >= 0 ? labelEnd + 1 : -1;
      if (hrefStart >= 0 && text[hrefStart] === "(") {
        const hrefEnd = findMarkdownToken(text, ")", hrefStart + 1);
        if (hrefEnd > hrefStart + 1) {
          const href = safeMarkdownHref(text.slice(hrefStart + 1, hrefEnd));
          if (href) {
            flushPlain();
            nodes.push(
              <a href={href} key={`${keyPrefix}:link:${nodes.length}`} rel="noreferrer" target={href.startsWith("#") || href.startsWith("/") ? undefined : "_blank"}>
                {renderInlineMarkdown(text.slice(index + 1, labelEnd), `${keyPrefix}:link:${nodes.length}`)}
              </a>
            );
            index = hrefEnd + 1;
            continue;
          }
        }
      }
    }
    if (text.startsWith("**", index) && pushFormatted("**", (children) => <strong key={`${keyPrefix}:strong:${nodes.length}`}>{children}</strong>)) continue;
    if (text.startsWith("__", index) && pushFormatted("__", (children) => <strong key={`${keyPrefix}:strong:${nodes.length}`}>{children}</strong>)) continue;
    if (text.startsWith("~~", index) && pushFormatted("~~", (children) => <del key={`${keyPrefix}:del:${nodes.length}`}>{children}</del>)) continue;
    if (char === "*" && !text.startsWith("**", index) && pushFormatted("*", (children) => <em key={`${keyPrefix}:em:${nodes.length}`}>{children}</em>)) continue;
    if (char === "_" && !text.startsWith("__", index) && pushFormatted("_", (children) => <em key={`${keyPrefix}:em:${nodes.length}`}>{children}</em>)) continue;
    plain += char;
    index += 1;
  }

  flushPlain();
  return nodes;
}

function renderRichText(value: string, className = "rich-text") {
  const lines = normalizeDisplayText(value).trim().split("\n");
  const blocks: React.ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^```\s*([\w-]+)?\s*$/);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index] ?? "")) {
        code.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(
        <pre className="rich-code" key={blocks.length}>
          <code>{code.join("\n")}</code>
        </pre>
      );
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading?.[2]) {
      blocks.push(<h3 key={blocks.length}>{renderInlineMarkdown(heading[2])}</h3>);
      index += 1;
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      const quoteLines: string[] = [];
      while (index < lines.length) {
        const quoteLine = (lines[index] ?? "").match(/^>\s?(.*)$/);
        if (!quoteLine) break;
        quoteLines.push(quoteLine[1] ?? "");
        index += 1;
      }
      blocks.push(<blockquote key={blocks.length}>{renderInlineMarkdown(quoteLines.join(" "))}</blockquote>);
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (bullet || numbered) {
      const ordered = Boolean(numbered);
      const items: string[] = [];
      while (index < lines.length) {
        const itemLine = lines[index] ?? "";
        const item = ordered ? itemLine.match(/^\s*\d+[.)]\s+(.+)$/) : itemLine.match(/^\s*[-*]\s+(.+)$/);
        if (!item) break;
        items.push(item[1] ?? "");
        index += 1;
      }
      const children = items.map((item, itemIndex) => <li key={itemIndex}>{renderInlineMarkdown(item)}</li>);
      blocks.push(ordered ? <ol key={blocks.length}>{children}</ol> : <ul key={blocks.length}>{children}</ul>);
      continue;
    }

    const paragraph: string[] = [line];
    index += 1;
    while (
      index < lines.length &&
      (lines[index] ?? "").trim() &&
      !/^```\s*[\w-]*\s*$/.test(lines[index] ?? "") &&
      !/^(#{1,3})\s+/.test(lines[index] ?? "") &&
      !/^\s*[-*]\s+/.test(lines[index] ?? "") &&
      !/^\s*\d+[.)]\s+/.test(lines[index] ?? "")
    ) {
      paragraph.push(lines[index] ?? "");
      index += 1;
    }
    blocks.push(<p key={blocks.length}>{renderInlineMarkdown(paragraph.join("\n"))}</p>);
  }

  return <div className={className}>{blocks.length ? blocks : <p>{value}</p>}</div>;
}

function attachmentDataUrl(attachment: MessageAttachment) {
  return attachment.dataBase64 && isPreviewableImage(attachment.mimeType) ? `data:${attachment.mimeType};base64,${attachment.dataBase64}` : undefined;
}

function attachmentPreviewUrl(attachment: MessageAttachment) {
  if (!isPreviewableImage(attachment.mimeType)) return undefined;
  return attachmentDataUrl(attachment) ?? attachment.url;
}

function renderMessageAttachments(attachments: MessageAttachment[] | undefined, onPreview: (preview: ImagePreview) => void) {
  if (!attachments?.length) return null;
  return (
    <div className="message-attachments">
      {attachments.map((attachment, index) => {
        const previewUrl = attachmentPreviewUrl(attachment);
        const body = (
          <>
            {previewUrl ? <img alt="" loading="lazy" src={previewUrl} /> : <Paperclip size={16} />}
            <span>
              <strong>{attachment.name}</strong>
              <small>{attachment.mimeType} · {formatBytes(attachment.size)}</small>
            </span>
          </>
        );
        if (previewUrl) {
          return (
            <button
              className="message-attachment image"
              key={attachment.id ?? `${attachment.name}-${index}`}
              type="button"
              onClick={() => onPreview({ src: previewUrl, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size })}
            >
              {body}
            </button>
          );
        }
        if (attachment.url) {
          return (
            <a
              className="message-attachment"
              href={attachment.url}
              key={attachment.id ?? `${attachment.name}-${index}`}
              rel="noreferrer"
              target="_blank"
            >
              {body}
            </a>
          );
        }
        return (
          <div
            className="message-attachment"
            key={attachment.id ?? `${attachment.name}-${index}`}
          >
            {body}
          </div>
        );
      })}
    </div>
  );
}

function PublicChatThread({ payload, onPreview }: { payload: PublicChatPayload; onPreview: (preview: ImagePreview) => void }) {
  return (
    <section className="public-chat-thread">
      <div className="section-head">
        <h2><MessageSquare size={18} /> {payload.chat.title}</h2>
        <span>{payload.jobs.length} runs</span>
      </div>
      {payload.messages.map((message) => (
        <article className={`message ${message.role}`} key={message.id}>
          <div className="message-meta">
            <div className="message-author-stack">
              <span>{message.role === "user" ? "User" : message.role === "system" ? "System" : message.source === "vscode" ? "VS Code" : "Codex"}</span>
              <small>{formatDateTime(message.createdAt)}</small>
            </div>
          </div>
          {message.role === "system" ? (
            <div className="system-message-body" title={normalizeDisplayText(message.content).trim()}>
              {normalizeDisplayText(message.content).trim()}
            </div>
          ) : renderRichText(message.content, "rich-text message-body")}
          {renderMessageAttachments(message.attachments, onPreview)}
        </article>
      ))}
      {!payload.messages.length && <div className="empty small-empty">В этом чате пока нет сообщений.</div>}
    </section>
  );
}

const ADMIN_METRIC_META: Record<AdminStatsMetric, { label: string; color: string }> = {
  dau: { label: "DAU", color: "#0f8f6b" },
  wau: { label: "WAU", color: "#2563eb" },
  mau: { label: "MAU", color: "#7c3aed" },
  registrations: { label: "Регистрации", color: "#c2410c" }
};

function formatAdminDay(day: string) {
  const date = new Date(`${day}T00:00:00`);
  if (Number.isNaN(date.getTime())) return day;
  return date.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
}

function AdminStatsChart({ points, visible }: { points: AdminStatsPoint[]; visible: Record<AdminStatsMetric, boolean> }) {
  const metrics = (Object.keys(ADMIN_METRIC_META) as AdminStatsMetric[]).filter((metric) => visible[metric]);
  const chartWidth = 760;
  const chartHeight = 260;
  const padding = { left: 44, right: 18, top: 18, bottom: 34 };
  const plotWidth = chartWidth - padding.left - padding.right;
  const plotHeight = chartHeight - padding.top - padding.bottom;
  const maxValue = Math.max(1, ...points.flatMap((point) => metrics.map((metric) => point[metric])));
  const xFor = (index: number) => padding.left + (points.length <= 1 ? plotWidth / 2 : (plotWidth * index) / (points.length - 1));
  const yFor = (value: number) => padding.top + plotHeight - (plotHeight * value) / maxValue;
  const ticks = [0, Math.ceil(maxValue / 2), maxValue];

  return (
    <div className="admin-chart-wrap">
      <svg className="admin-chart" viewBox={`0 0 ${chartWidth} ${chartHeight}`} role="img" aria-label="График статистики">
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={padding.left} x2={chartWidth - padding.right} y1={yFor(tick)} y2={yFor(tick)} />
            <text x={padding.left - 10} y={yFor(tick) + 4} textAnchor="end">{tick}</text>
          </g>
        ))}
        {points.length > 0 && (
          <>
            <text x={padding.left} y={chartHeight - 10}>{formatAdminDay(points[0]?.day ?? "")}</text>
            <text x={chartWidth - padding.right} y={chartHeight - 10} textAnchor="end">{formatAdminDay(points[points.length - 1]?.day ?? "")}</text>
          </>
        )}
        {metrics.map((metric) => {
          const pointsText = points.map((point, index) => `${xFor(index)},${yFor(point[metric])}`).join(" ");
          return <polyline fill="none" key={metric} points={pointsText} stroke={ADMIN_METRIC_META[metric].color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />;
        })}
      </svg>
      {!metrics.length && <div className="admin-chart-empty">Включи хотя бы одну линию.</div>}
      {!points.length && <div className="admin-chart-empty">Статистики пока нет.</div>}
    </div>
  );
}

function shareTokenFromLocation() {
  const match = window.location.pathname.match(/^\/share\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1] ?? "") : "";
}

function publicProfileSlugFromLocation() {
  const match = window.location.pathname.match(/^\/u\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1] ?? "") : "";
}

function registrationOpenFromLocation() {
  return new URLSearchParams(window.location.search).get("cango") === "sure";
}

function SharedChatPage({ token }: { token: string }) {
  const [share, setShare] = useState<SharedChat | null>(null);
  const [notice, setNotice] = useState("Загружаю публичный чат...");
  const [imagePreview, setImagePreview] = useState<ImagePreview | null>(null);

  useEffect(() => {
    let cancelled = false;
    api(`/api/shared/chats/${encodeURIComponent(token)}`)
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (cancelled) return;
        if (!response.ok) {
          setNotice(data.error === "not_found" ? "Ссылка на чат не найдена." : data.error || "Не удалось загрузить публичный чат.");
          return;
        }
        setShare(data.share);
        setNotice("");
      })
      .catch(() => {
        if (!cancelled) setNotice("Не удалось загрузить публичный чат.");
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const finalAnswer = share?.snapshot.finalAnswer || share?.finalContent || "";
  const messages = share?.snapshot.messages ?? [];
  const projectLink = share?.project?.url || projectUrl(share?.project?.domain ?? "");

  return (
    <main className="share-page">
      <header className="share-hero">
        <div>
          <img className="brand-logo" src="/favicon.svg" alt="" />
          <span>codex.rodion.pro</span>
        </div>
        <h1>{share?.title ?? "Shared Codex chat"}</h1>
        {share && (
          <p>
            {share.source} chat · exported {formatDateTime(share.snapshot.exportedAt || share.updatedAt)}
          </p>
        )}
        {share?.project?.domain && projectLink && (
          <a className="share-project-link" href={projectLink} target="_blank" rel="noreferrer">
            <ExternalLink size={17} />
            <span>Открыть результат</span>
            <strong>{share.project.domain}</strong>
          </a>
        )}
      </header>

      {notice && <section className="share-card">{notice}</section>}

      {share && (
        <>
          {finalAnswer && (
            <section className="share-card final-answer">
              <span>Final answer</span>
              {renderRichText(finalAnswer, "rich-text message-body")}
            </section>
          )}

          <section className="share-chat">
            {messages.map((message) => (
              <article className={`message ${message.role}`} key={message.id}>
                <div className="message-meta">
                  <div className="message-author-stack">
                    <span>{message.role === "user" ? "User" : message.source === "vscode" ? "VS Code" : "Codex"}</span>
                    <small>{formatDateTime(message.createdAt)}</small>
                  </div>
                </div>
                {message.role === "system" ? (
                  <div className="system-message-body" title={normalizeDisplayText(message.content).trim()}>
                    {normalizeDisplayText(message.content).trim()}
                  </div>
                ) : renderRichText(message.content, "rich-text message-body")}
                {renderMessageAttachments(message.attachments, setImagePreview)}
              </article>
            ))}
          </section>
        </>
      )}

      {imagePreview && (
        <div className="image-lightbox" role="dialog" aria-modal="true" aria-label={imagePreview.name} onClick={() => setImagePreview(null)}>
          <figure onClick={(event) => event.stopPropagation()}>
            <button aria-label="Close image preview" type="button" onClick={() => setImagePreview(null)}>
              <X size={20} />
            </button>
            <img alt={imagePreview.name} src={imagePreview.src} />
            <figcaption>
              <strong>{imagePreview.name}</strong>
              <span>{imagePreview.mimeType} · {formatBytes(imagePreview.size)}</span>
            </figcaption>
          </figure>
        </div>
      )}
    </main>
  );
}

function PublicProfilePage({ slug }: { slug: string }) {
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [projects, setProjects] = useState<PublicProject[]>([]);
  const [openedChat, setOpenedChat] = useState<PublicChatPayload | null>(null);
  const [notice, setNotice] = useState("Загружаю профиль...");
  const [imagePreview, setImagePreview] = useState<ImagePreview | null>(null);

  useEffect(() => {
    let cancelled = false;
    api(`/api/public/profiles/${encodeURIComponent(slug)}`)
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (cancelled) return;
        if (!response.ok) {
          setNotice(data.error === "not_found" ? "Профиль не найден." : data.error || "Не удалось загрузить профиль.");
          return;
        }
        setProfile(data.profile);
        setProjects(data.projects ?? []);
        setNotice("");
      })
      .catch(() => {
        if (!cancelled) setNotice("Не удалось загрузить профиль.");
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  async function openPublicChat(chat: Chat) {
    setNotice("");
    const response = await api(`/api/public/chats/${encodeURIComponent(chat.id)}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      setNotice(data.error || "Не удалось открыть чат.");
      return;
    }
    setOpenedChat({ chat: data.chat, messages: data.messages ?? [], jobs: data.jobs ?? [] });
  }

  const stats = profile?.stats ?? { chats: 0, jobs: 0, completedJobs: 0, failedJobs: 0, projects: 0, generationSeconds: 0 };
  const displayName = profile?.nickname || profile?.email || "Profile";

  return (
    <main className="share-page public-profile-page">
      <header className="share-hero">
        <div>
          <img className="brand-logo" src="/favicon.svg" alt="" />
          <span>codex.rodion.pro</span>
        </div>
        <h1>{displayName}</h1>
        {profile && <p>{profile.email} · зарегистрирован {formatDateTime(profile.createdAt) || "unknown"}</p>}
      </header>

      {notice && <section className="share-card">{notice}</section>}

      {profile && (
        <>
          <section className="public-profile-card">
            <div className="profile-avatar">
              {profile.avatarDataUrl ? <img alt="" src={profile.avatarDataUrl} /> : <UserCircle size={54} />}
            </div>
            <div>
              <h2>{displayName}</h2>
              <p>{profile.bio || "Описание профиля пока не заполнено."}</p>
              <a className="secondary compact" href={profile.profileUrl}><Link2 size={15} /> {profile.profileUrl}</a>
            </div>
          </section>

          <section className="profile-grid public-profile-stats">
            <div className="stat-card"><MessageSquare size={18} /><span>Chats</span><strong>{stats.chats}</strong></div>
            <div className="stat-card"><Activity size={18} /><span>Runs</span><strong>{stats.jobs}</strong></div>
            <div className="stat-card"><CheckCircle2 size={18} /><span>Completed</span><strong>{stats.completedJobs}</strong></div>
            <div className="stat-card"><FolderGit2 size={18} /><span>Projects</span><strong>{stats.projects}</strong></div>
            <div className="stat-card"><Link2 size={18} /><span>Public</span><strong>{profile.publicProjects}</strong></div>
            <div className="stat-card wide"><Clock3 size={18} /><span>Generation time</span><strong>{formatDuration(stats.generationSeconds)}</strong></div>
          </section>

          <section className="public-projects">
            <div className="section-head">
              <h2><FolderGit2 size={18} /> Публичные проекты</h2>
              <span>{projects.length}</span>
            </div>
            {projects.map((project) => (
              <article className="public-project-card" key={`${project.agentId}:${project.id}`}>
                <div>
                  <h3>{project.name}</h3>
                  <p>{project.domain || project.githubUrl || "Без публичного домена"}</p>
                </div>
                <div className="public-project-actions">
                  {project.url && <a className="secondary compact" href={project.url} target="_blank" rel="noreferrer"><ExternalLink size={15} /> Open</a>}
                  <span>{project.chatCount} chats</span>
                </div>
                <div className="public-chat-pills">
                  {project.latestChats.map((chat) => (
                    <button key={chat.id} type="button" onClick={() => void openPublicChat(chat)}>{chat.title}</button>
                  ))}
                  {!project.latestChats.length && <span className="small-empty">Публичных чатов пока нет.</span>}
                </div>
              </article>
            ))}
            {!projects.length && <div className="share-card">У пользователя пока нет публичных проектов.</div>}
          </section>

          {openedChat && <PublicChatThread payload={openedChat} onPreview={setImagePreview} />}
        </>
      )}

      {imagePreview && (
        <div className="image-lightbox" role="dialog" aria-modal="true" aria-label={imagePreview.name} onClick={() => setImagePreview(null)}>
          <figure onClick={(event) => event.stopPropagation()}>
            <button aria-label="Close image preview" type="button" onClick={() => setImagePreview(null)}>
              <X size={20} />
            </button>
            <img alt={imagePreview.name} src={imagePreview.src} />
            <figcaption>
              <strong>{imagePreview.name}</strong>
              <span>{imagePreview.mimeType} · {formatBytes(imagePreview.size)}</span>
            </figcaption>
          </figure>
        </div>
      )}
    </main>
  );
}

function summarizeDisplayCommand(command: string) {
  return command
    .replace(/"C:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe"\s+-Command\s+/i, "")
    .replace(/^powershell(?:\.exe)?\s+-Command\s+/i, "")
    .replace(/\s+/g, " ")
    .slice(0, 180);
}

function messageJobId(message: ChatMessage) {
  const metadataJobId = typeof message.metadata?.jobId === "string" ? message.metadata.jobId : "";
  return metadataJobId || message.externalId?.match(/^job:([^:]+):/)?.[1] || "";
}

function isJobFinished(job: Job) {
  return Boolean(job.finishedAt && !["queued", "assigned", "running"].includes(job.status));
}

function isJobRunning(job: Job) {
  return ["queued", "assigned", "running"].includes(job.status);
}

function isTerminalJobStatus(status: string) {
  return !["queued", "assigned", "running"].includes(status);
}

function jobProgressLabel(progress: JobProgress | null | undefined, fallback = "Выполняется") {
  switch ((progress?.phase ?? "").toLowerCase()) {
    case "queued":
      return "В очереди";
    case "assigned":
      return "Назначено";
    case "starting":
      return "Запускаю Codex";
    case "started":
      return "Открываю thread";
    case "thinking":
      return "Codex пишет";
    case "command":
      return "Выполняю команду";
    case "working":
      return "Codex работает";
    case "message":
      return "Ответ";
    case "finalizing":
      return "Сохраняю результат";
    case "completed":
      return "Синхронизирую";
    case "failed":
      return "Ошибка";
    case "cancelled":
      return "Остановлено";
    default:
      return fallback;
  }
}

function jobProgressMessage(progress: JobProgress | null | undefined) {
  const phase = (progress?.phase ?? "").toLowerCase();
  const message = progress?.message?.trim() ?? "";
  if (phase === "thinking") return "Жду ответ локального Codex";
  if (phase === "working") return hasProgressChanges(progress) ? "Проверяю изменения в рабочей папке" : "Жду следующего события от локального Codex";
  if (phase === "finalizing") return "Собираю git diff и сохраняю ответ в web";
  if (phase === "completed") return "Финальный ответ получен, обновляю чат";
  if (message) return message;
  return "Задача ещё активна";
}

function isJobPromptMessage(message: ChatMessage, jobId: string) {
  return message.externalId === `job:${jobId}:prompt` || (message.role === "user" && messageJobId(message) === jobId);
}

function isJobFinalMessage(message: ChatMessage, jobId: string) {
  return message.externalId === `job:${jobId}:final` || (
    message.role === "assistant"
    && messageJobId(message) === jobId
    && typeof message.metadata?.status === "string"
  );
}

function shouldCollapseRunMessage(message: ChatMessage, jobId: string) {
  if (isJobFinalMessage(message, jobId) || isJobPromptMessage(message, jobId)) return false;
  return message.role === "assistant" || message.role === "tool";
}

function shouldCollapseCompletedTurnMessage(message: ChatMessage) {
  return message.role === "assistant" || message.role === "tool";
}

function messageTimeMs(value: string | undefined | null, fallback: number) {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function messageRoleOrder(message: ChatMessage) {
  if (message.role === "user") return 0;
  if (message.role === "system" || message.role === "tool") return 1;
  return 2;
}

function orderChatMessagesForDisplay(messages: ChatMessage[], jobs: Job[]) {
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  return messages
    .map((message, index) => {
      const createdMs = messageTimeMs(message.createdAt, index);
      const jobId = messageJobId(message);
      const job = jobId ? jobsById.get(jobId) : undefined;
      let turnMs = createdMs;

      if (job && isJobPromptMessage(message, job.id)) {
        turnMs = messageTimeMs(job.createdAt, createdMs);
      } else if (job && isJobFinalMessage(message, job.id)) {
        turnMs = messageTimeMs(job.finishedAt, createdMs);
      } else if ((message.role === "assistant" || message.role === "tool") && typeof message.metadata?.startedAt === "string") {
        turnMs = messageTimeMs(message.metadata.startedAt, createdMs) + 1;
      }

      return { message, index, turnMs, createdMs };
    })
    .sort((left, right) =>
      left.turnMs - right.turnMs
      || messageRoleOrder(left.message) - messageRoleOrder(right.message)
      || left.createdMs - right.createdMs
      || left.index - right.index
    )
    .map((entry) => entry.message);
}

const CHAT_TOP_THRESHOLD_PX = 120;
const CHAT_BOTTOM_THRESHOLD_PX = 16;
const CHAT_SYNC_REFRESH_MIN_MS = 10000;
const CHAT_LIST_REFRESH_MIN_MS = 8000;

function displayLogMessage(log: Log) {
  const rawText = log.message.trim();
  if (!rawText) return null;
  if (/ERROR\s+codex_core::session:\s+failed to record rollout items:\s+thread .* not found/i.test(rawText)) return null;
  if (log.stream === "system") return null;
  try {
    const event = JSON.parse(rawText) as Record<string, unknown>;
    const item = event.item && typeof event.item === "object" ? event.item as Record<string, unknown> : undefined;
    const type = typeof event.type === "string" ? event.type : "";
    if (type === "thread.started") return "Codex thread started.";
    if (type === "turn.started") return "Codex is thinking.";
    if (type === "item.started" && item?.type === "command_execution") {
      return `Running: ${summarizeDisplayCommand(String(item.command ?? "command"))}`;
    }
    if (type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") {
      return normalizeDisplayText(item.text).trim();
    }
    if (type === "item.completed" && item?.type === "command_execution") {
      const command = summarizeDisplayCommand(String(item.command ?? "command"));
      const status = String(item.status ?? "completed");
      const output = typeof item.aggregated_output === "string" ? normalizeDisplayText(item.aggregated_output).trim() : "";
      return [output ? `${command}: ${status}.` : `${command}: ${status}.`, output].filter(Boolean).join("\n\n");
    }
    return type ? `Codex event: ${type}` : null;
  } catch {
    return normalizeDisplayText(rawText).trim();
  }
}

function codexActionEntries(logs: Log[]): CodexAction[] {
  const byId = new Map<string, CodexAction>();
  const activeSystemCommands: string[] = [];
  logs.forEach((log, index) => {
    const rawText = log.message.trim();
    if (!rawText) return;
    const completed = rawText.match(/^(.+):\s*(completed|failed|cancelled)\.$/i);
    if (completed?.[1]) {
      const command = completed[1].trim();
      const status = completed[2]?.toLowerCase() ?? "completed";
      const activeId = [...activeSystemCommands].reverse().find((id) => byId.get(id)?.command === command && byId.get(id)?.status === "running");
      const id = activeId ?? `system:${log.at}:${index}`;
      const current = byId.get(id);
      byId.set(id, { id, command, status, output: current?.output ?? "", at: log.at });
      return;
    }
    if (log.stream === "system") {
      const running = rawText.match(/^Running:\s*(.+)$/i);
      if (running?.[1]) {
        const command = running[1].trim();
        const id = `system:${log.at}:${index}`;
        activeSystemCommands.push(id);
        byId.set(id, { id, command, status: "running", output: "", at: log.at });
        return;
      }
      return;
    }
    if (!rawText.startsWith("{")) return;
    try {
      const event = JSON.parse(rawText) as Record<string, unknown>;
      const item = event.item && typeof event.item === "object" ? event.item as Record<string, unknown> : undefined;
      if (item?.type !== "command_execution") return;
      const id = typeof item.id === "string" ? item.id : `${log.at}:${index}`;
      const current = byId.get(id);
      const command = summarizeDisplayCommand(String(item.command ?? current?.command ?? "command"));
      const output = typeof item.aggregated_output === "string" ? normalizeDisplayText(item.aggregated_output).trim() : current?.output ?? "";
      byId.set(id, {
        id,
        command,
        output,
        status: String(item.status ?? current?.status ?? (event.type === "item.started" ? "running" : "completed")),
        at: log.at
      });
    } catch {
      // Non-JSON lines are rendered in the raw log panel instead.
    }
  });
  return [...byId.values()];
}

function liveActivityEntries(logs: Log[]): LiveActivityEntry[] {
  const entries: LiveActivityEntry[] = [];
  const commandEntries = new Map<string, LiveActivityEntry>();
  const commandIds: string[] = [];
  const seenMessages = new Set<string>();
  let outputTargetId = "";
  let outputTargetUntil = 0;

  const appendCommandOutput = (text: string, atMs: number) => {
    const target = outputTargetId ? commandEntries.get(outputTargetId)?.action : undefined;
    if (!target) return false;
    target.output = [target.output, text].filter(Boolean).join("\n\n").slice(-6000);
    if (Number.isFinite(atMs)) outputTargetUntil = Math.max(outputTargetUntil, atMs + 1800);
    return true;
  };

  logs.forEach((log, index) => {
    const rawText = log.message.trim();
    if (!rawText) return;
    const atMs = Date.parse(log.at);

    const completed = rawText.match(/^(.+):\s*(completed|failed|cancelled)\.$/i);
    if (completed?.[1]) {
      const command = completed[1].trim();
      const status = completed[2]?.toLowerCase() ?? "completed";
      const id = [...commandIds].reverse().find((commandId) => commandEntries.get(commandId)?.action?.command === command && commandEntries.get(commandId)?.action?.status === "running");
      let entry = id ? commandEntries.get(id) : undefined;
      if (!entry) {
        const completedId = `live-command:${log.at}:${index}`;
        entry = {
          id: completedId,
          kind: "command",
          at: log.at,
          action: { id: completedId, command, status, output: "", at: log.at }
        };
        entries.push(entry);
        commandEntries.set(completedId, entry);
        commandIds.push(completedId);
      }
      if (entry?.action) {
        entry.action.status = status;
        entry.action.at = log.at;
        entry.at = log.at;
        outputTargetId = entry.id;
        outputTargetUntil = Number.isFinite(atMs) ? atMs + 3500 : Date.now() + 3500;
      }
      return;
    }

    if (log.stream === "system") {
      const running = rawText.match(/^Running:\s*(.+)$/i);
      if (running?.[1]) {
        const command = running[1].trim();
        const id = `live-command:${log.at}:${index}`;
        const entry: LiveActivityEntry = {
          id,
          kind: "command",
          at: log.at,
          action: { id, command, status: "running", output: "", at: log.at }
        };
        entries.push(entry);
        commandEntries.set(id, entry);
        commandIds.push(id);
        outputTargetId = "";
        outputTargetUntil = 0;
        return;
      }
      return;
    }

    const display = displayLogMessage(log);
    if (!display) return;
    if (outputTargetId && Number.isFinite(atMs) && atMs <= outputTargetUntil && appendCommandOutput(display, atMs)) return;

    if (log.stream === "stderr") {
      entries.push({
        id: log.id ?? `live-error:${log.at}:${index}`,
        kind: "error",
        at: log.at,
        text: display
      });
      return;
    }

    const normalized = normalizeDisplayText(display).trim();
    const messageKey = normalized.replace(/\s+/g, " ").slice(0, 700);
    if (!messageKey || seenMessages.has(messageKey)) return;
    seenMessages.add(messageKey);
    entries.push({
      id: log.id ?? `live-message:${log.at}:${index}`,
      kind: "message",
      at: log.at,
      text: normalized
    });
  });

  return entries.slice(-14);
}

function metadataCodexActions(message: ChatMessage): CodexAction[] {
  const raw = message.metadata?.codexActions;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const value = item as Record<string, unknown>;
    const command = typeof value.command === "string" ? value.command.trim() : "";
    if (!command) return [];
    return [{
      id: typeof value.id === "string" ? value.id : `${message.id}:action:${index}`,
      command: summarizeDisplayCommand(command),
      status: typeof value.status === "string" ? value.status : "completed",
      output: typeof value.output === "string" ? normalizeDisplayText(value.output).trim() : "",
      at: typeof value.at === "string" ? value.at : message.createdAt
    }];
  });
}

function buildChatTimeline(messages: ChatMessage[], jobs: Job[], keepLatestTurnExpanded = false): ChatTimelineItem[] {
  const orderedMessages = orderChatMessagesForDisplay(messages, jobs);
  const hiddenMessageIds = new Set<string>();
  const collapsedByFinalId = new Map<string, CollapsedRunSummary>();
  const collapseMessages = (finalMessage: ChatMessage, collapsedMessages: ChatMessage[], job?: Job) => {
    const nextMessages = collapsedMessages.filter((message) => !hiddenMessageIds.has(message.id));
    if (!nextMessages.length) return;
    nextMessages.forEach((message) => hiddenMessageIds.add(message.id));
    const existing = collapsedByFinalId.get(finalMessage.id);
    const mergedMessages = existing ? [...existing.messages, ...nextMessages] : nextMessages;
    const uniqueMessages = [...new Map(mergedMessages.map((message) => [message.id, message])).values()]
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
    const firstStepAt = Date.parse(uniqueMessages[0]?.createdAt ?? finalMessage.createdAt);
    const finalAt = Date.parse(finalMessage.createdAt);
    collapsedByFinalId.set(finalMessage.id, {
      job: job ?? existing?.job,
      messages: uniqueMessages,
      commandCount: uniqueMessages.reduce((total, message) => total + metadataCodexActions(message).length, 0),
      durationSeconds: job
        ? jobDurationSeconds(job)
        : Number.isFinite(firstStepAt) && Number.isFinite(finalAt)
          ? Math.max(0, Math.floor((finalAt - firstStepAt) / 1000))
          : existing?.durationSeconds ?? 0
    });
  };
  const completedJobs = jobs
    .filter(isJobFinished)
    .slice()
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));

  for (const job of completedJobs) {
    const promptIndex = orderedMessages.findIndex((message) => isJobPromptMessage(message, job.id));
    const finalIndex = orderedMessages.findIndex((message) => isJobFinalMessage(message, job.id));
    if (finalIndex < 0) continue;
    const startIndex = promptIndex >= 0 ? promptIndex : orderedMessages.findIndex((message) => Date.parse(message.createdAt) >= Date.parse(job.createdAt));
    const from = startIndex >= 0 ? startIndex + 1 : 0;
    const collapsedMessages = orderedMessages
      .slice(from, finalIndex)
      .filter((message) => shouldCollapseRunMessage(message, job.id))
      .filter((message) => !hiddenMessageIds.has(message.id));
    collapseMessages(orderedMessages[finalIndex]!, collapsedMessages, job);
  }

  for (let index = 0; index < orderedMessages.length; index += 1) {
    if (orderedMessages[index]?.role !== "user") continue;
    const nextUserIndex = orderedMessages.findIndex((message, nextIndex) => nextIndex > index && message.role === "user");
    const segmentEnd = nextUserIndex >= 0 ? nextUserIndex : orderedMessages.length;
    if (keepLatestTurnExpanded && segmentEnd === orderedMessages.length) continue;
    const segment = orderedMessages.slice(index + 1, segmentEnd).filter((message) => !hiddenMessageIds.has(message.id));
    const finalMessage = segment.slice().reverse().find((message) => message.role === "assistant");
    if (!finalMessage || collapsedByFinalId.has(finalMessage.id)) continue;
    const finalIndex = orderedMessages.findIndex((message) => message.id === finalMessage.id);
    const collapsedMessages = orderedMessages
      .slice(index + 1, finalIndex)
      .filter((message) => !hiddenMessageIds.has(message.id))
      .filter(shouldCollapseCompletedTurnMessage);
    collapseMessages(finalMessage, collapsedMessages);
  }

  return orderedMessages
    .filter((message) => !hiddenMessageIds.has(message.id))
    .map((message) => ({
      message,
      collapsedRun: collapsedByFinalId.get(message.id)
    }));
}

function mergeJobs(current: Job[], incoming: Job[]) {
  const byId = new Map(current.map((job) => [job.id, job]));
  incoming.forEach((job) => {
    const existing = byId.get(job.id);
    if (existing && job.gitDiffOmitted && existing.gitDiff && !job.gitDiff) {
      byId.set(job.id, {
        ...existing,
        ...job,
        gitDiff: existing.gitDiff,
        gitDiffStat: job.gitDiffStat ?? existing.gitDiffStat,
        gitDiffOmitted: false
      });
      return;
    }
    byId.set(job.id, job);
  });
  return [...byId.values()].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

function mergeChatMessages(current: ChatMessage[], incoming: ChatMessage[]) {
  const byId = new Map(current.map((message) => [message.id, message]));
  return incoming.map((message) => {
    const existing = byId.get(message.id);
    if (!existing?.metadata) return message;
    const incomingMetadata = message.metadata ?? {};
    if (!incomingMetadata.metadataOmitted && !incomingMetadata.gitDiffOmitted) return message;
    const metadata = { ...existing.metadata, ...incomingMetadata };
    if (incomingMetadata.gitDiffOmitted && typeof existing.metadata.gitDiff === "string" && typeof incomingMetadata.gitDiff !== "string") {
      metadata.gitDiff = existing.metadata.gitDiff;
      metadata.gitDiffStat = incomingMetadata.gitDiffStat ?? existing.metadata.gitDiffStat;
      metadata.gitDiffOmitted = false;
    }
    if (incomingMetadata.metadataOmitted && Array.isArray(existing.metadata.codexActions) && !Array.isArray(incomingMetadata.codexActions)) {
      metadata.codexActions = existing.metadata.codexActions;
      metadata.metadataOmitted = false;
    }
    return { ...message, metadata };
  });
}

function progressMapFromJobs(jobs: Job[]) {
  const entries = jobs
    .map((job) => job.progress ? [job.id, job.progress] as const : null)
    .filter((entry): entry is readonly [string, JobProgress] => Boolean(entry));
  return Object.fromEntries(entries);
}

function messageUpdateSignature(message: ChatMessage) {
  const actionCount = Array.isArray(message.metadata?.codexActions) ? message.metadata.codexActions.length : 0;
  const changeStat = typeof message.metadata?.gitDiffStat === "string" ? message.metadata.gitDiffStat.length : 0;
  const changeDiff = typeof message.metadata?.gitDiff === "string" ? message.metadata.gitDiff.length : 0;
  return [
    message.id,
    message.createdAt,
    message.content.length,
    message.attachments?.length ?? 0,
    actionCount,
    changeStat,
    changeDiff
  ].join(":");
}

type ProjectOperationKind = "git-sync" | "deploy";

function isProjectOperationMessage(message: ChatMessage) {
  return message.role === "system" && message.metadata?.kind === "project-operation";
}

function projectOperationLabel(message: ChatMessage) {
  return typeof message.metadata?.operationLabel === "string" ? message.metadata.operationLabel : "Project action";
}

function safeMarkdownInlineCode(value: string) {
  return value.replace(/`/g, "'").trim();
}

function projectOperationPendingContent(label: string, repoName: string, details: string[] = []) {
  return [
    `**${label} запущен**`,
    "",
    `Проект: \`${safeMarkdownInlineCode(repoName)}\`.`,
    ...details.map((detail) => detail.trim()).filter(Boolean),
    "Статус: выполняется."
  ].join("\n");
}

function App() {
  const registrationOpen = useMemo(registrationOpenFromLocation, []);
  const isAdminRoute = useMemo(() => window.location.pathname.replace(/\/+$/g, "") === "/admin", []);
  const [csrf, setCsrf] = useState<string>();
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [registerNickname, setRegisterNickname] = useState("");
  const [authNotice, setAuthNotice] = useState("");
  const [authOauthProviders, setAuthOauthProviders] = useState<OAuthProvider[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [chats, setChats] = useState<Chat[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [allJobs, setAllJobs] = useState<Job[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activeJob, setActiveJob] = useState<Job | null>(null);
  const [logs, setLogs] = useState<Log[]>([]);
  const [progressByJob, setProgressByJob] = useState<Record<string, JobProgress>>({});
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [repoKey, setRepoKey] = useState("");
  const [activeChatId, setActiveChatId] = useState("");
  const [chatLoadingId, setChatLoadingId] = useState("");
  const [chatLoadingProgress, setChatLoadingProgress] = useState<ChatLoadingProgress | null>(null);
  const [sandbox, setSandbox] = useState<Sandbox>("danger-full-access");
  const [busy, setBusy] = useState(false);
  const [localChatSyncing, setLocalChatSyncing] = useState(false);
  const [projectPanel, setProjectPanel] = useState<"new" | "settings" | null>(null);
  const [projectName, setProjectName] = useState("");
  const [projectAgentId, setProjectAgentId] = useState("");
  const [projectPath, setProjectPath] = useState("");
  const [projectGithubUrl, setProjectGithubUrl] = useState("");
  const [projectServerPath, setProjectServerPath] = useState("");
  const [projectDomain, setProjectDomain] = useState("");
  const [projectVisibility, setProjectVisibility] = useState<ProjectVisibility>("private");
  const [projectDeployMode, setProjectDeployMode] = useState<"ssh" | "local">("ssh");
  const [projectDeploySshTarget, setProjectDeploySshTarget] = useState("");
  const [projectDeploySourceDir, setProjectDeploySourceDir] = useState("dist");
  const [projectDeployRemoteSubdir, setProjectDeployRemoteSubdir] = useState("");
  const [projectDeployBuildCommand, setProjectDeployBuildCommand] = useState(defaultBuildCommandForAgent(null));
  const [projectDeployCleanRemote, setProjectDeployCleanRemote] = useState(false);
  const [projectDeployEnabled, setProjectDeployEnabled] = useState(true);
  const [projectDataLocation, setProjectDataLocation] = useState<ProjectDataLocation>("local");
  const [projectDataPath, setProjectDataPath] = useState("");
  const [projectStartPrompt, setProjectStartPrompt] = useState("");
  const [projectWizardStep, setProjectWizardStep] = useState<ProjectWizardStep>("project");
  const [sandboxMenuOpen, setSandboxMenuOpen] = useState(false);
  const [actionMenuOpen, setActionMenuOpen] = useState(false);
  const [projectActionsOpen, setProjectActionsOpen] = useState(false);
  const [codexModel, setCodexModel] = useState("gpt-5.5");
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>("high");
  const [codexSpeed, setCodexSpeed] = useState<CodexSpeed>("standard");
  const [originalProjectPath, setOriginalProjectPath] = useState("");
  const [chatTitle, setChatTitle] = useState("");
  const [chatMenuId, setChatMenuId] = useState("");
  const [renamingChatId, setRenamingChatId] = useState("");
  const [renameTitle, setRenameTitle] = useState("");
  const [chatProperties, setChatProperties] = useState<Chat | null>(null);
  const [chatSettingsTitle, setChatSettingsTitle] = useState("");
  const [linkedChatId, setLinkedChatId] = useState("");
  const [hiddenLocalChats, setHiddenLocalChats] = useState<Chat[]>([]);
  const [gitMessage, setGitMessage] = useState("Update project");
  const [gitRemoteUrl, setGitRemoteUrl] = useState("");
  const [gitNotice, setGitNotice] = useState("");
  const [gitBusy, setGitBusy] = useState(false);
  const [deployNotice, setDeployNotice] = useState("");
  const [deployBusy, setDeployBusy] = useState(false);
  const [nginxNotice, setNginxNotice] = useState("");
  const [nginxBusy, setNginxBusy] = useState(false);
  const [sslNotice, setSslNotice] = useState("");
  const [sslBusy, setSslBusy] = useState(false);
  const [launchNotice, setLaunchNotice] = useState("");
  const [launchBusy, setLaunchBusy] = useState(false);
  const [vscodeNotice, setVscodeNotice] = useState("");
  const [vscodeBusy, setVscodeBusy] = useState(false);
  const [shareBusy, setShareBusy] = useState(false);
  const [chatNotice, setChatNotice] = useState("");
  const [chatNoticeOk, setChatNoticeOk] = useState(false);
  const [projectNotice, setProjectNotice] = useState("");
  const [attachmentNotice, setAttachmentNotice] = useState("");
  const [view, setView] = useState<"projects" | "search" | "settings" | "profile" | "sync">("projects");
  const [syncRepoKey, setSyncRepoKey] = useState("");
  const [syncNotice, setSyncNotice] = useState("");
  const [searchType, setSearchType] = useState<"projects" | "profiles">("projects");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchProjects, setSearchProjects] = useState<PublicProject[]>([]);
  const [searchProfiles, setSearchProfiles] = useState<PublicProfile[]>([]);
  const [searchNotice, setSearchNotice] = useState("");
  const [searchOpenedChat, setSearchOpenedChat] = useState<PublicChatPayload | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [profileStatsData, setProfileStatsData] = useState<ProfileStats | null>(null);
  const [oauthProviders, setOauthProviders] = useState<OAuthProvider[]>([]);
  const [profileNickname, setProfileNickname] = useState("");
  const [profileBio, setProfileBio] = useState("");
  const [profileAvatarDataUrl, setProfileAvatarDataUrl] = useState("");
  const [profileNotice, setProfileNotice] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newUserEmail, setNewUserEmail] = useState("");
  const [newUserPassword, setNewUserPassword] = useState("");
  const [newUserRole, setNewUserRole] = useState<"admin" | "user">("user");
  const [newAgentName, setNewAgentName] = useState("My Windows Agent");
  const [newAgentId, setNewAgentId] = useState("");
  const [newAgentUserId, setNewAgentUserId] = useState("");
  const [agentSetup, setAgentSetup] = useState<AgentSetup | null>(null);
  const [settingsNotice, setSettingsNotice] = useState("");
  const [uiTheme, setUiTheme] = useState<UiTheme>(() => {
    try {
      const stored = localStorage.getItem("cmc.uiTheme");
      if (isUiTheme(stored)) return stored;
    } catch {
      // Ignore blocked storage.
    }
    return "paper";
  });
  const [imagePreview, setImagePreview] = useState<ImagePreview | null>(null);
  const [expandedActions, setExpandedActions] = useState<Record<string, boolean>>({});
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [localBusyHold, setLocalBusyHold] = useState<{ until: number; since?: string; key?: string }>({ until: 0 });
  const [highlightedMessageIds, setHighlightedMessageIds] = useState<Set<string>>(() => new Set());
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [showChatScrollTop, setShowChatScrollTop] = useState(false);
  const [showChatScrollBottom, setShowChatScrollBottom] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [adminTab, setAdminTab] = useState<"users" | "stats">("users");
  const [adminUsers, setAdminUsers] = useState<AdminUser[]>([]);
  const [adminSelectedUserId, setAdminSelectedUserId] = useState("");
  const [adminChats, setAdminChats] = useState<AdminChat[]>([]);
  const [adminOpenedChat, setAdminOpenedChat] = useState<{ chat: Chat; messages: ChatMessage[]; jobs: Job[] } | null>(null);
  const [adminPassword, setAdminPassword] = useState("");
  const [adminNotice, setAdminNotice] = useState("");
  const [adminStats, setAdminStats] = useState<AdminStatsPoint[]>([]);
  const [adminStatsVisible, setAdminStatsVisible] = useState<Record<AdminStatsMetric, boolean>>({
    dau: true,
    wau: true,
    mau: true,
    registrations: true
  });

  const selectedRepo = useMemo(() => repos.find((repo) => `${repo.agentId}:${repo.id}` === repoKey), [repoKey, repos]);
  const selectedProjectUrl = useMemo(() => projectUrl(selectedRepo?.domain), [selectedRepo?.domain]);
  const recentProjectChats = useMemo(() => chats.slice().sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)).slice(0, 5), [chats]);
  const agentNameById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent.name])), [agents]);
  const syncRepo = useMemo(() => (
    repos.find((repo) => `${repo.agentId}:${repo.id}` === syncRepoKey)
    ?? selectedRepo
    ?? repos[0]
  ), [repos, selectedRepo, syncRepoKey]);
  const activeChat = useMemo(() => chats.find((chat) => chat.id === activeChatId), [activeChatId, chats]);
  const activeCodexThreadId = useMemo(() => {
    if (activeChat?.externalId) return activeChat.externalId;
    for (let index = jobs.length - 1; index >= 0; index--) {
      const threadId = jobs[index]?.codexThreadId;
      if (threadId) return threadId;
    }
    return "";
  }, [activeChat?.externalId, jobs]);
  const chatIsLoading = Boolean(activeChatId && chatLoadingId === activeChatId);
  const chatLoadingPercent = progressPercent(chatLoadingProgress);
  const chatLoadingDeterminate = Boolean(chatLoadingProgress?.totalBytes);
  const chatLoadingLabel = chatLoadingProgress ? chatLoadingPhaseLabel(chatLoadingProgress.phase) : "Загружаю чат";
  const selectedRepoAgent = selectedRepo ? agents.find((agent) => agent.id === selectedRepo.agentId) : undefined;
  const onlineAgent = agents.find((agent) => agent.status === "online");
  const selectedAgent = selectedRepoAgent ?? onlineAgent ?? agents[0];
  const projectFormAgent = agents.find((agent) => agent.id === projectAgentId) ?? selectedAgent;
  const online = Boolean(selectedAgent && selectedAgent.status === "online");
  const selectedAgentStatusLabel = selectedAgent ? `${selectedAgent.name} ${online ? "online" : "offline"}` : (online ? "Agent online" : "Agent offline");
  const projectDraftDeployConfig = useMemo(() => (
    projectDeployEnabled
      ? buildDeployConfig(projectDeployMode, projectDeploySshTarget, projectDeploySourceDir, projectDeployRemoteSubdir, projectDeployCleanRemote, projectDeployBuildCommand) ?? null
      : null
  ), [projectDeployBuildCommand, projectDeployCleanRemote, projectDeployEnabled, projectDeployMode, projectDeployRemoteSubdir, projectDeploySourceDir, projectDeploySshTarget]);
  const projectDraftDataConfig = useMemo(() => (
    buildProjectDataConfig(projectDataLocation, projectDataPath) ?? null
  ), [projectDataLocation, projectDataPath]);
  const projectWizardStepIndex = PROJECT_WIZARD_STEPS.findIndex((step) => step.id === projectWizardStep);
  const projectWizardCanContinue = projectWizardStep === "project"
    ? Boolean(projectName.trim() && projectPath.trim() && projectFormAgent)
    : projectWizardStep === "deploy"
      ? Boolean(!projectDeployEnabled || projectDraftDeployConfig)
      : projectWizardStep === "data"
        ? Boolean(projectDraftDataConfig)
        : true;
  const projectSettingsNeedsAgent = useMemo(() => {
    if (projectPanel !== "settings" || !selectedRepo) return false;
    const normalizedDomain = normalizeProjectDomain(projectDomain);
    return (
      projectName.trim() !== selectedRepo.name
      || projectPath.trim() !== originalProjectPath
      || projectGithubUrl.trim() !== (selectedRepo.githubUrl ?? "")
      || projectServerPath.trim() !== (selectedRepo.serverPath ?? "")
      || normalizedDomain !== (selectedRepo.domain ?? "")
      || JSON.stringify(projectDraftDeployConfig) !== JSON.stringify(selectedRepo.deploy ?? null)
      || JSON.stringify(projectDraftDataConfig) !== JSON.stringify(selectedRepo.data ?? null)
      || sandbox !== selectedRepo.defaultSandbox
    );
  }, [originalProjectPath, projectDraftDataConfig, projectDraftDeployConfig, projectDomain, projectGithubUrl, projectName, projectPanel, projectPath, projectServerPath, sandbox, selectedRepo]);
  const projectSaveAgentOnline = projectPanel === "new"
    ? projectFormAgent?.status === "online"
    : selectedRepoAgent?.status === "online";
  const canSaveProject = Boolean(!busy && (
    projectPanel === "new"
      ? projectSaveAgentOnline
      : selectedRepo && (!projectSettingsNeedsAgent || projectSaveAgentOnline)
  ));
  const canSaveAndRunProject = Boolean(canSaveProject && projectSaveAgentOnline && projectStartPrompt.trim());
  const repoAgentLabel = (repo: Repo) => agentNameById.get(repo.agentId) ?? repo.agentId;
  const selectedRepoAgentHost = selectedRepoAgent?.hostname?.trim().toLowerCase();
  const onlineAgentOnSameHost = selectedRepoAgent && selectedRepoAgent.status !== "online"
    ? agents.find((agent) => (
      agent.id !== selectedRepoAgent.id
      && agent.status === "online"
      && Boolean(selectedRepoAgentHost)
      && agent.hostname?.trim().toLowerCase() === selectedRepoAgentHost
    ))
    : undefined;
  const localActivity = selectedAgent?.localActivity;
  const activeRunBusy = Boolean(activeJob && ["queued", "assigned", "running"].includes(activeJob.status));
  const runningJobs = useMemo(() => mergeJobs(allJobs, activeJob && activeRunBusy ? [activeJob] : []).filter(isJobRunning), [allJobs, activeJob, activeRunBusy]);
  const webActivityRunning = Boolean(
    localActivity?.source === "codex.rodion.pro"
    && (
      activeRunBusy
      || (selectedAgent?.current_job_id && runningJobs.some((job) => job.id === selectedAgent.current_job_id))
    )
  );
  const localActivityFreshAt = localActivity?.source !== "codex.rodion.pro" && localActivity?.updatedAt
    ? localActivity.updatedAt
    : localActivity?.detectedAt;
  const localActivityFreshTime = Date.parse(localActivityFreshAt || "");
  const localActivityFresh = Number.isFinite(localActivityFreshTime) && nowTick - localActivityFreshTime <= 90000;
  const externalLocalActivityBusy = Boolean(
    localActivity?.source !== "codex.rodion.pro"
    && localActivity?.status === "busy"
    && localActivityFresh
  );
  const staleCurrentWebJob = Boolean(selectedAgent?.current_job_id && selectedAgent.current_job_id === activeJob?.id && !activeRunBusy);
  const staleLocalWebBusy = Boolean(localActivity?.source === "codex.rodion.pro" && !activeRunBusy && activeJob?.finishedAt);
  const rawLocalCodexBusy = Boolean(
    (externalLocalActivityBusy || webActivityRunning)
    && !staleCurrentWebJob
    && !staleLocalWebBusy
  );
  const localBusyActivityKey = rawLocalCodexBusy
    ? [
      localActivity?.source ?? "",
      selectedAgent?.current_job_id ?? "",
      localActivity?.repoId ?? "",
      localActivity?.chatSource ?? "",
      localActivity?.chatExternalId ?? "",
      localActivity?.busySinceAt || localActivity?.updatedAt || localActivity?.detectedAt || ""
    ].join("|")
    : "";
  const localCodexBusy = rawLocalCodexBusy || localBusyHold.until > nowTick;
  const localBusySince = rawLocalCodexBusy
    ? (localBusyHold.key === localBusyActivityKey ? localBusyHold.since : undefined)
      || localActivity?.busySinceAt
      || localActivity?.updatedAt
      || localActivity?.detectedAt
    : localBusyHold.since;
  const thinkingSince = activeRunBusy
    ? activeJob?.startedAt || activeJob?.createdAt
    : localCodexBusy
      ? localBusySince
      : undefined;
  const thinkingSeconds = thinkingSince ? Math.max(0, Math.floor((nowTick - Date.parse(thinkingSince)) / 1000)) : 0;
  const busyChatIds = useMemo(() => new Set(runningJobs.map((job) => job.chatId).filter((chatId): chatId is string => Boolean(chatId))), [runningJobs]);
  const activeBusyChatIds = useMemo(() => {
    const ids = new Set(busyChatIds);
    if (!selectedRepo) return ids;

    runningJobs
      .filter((job) => job.agentId === selectedRepo.agentId && job.repoId === selectedRepo.id)
      .forEach((job) => {
        const chatId = job.chatId || activeChatId;
        if (chatId) ids.add(chatId);
      });

    if (activeJob && activeRunBusy && activeJob.agentId === selectedRepo.agentId && activeJob.repoId === selectedRepo.id) {
      const chatId = activeJob?.chatId || activeChatId;
      if (chatId) ids.add(chatId);
    }
    return ids;
  }, [activeChatId, activeJob, activeRunBusy, busyChatIds, runningJobs, selectedRepo]);
  const localBusyRepoKey = localCodexBusy && localActivity?.repoId && selectedAgent?.id
    ? `${selectedAgent.id}:${localActivity.repoId}`
    : "";
  const localBusyChatTitle = localCodexBusy ? localActivity?.chatTitle?.trim() : undefined;
  const localBusyChatId = useMemo(() => {
    if (!localCodexBusy || !localBusyRepoKey || localBusyRepoKey !== `${selectedRepo?.agentId ?? ""}:${selectedRepo?.id ?? ""}`) return "";
    const chatSource = localActivity?.chatSource;
    const chatExternalId = localActivity?.chatExternalId;
    if (chatSource && chatExternalId) {
      const matchedByExternalId = chats.find((chat) => chat.source === chatSource && chat.externalId === chatExternalId);
      if (matchedByExternalId) return matchedByExternalId.id;
    }
    if (localBusyChatTitle) {
      const matchedByTitle = chats.find((chat) => chat.title === localBusyChatTitle);
      if (matchedByTitle) return matchedByTitle.id;
    }
    return "";
  }, [chats, localActivity?.chatExternalId, localActivity?.chatSource, localBusyChatTitle, localBusyRepoKey, localCodexBusy, selectedRepo?.agentId, selectedRepo?.id]);
  const activeChatLocalBusy = Boolean(localBusyChatId && activeChat?.id === localBusyChatId);
  const busyCountByRepo = useMemo(() => {
    const counts = new Map<string, Set<string>>();
    const addBusy = (repoKeyValue: string, busyKey: string) => {
      const current = counts.get(repoKeyValue) ?? new Set<string>();
      current.add(busyKey);
      counts.set(repoKeyValue, current);
    };
    runningJobs.forEach((job) => addBusy(`${job.agentId}:${job.repoId}`, job.chatId ? `chat:${job.chatId}` : `job:${job.id}`));
    if (localBusyRepoKey) addBusy(localBusyRepoKey, `local:${localActivity?.chatSource ?? "codex"}:${localActivity?.chatExternalId ?? localBusyChatTitle ?? "unknown"}`);
    return new Map([...counts.entries()].map(([key, value]) => [key, value.size]));
  }, [localActivity?.chatExternalId, localActivity?.chatSource, localBusyChatTitle, localBusyRepoKey, runningJobs]);
  const activeChatIdRef = useRef(activeChatId);
  const activeJobIdRef = useRef(activeJob?.id ?? "");
  const activeRunBusyRef = useRef(activeRunBusy);
  const selectedRepoRef = useRef<Repo | undefined>(selectedRepo);
  const loadChatsTimerRef = useRef<number | undefined>(undefined);
  const loadChatTimerRef = useRef<number | undefined>(undefined);
  const loadJobTimerRef = useRef<number | undefined>(undefined);
  const loadAllJobsTimerRef = useRef<number | undefined>(undefined);
  const loadChatsAbortRef = useRef<AbortController | null>(null);
  const loadChatAbortRef = useRef<AbortController | null>(null);
  const loadChatInFlightRef = useRef<{ chatId: string; controller: AbortController; foreground: boolean } | null>(null);
  const wsMessageQueueRef = useRef<any[]>([]);
  const wsFlushRafRef = useRef<number | undefined>(undefined);
  const scrollStateRafRef = useRef<number | undefined>(undefined);
  const localChatSyncRefreshRef = useRef(0);
  const syncAutoPingRef = useRef("");
  const vscodeRequestSeqRef = useRef(0);
  const projectActionBusyRef = useRef<Record<string, boolean>>({});
  const pendingVscodeThreadRefreshRef = useRef<Set<string>>(new Set());
  const chatLoadingStartedRef = useRef(0);
  const shellRef = useRef<HTMLElement | null>(null);
  const chatThreadRef = useRef<HTMLElement | null>(null);
  const composerRef = useRef<HTMLFormElement | null>(null);
  const firstMessageRef = useRef<HTMLElement | null>(null);
  const lastMessageRef = useRef<HTMLElement | null>(null);
  const currentScrollChatRef = useRef("");
  const chatCacheRef = useRef<Map<string, { etag: string; data: ChatPayload }>>(new Map());
  const missingChangeDetailsRequestedRef = useRef<Set<string>>(new Set());
  const previousMessageIdsRef = useRef<Set<string>>(new Set());
  const previousMessageSignaturesRef = useRef<Map<string, string>>(new Map());
  const chatAtBottomRef = useRef(true);
  const chatStickToBottomRef = useRef(true);
  const autoScrollingUntilRef = useRef(0);
  const lastChatListLoadAtRef = useRef<Record<string, number>>({});
  const lastChatLoadAtRef = useRef<Record<string, number>>({});
  const scheduledChatLoadRef = useRef<{ chatId: string; dueAt: number } | null>(null);
  activeChatIdRef.current = activeChatId;
  activeJobIdRef.current = activeJob?.id ?? "";
  activeRunBusyRef.current = activeRunBusy;
  selectedRepoRef.current = selectedRepo;
  const activeProgress = activeJob ? progressByJob[activeJob.id] ?? activeJob.progress ?? {
    jobId: activeJob.id,
    phase: activeJob.status,
    message: activeJob.status === "running" ? "Codex is running." : `Job is ${activeJob.status}.`,
    filesChanged: 0,
    added: 0,
    deleted: 0,
    files: [],
    at: new Date().toISOString()
  } : null;
  const timelineItems = useMemo(() => buildChatTimeline(messages, jobs, activeChatLocalBusy || activeRunBusy), [messages, jobs, activeChatLocalBusy, activeRunBusy]);
  const showChatThinkingIndicator = Boolean(activeChat && !chatIsLoading && (activeChatLocalBusy || activeRunBusy));

  function isScrollableElement(element: HTMLElement | null | undefined): element is HTMLElement {
    if (!element || element.scrollHeight <= element.clientHeight + 1) return false;
    const overflowY = getComputedStyle(element).overflowY;
    return overflowY !== "visible" && overflowY !== "clip";
  }

  function getChatScroller(): HTMLElement {
    const shell = shellRef.current;
    if (isScrollableElement(shell)) return shell;

    const root = document.getElementById("root");
    if (isScrollableElement(root)) return root;

    const scrollingElement = document.scrollingElement as HTMLElement | null;
    if (isScrollableElement(scrollingElement)) return scrollingElement;

    if (isScrollableElement(document.body)) return document.body;

    return (document.scrollingElement || document.documentElement) as HTMLElement;
  }

  function updateChatBottomState(source: "scroll" | "measure" = "measure") {
    const scroller = getChatScroller();
    const distanceToBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    const atBottom = distanceToBottom <= CHAT_BOTTOM_THRESHOLD_PX;
    const atTop = scroller.scrollTop <= CHAT_TOP_THRESHOLD_PX;
    chatAtBottomRef.current = atBottom;
    if (atBottom) chatStickToBottomRef.current = true;
    else if (source === "scroll" && Date.now() > autoScrollingUntilRef.current) chatStickToBottomRef.current = false;
    setShowChatScrollTop(!atTop);
    setShowChatScrollBottom(!atBottom);
    if (atBottom) setShowJumpToLatest(false);
  }

  function scheduleChatBottomStateUpdate(source: "scroll" | "measure" = "measure") {
    if (scrollStateRafRef.current) return;
    scrollStateRafRef.current = window.requestAnimationFrame(() => {
      scrollStateRafRef.current = undefined;
      updateChatBottomState(source);
    });
  }

  function flushQueuedUiMessages() {
    const queued = wsMessageQueueRef.current;
    wsMessageQueueRef.current = [];
    if (!queued.length) return;

    const jobLogs: any[] = [];
    const jobProgress = new Map<string, any>();
    const agentActivity = new Map<string, any>();
    const agentStatus = new Map<string, any>();
    const reposUpdated = new Map<string, any>();
    const rest: any[] = [];

    for (const message of queued) {
      if (message.type === "job.log") jobLogs.push(message);
      else if (message.type === "job.progress") jobProgress.set(message.jobId, message);
      else if (message.type === "agent.activity") agentActivity.set(message.agentId, message);
      else if (message.type === "agent.status") agentStatus.set(message.agentId, message);
      else if (message.type === "repos.updated") reposUpdated.set(message.agentId, message);
      else rest.push(message);
    }

    if (jobLogs.length) {
      setLogs((current) => {
        const activeJobId = activeJobIdRef.current;
        const nextLogs = jobLogs.filter((message) => activeJobId === message.jobId);
        return nextLogs.length ? [...current, ...nextLogs] : current;
      });
    }

    if (jobProgress.size) {
      const progressMessages = [...jobProgress.values()];
      const progressById = new Map(progressMessages.map((message) => [message.jobId, message]));
      setProgressByJob((current) => {
        let changed = false;
        const next = { ...current };
        for (const message of progressMessages) {
          if (next[message.jobId] !== message) {
            next[message.jobId] = message;
            changed = true;
          }
        }
        return changed ? next : current;
      });
      const patchJob = (job: Job): Job => {
        const progress = progressById.get(job.id);
        return progress ? { ...job, status: "running", progress } : job;
      };
      const patchJobs = (current: Job[]) => current.some((job) => progressById.has(job.id)) ? current.map(patchJob) : current;
      setAllJobs(patchJobs);
      setJobs(patchJobs);
      setActiveJob((current) => current && progressById.has(current.id) ? patchJob(current) : current);
    }

    if (agentActivity.size) {
      setAgents((current) => {
        let changed = false;
        const next = current.map((agent) => {
          const message = agentActivity.get(agent.id);
          if (!message) return agent;
          const currentJobId = message.localActivity.status === "idle" ? null : agent.current_job_id;
          if (agent.localActivity === message.localActivity && agent.current_job_id === currentJobId) return agent;
          changed = true;
          return { ...agent, localActivity: message.localActivity, current_job_id: currentJobId };
        });
        return changed ? next : current;
      });
    }

    if (agentStatus.size) {
      setAgents((current) => {
        let changed = false;
        const next = current.map((agent) => {
          const message = agentStatus.get(agent.id);
          if (!message || agent.status === message.status) return agent;
          changed = true;
          return { ...agent, status: message.status };
        });
        return changed ? next : current;
      });
    }

    if (reposUpdated.size) {
      setRepos((current) => {
        let next = current;
        let changed = false;
        for (const message of reposUpdated.values()) {
          const mappedRepos = message.repos.map((repo: Omit<Repo, "agentId">) => ({ ...repo, agentId: message.agentId }));
          const restRepos = next.filter((repo) => repo.agentId !== message.agentId);
          const previous = next.filter((repo) => repo.agentId === message.agentId);
          const previousKey = JSON.stringify(previous.map((repo) => [repo.id, repo.name, repo.pathMasked, repo.currentBranch, repo.dirty]));
          const nextKey = JSON.stringify(mappedRepos.map((repo: Repo) => [repo.id, repo.name, repo.pathMasked, repo.currentBranch, repo.dirty]));
          if (previousKey !== nextKey) {
            next = [...restRepos, ...mappedRepos];
            changed = true;
          }
        }
        return changed ? next : current;
      });
    }

    for (const message of rest) {
      if (message.type === "chats.updated") {
        const repo = selectedRepoRef.current;
        const selectedRepoUpdated = Boolean(repo && message.agentId === repo.agentId && message.repoId === repo.id);
        if (repo && selectedRepoUpdated) scheduleLoadChats(repo);
        if (
          selectedRepoUpdated
          && activeChatIdRef.current
          && (!message.chatId || message.chatId === activeChatIdRef.current)
        ) {
          scheduleLoadChat(activeChatIdRef.current, "sync");
        }
      } else if (message.type === "job.created" || message.type === "job.updated") {
        const status = typeof message.status === "string" ? message.status : "";
        if (typeof message.jobId === "string" && typeof message.status === "string") {
          applyJobStatusUpdate(message.jobId, message.status);
        }
        scheduleLoadAllJobs();
        if (message.jobId && activeJobIdRef.current === message.jobId) scheduleLoadJob(message.jobId);
        if (activeChatIdRef.current && (message.type === "job.created" || isTerminalJobStatus(status))) scheduleLoadChat(activeChatIdRef.current);
      }
    }
  }

  function enqueueUiMessage(message: any) {
    wsMessageQueueRef.current.push(message);
    if (wsFlushRafRef.current) return;
    wsFlushRafRef.current = window.requestAnimationFrame(() => {
      wsFlushRafRef.current = undefined;
      flushQueuedUiMessages();
    });
  }

  function scrollChatToLatest(behavior: ScrollBehavior = "smooth") {
    const scroller = getChatScroller();
    autoScrollingUntilRef.current = Date.now() + (behavior === "smooth" ? 420 : 80);
    scroller.scrollTo({ top: scroller.scrollHeight, behavior });
    chatAtBottomRef.current = true;
    chatStickToBottomRef.current = true;
    setShowJumpToLatest(false);
    setShowChatScrollBottom(false);
    window.setTimeout(updateChatBottomState, behavior === "smooth" ? 260 : 0);
  }

  function scrollChatToTop(behavior: ScrollBehavior = "smooth") {
    const scroller = getChatScroller();
    autoScrollingUntilRef.current = Date.now() + (behavior === "smooth" ? 420 : 80);
    scroller.scrollTo({ top: 0, behavior });
    chatAtBottomRef.current = false;
    chatStickToBottomRef.current = false;
    setShowChatScrollTop(false);
    setShowChatScrollBottom(true);
    window.setTimeout(updateChatBottomState, behavior === "smooth" ? 260 : 0);
  }

  function updateComposerPlacement() {
    const composer = composerRef.current;
    if (!composer) {
      document.documentElement.style.setProperty("--scroll-controls-bottom", "18px");
      return;
    }
    const height = Math.ceil(composer.getBoundingClientRect().height);
    document.documentElement.style.setProperty("--composer-space", `${height + 12}px`);
    const rect = composer.getBoundingClientRect();
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    const visibleHeight = Math.max(0, Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0));
    const bottom = visibleHeight > 10 ? Math.ceil(visibleHeight + 12) : 18;
    document.documentElement.style.setProperty("--scroll-controls-bottom", `${bottom}px`);
  }

  function clearChatLoader(chatId: string, startedAt: number) {
    if (chatLoadingStartedRef.current && chatLoadingStartedRef.current !== startedAt) return;
    if (chatLoadingStartedRef.current === startedAt) chatLoadingStartedRef.current = 0;
    setChatLoadingId((current) => current === chatId ? "" : current);
    setChatLoadingProgress((current) => current?.startedAt === startedAt ? null : current);
  }

  function renderChatThinkingIndicator() {
    if (!showChatThinkingIndicator) return null;
    const label = activeRunBusy ? jobProgressLabel(activeProgress) : "Локальный Codex";
    const message = activeRunBusy ? jobProgressMessage(activeProgress) : localActivity?.summary ?? "Локальный Codex сейчас занят";
    return (
      <article className="thinking-message" aria-live="polite">
        <div className="thinking-chip">
          <span className="thinking-spark" aria-hidden="true" />
          <span>{label}</span>
          <em>{message}</em>
          <small>{formatDuration(thinkingSeconds)}</small>
        </div>
      </article>
    );
  }

  async function refresh() {
    const [agentResponse, repoResponse, jobsResponse] = await Promise.all([api("/api/agents"), api("/api/repos"), api("/api/jobs")]);
    if (agentResponse.ok) setAgents((await agentResponse.json()).agents);
    if (jobsResponse.ok) setAllJobs((await jobsResponse.json()).jobs);
    if (repoResponse.ok) {
      const nextRepos = (await repoResponse.json()).repos;
      setRepos(nextRepos);
      if (repoKey && !nextRepos.some((repo: Repo) => `${repo.agentId}:${repo.id}` === repoKey)) {
        clearProjectSelection();
      }
    }
  }

  async function loadAllJobs() {
    const response = await api("/api/jobs");
    if (!response.ok) return;
    setAllJobs((await response.json()).jobs);
  }

  async function loadUsers() {
    if (currentUser?.role !== "admin") return;
    const response = await api("/api/users");
    if (response.ok) setUsers((await response.json()).users);
  }

  async function loadAdminUsers(selectUserId?: string) {
    if (currentUser?.role !== "admin") return;
    const response = await api("/api/admin/users");
    if (!response.ok) return;
    const data = await response.json();
    const nextUsers = data.users as AdminUser[];
    setAdminUsers(nextUsers);
    const nextSelected = selectUserId || adminSelectedUserId || nextUsers[0]?.id || "";
    setAdminSelectedUserId(nextSelected);
    if (nextSelected) await loadAdminChats(nextSelected);
  }

  async function loadAdminStats() {
    if (currentUser?.role !== "admin") return;
    const response = await api("/api/admin/stats?days=30");
    if (response.ok) setAdminStats((await response.json()).series);
  }

  async function loadAdminChats(userId: string) {
    const response = await api(`/api/admin/users/${encodeURIComponent(userId)}/chats`);
    if (!response.ok) return;
    const data = await response.json();
    setAdminChats(data.chats);
  }

  async function loadProfile() {
    const response = await api("/api/profile");
    if (!response.ok) return;
    const data = await response.json();
    setCurrentUser(data.user);
    setProfileStatsData(data.stats);
    setOauthProviders(data.oauth);
    setProfileNickname(data.user.nickname ?? "");
    setProfileBio(data.user.bio ?? "");
    setProfileAvatarDataUrl(data.user.avatarDataUrl ?? "");
  }

  async function loadAuthOAuthProviders() {
    const response = await api("/api/oauth/providers");
    if (response.ok) setAuthOauthProviders((await response.json()).providers);
  }

  async function loadPublicSearch(type = searchType, query = searchQuery) {
    setSearchNotice("");
    const response = await api(`/api/public/search?type=${encodeURIComponent(type)}&q=${encodeURIComponent(query.trim())}&limit=10`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      setSearchNotice(data.error || "Search failed.");
      return;
    }
    if (type === "profiles") {
      setSearchProfiles(data.profiles ?? []);
      setSearchProjects([]);
    } else {
      setSearchProjects(data.projects ?? []);
      setSearchProfiles([]);
    }
  }

  async function openPublicChat(chat: Chat) {
    setSearchNotice("");
    const response = await api(`/api/public/chats/${encodeURIComponent(chat.id)}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      setSearchNotice(data.error || "Не удалось открыть публичный чат.");
      return;
    }
    setSearchOpenedChat({ chat: data.chat, messages: data.messages ?? [], jobs: data.jobs ?? [] });
  }

  async function loadChats(repo: Repo, selectFirst = false) {
    const controller = new AbortController();
    loadChatsAbortRef.current = controller;
    try {
      const response = await api(`/api/chats?agentId=${encodeURIComponent(repo.agentId)}&repoId=${encodeURIComponent(repo.id)}`);
      if (loadChatsAbortRef.current !== controller) return;
      if (!response.ok) {
        loadChatsAbortRef.current = null;
        return;
      }
      const nextChats = (await response.json()).chats;
      if (loadChatsAbortRef.current !== controller) return;
      loadChatsAbortRef.current = null;
      const activeId = activeChatIdRef.current;
      setChats((current) => {
        if (selectFirst || !activeId || nextChats.some((chat: Chat) => chat.id === activeId)) return nextChats;
        const active = current.find((chat) => chat.id === activeId);
        if (!active) return nextChats;
        return [active, ...nextChats.filter((chat: Chat) => chat.id !== activeId)]
          .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      });
      if (selectFirst && nextChats[0]) {
        await loadChat(nextChats[0].id, undefined, true);
        return;
      }
    } catch (error) {
      if (!isAbortError(error)) throw error;
    }
  }

  async function loadHiddenLocalChats(repo: Repo) {
    const response = await api(`/api/chats?agentId=${encodeURIComponent(repo.agentId)}&repoId=${encodeURIComponent(repo.id)}&includeHidden=1&localOnly=1`);
    if (!response.ok) return;
    const nextChats = ((await response.json()).chats as Chat[]).filter((chat) => chat.hiddenAt);
    setHiddenLocalChats(nextChats);
  }

  async function refreshChatsAfterLocalSync(repo: Repo, refreshId: number) {
    for (const pause of LOCAL_CHAT_SYNC_REFRESH_DELAYS_MS) {
      if (pause) await delay(pause);
      if (localChatSyncRefreshRef.current !== refreshId) return;
      await loadChats(repo);
      await loadHiddenLocalChats(repo);
      if (activeChatIdRef.current) await loadChat(activeChatIdRef.current).catch(() => undefined);
    }
  }

  async function syncLocalChats(repo = selectedRepo) {
    if (!repo || !csrf || localChatSyncing) return;
    setLocalChatSyncing(true);
    setChatNotice("");
    setChatNoticeOk(false);
    setSyncNotice("");
    try {
      const response = await api(`/api/agents/${encodeURIComponent(repo.agentId)}/sync-local-chats`, {
        method: "POST",
        headers: { "x-csrf-token": csrf },
        body: "{}"
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setChatNoticeOk(false);
        setChatNotice(data.error === "agent_offline" ? "Агент offline: локальные чаты пока нельзя синхронизировать." : "Не получилось синхронизировать локальные чаты.");
        setSyncNotice(data.error === "agent_offline" ? "Агент offline: синхронизация недоступна." : data.error || "Не получилось синхронизировать локальные чаты.");
        return;
      }
      setSyncNotice(data.accepted
        ? "Синхронизация запущена: агент обновит локальные чаты."
        : `Синхронизация прошла: агент отправил ${data.sent ?? 0} чатов.`);
      const refreshId = localChatSyncRefreshRef.current + 1;
      localChatSyncRefreshRef.current = refreshId;
      void refreshChatsAfterLocalSync(repo, refreshId).catch(() => undefined);
    } finally {
      setLocalChatSyncing(false);
    }
  }

  async function loadChat(chatId: string, preferredJobId?: string, showLoader = false) {
    const currentLoad = loadChatInFlightRef.current;
    if (currentLoad?.chatId === chatId && (!showLoader || currentLoad.foreground)) return;
    const controller = new AbortController();
    loadChatAbortRef.current = controller;
    loadChatInFlightRef.current = { chatId, controller, foreground: showLoader };
    const loadingStartedAt = Date.now();
    if (showLoader) {
      chatLoadingStartedRef.current = loadingStartedAt;
      setActiveChatId(chatId);
      setChatLoadingId(chatId);
      setChatLoadingProgress({ phase: "request", loadedBytes: 0, percent: 4, startedAt: loadingStartedAt });
      setChatNotice("");
      setChatNoticeOk(false);
    }
    const timeout = window.setTimeout(() => controller.abort(), 30000);
    try {
      const cached = chatCacheRef.current.get(chatId);
      const response = await fetch(`/api/chats/${chatId}`, {
        cache: "no-store",
        signal: controller.signal,
        headers: cached?.etag ? { "If-None-Match": cached.etag } : undefined
      });
      if (loadChatAbortRef.current !== controller) return;
      let data: ChatPayload;
      let loadedBytes = 0;
      let totalBytes: number | undefined;
      if (response.status === 304 && cached) {
        data = cached.data;
        if (showLoader) setChatLoadingProgress({ phase: "parse", loadedBytes: 0, percent: 92, startedAt: loadingStartedAt });
      } else {
      if (!response.ok) {
        loadChatAbortRef.current = null;
        clearChatLoader(chatId, loadingStartedAt);
        if (showLoader) {
          setChatNoticeOk(false);
          setChatNotice("Не удалось загрузить чат. Попробуй открыть его ещё раз.");
        }
        return;
      }
      const totalHeader = Number(response.headers.get("content-length") ?? 0);
      totalBytes = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : undefined;
      let responseText = "";
      if (response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (loadChatAbortRef.current !== controller) return;
          loadedBytes += value.byteLength;
          responseText += decoder.decode(value, { stream: true });
          if (showLoader) {
            const downloadPercent = totalBytes ? 8 + Math.min(82, (loadedBytes / totalBytes) * 82) : undefined;
            setChatLoadingProgress({
              phase: "download",
              loadedBytes,
              totalBytes,
              percent: downloadPercent,
              startedAt: loadingStartedAt
            });
          }
        }
        responseText += decoder.decode();
      } else {
        responseText = await response.text();
        loadedBytes = new Blob([responseText]).size;
        if (showLoader) {
          setChatLoadingProgress({ phase: "download", loadedBytes, totalBytes, percent: totalBytes ? 90 : undefined, startedAt: loadingStartedAt });
        }
      }
      if (loadChatAbortRef.current !== controller) return;
      if (showLoader) setChatLoadingProgress({ phase: "parse", loadedBytes, totalBytes, percent: 92, startedAt: loadingStartedAt });
      try {
        data = JSON.parse(responseText) as ChatPayload;
      } catch (error) {
        clearChatLoader(chatId, loadingStartedAt);
        if (showLoader) {
          setChatNoticeOk(false);
          setChatNotice("Не удалось разобрать ответ чата. Обнови страницу и попробуй открыть чат ещё раз.");
        }
        throw error;
      }
      const etag = response.headers.get("etag");
      if (etag) chatCacheRef.current.set(chatId, { etag, data });
      }
      if (loadChatAbortRef.current !== controller) return;
      loadChatAbortRef.current = null;
      setChats((current) => {
        const withoutLoaded = current.filter((chat) => chat.id !== data.chat.id);
        return [data.chat, ...withoutLoaded].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      });
      setActiveChatId(chatId);
      setJobs((current) => mergeJobs(current.filter((job) => job.chatId === chatId), data.jobs));
      setAllJobs((current) => mergeJobs(current, data.jobs));
      setProgressByJob((current) => ({ ...current, ...progressMapFromJobs(data.jobs) }));
      setMessages((current) => mergeChatMessages(current.filter((message) => message.chatId === chatId), data.messages ?? []));
      const targetJobId = preferredJobId ?? data.jobs[0]?.id;
      if (targetJobId) {
        if (showLoader) setChatLoadingProgress({ phase: "details", loadedBytes, totalBytes, percent: 96, startedAt: loadingStartedAt });
        await loadJob(targetJobId);
      }
      else {
        setActiveJob(null);
        setLogs([]);
      }
      setChatLoadingId((current) => current === chatId ? "" : current);
      setChatLoadingProgress((current) => current?.startedAt === loadingStartedAt ? null : current);
    } catch (error) {
      if (loadChatAbortRef.current === controller) {
        loadChatAbortRef.current = null;
      }
      if (loadChatInFlightRef.current?.controller === controller) {
        loadChatInFlightRef.current = null;
      }
      clearChatLoader(chatId, loadingStartedAt);
      if (!isAbortError(error)) {
        if (showLoader) {
          setChatNoticeOk(false);
          setChatNotice("Загрузка чата прервалась. Попробуй открыть его ещё раз.");
        }
        throw error;
      }
    } finally {
      window.clearTimeout(timeout);
      if (loadChatAbortRef.current === controller) loadChatAbortRef.current = null;
      if (loadChatInFlightRef.current?.controller === controller) loadChatInFlightRef.current = null;
      clearChatLoader(chatId, loadingStartedAt);
    }
  }

  async function loadJob(jobId: string) {
    const response = await api(`/api/jobs/${jobId}`);
    if (!response.ok) return;
    const data = await response.json();
    setActiveJob(data.job);
    setAllJobs((current) => mergeJobs(current, [data.job]));
    if (data.job?.progress) setProgressByJob((current) => ({ ...current, [data.job.id]: data.job.progress }));
    setLogs(data.logs);
  }

  async function loadJobDetails(jobId: string) {
    const response = await api(`/api/jobs/${jobId}`);
    if (!response.ok) return;
    const data = await response.json();
    setAllJobs((current) => mergeJobs(current, [data.job]));
    setJobs((current) => mergeJobs(current, [data.job]));
    setActiveJob((current) => current?.id === jobId ? data.job : current);
    if (data.job?.progress) setProgressByJob((current) => ({ ...current, [data.job.id]: data.job.progress }));
  }

  async function loadMessageDetails(messageId: string) {
    const response = await api(`/api/chat-messages/${messageId}/details`);
    if (!response.ok) return;
    const data = await response.json();
    setMessages((current) => current.map((message) => message.id === messageId ? data.message : message));
  }

  function scheduleLoadChats(repo: Repo) {
    const key = `${repo.agentId}:${repo.id}`;
    const now = Date.now();
    const last = lastChatListLoadAtRef.current[key] ?? 0;
    const delay = Math.max(180, CHAT_LIST_REFRESH_MIN_MS - (now - last));
    if (loadChatsTimerRef.current) window.clearTimeout(loadChatsTimerRef.current);
    loadChatsTimerRef.current = window.setTimeout(() => {
      lastChatListLoadAtRef.current[key] = Date.now();
      loadChats(repo).catch(() => undefined);
    }, delay);
  }

  function scheduleLoadChat(chatId: string, reason: "direct" | "sync" = "direct") {
    const currentLoad = loadChatInFlightRef.current;
    if (currentLoad?.chatId === chatId && currentLoad.foreground) return;
    const now = Date.now();
    const last = lastChatLoadAtRef.current[chatId] ?? 0;
    const minInterval = reason === "sync" ? CHAT_SYNC_REFRESH_MIN_MS : 0;
    const delay = reason === "sync" ? Math.max(400, minInterval - (now - last)) : 80;
    const dueAt = now + delay;
    if (scheduledChatLoadRef.current?.chatId === chatId && scheduledChatLoadRef.current.dueAt <= dueAt) return;
    if (loadChatTimerRef.current) window.clearTimeout(loadChatTimerRef.current);
    scheduledChatLoadRef.current = { chatId, dueAt };
    loadChatTimerRef.current = window.setTimeout(() => {
      if (scheduledChatLoadRef.current?.chatId === chatId) scheduledChatLoadRef.current = null;
      lastChatLoadAtRef.current[chatId] = Date.now();
      loadChat(chatId).catch(() => undefined);
    }, delay);
  }

  function scheduleLoadJob(jobId: string) {
    if (loadJobTimerRef.current) window.clearTimeout(loadJobTimerRef.current);
    loadJobTimerRef.current = window.setTimeout(() => {
      loadJob(jobId).catch(() => undefined);
    }, 120);
  }

  function scheduleLoadAllJobs() {
    if (loadAllJobsTimerRef.current) window.clearTimeout(loadAllJobsTimerRef.current);
    loadAllJobsTimerRef.current = window.setTimeout(() => {
      loadAllJobs().catch(() => undefined);
    }, 750);
  }

  function applyJobStatusUpdate(jobId: string, status: string) {
    const finishedAt = isTerminalJobStatus(status) ? new Date().toISOString() : undefined;
    const patchJob = (job: Job): Job => (
      job.id === jobId
        ? { ...job, status, finishedAt: finishedAt ?? job.finishedAt }
        : job
    );
    setAllJobs((current) => current.map(patchJob));
    setJobs((current) => current.map(patchJob));
    setActiveJob((current) => current?.id === jobId ? patchJob(current) : current);
    if (finishedAt) {
      pendingVscodeThreadRefreshRef.current.add(jobId);
      setAgents((current) => current.map((agent) => (
        agent.current_job_id === jobId ? { ...agent, current_job_id: null } : agent
      )));
      setLocalBusyHold({ until: 0 });
    }
  }

  async function openJob(job: Job) {
    if (job.chatId) await loadChat(job.chatId, job.id);
    else await loadJob(job.id);
  }

  function resetActiveChatView() {
    setActiveChatId("");
    setChatLoadingId("");
    setChatLoadingProgress(null);
    setJobs([]);
    setMessages([]);
    setActiveJob(null);
    setLogs([]);
  }

  function selectProject(repo: Repo) {
    const nextRepoKey = `${repo.agentId}:${repo.id}`;
    setMobileMenuOpen(false);
    setView("projects");
    setRepoKey(nextRepoKey);
    setSandbox(repo.defaultSandbox);
    setGitMessage(`Update ${repo.name}`);
    setGitRemoteUrl(repo.githubUrl ?? "");
    setGitNotice("");
    setDeployNotice("");
    setNginxNotice("");
    setSslNotice("");
    setLaunchNotice("");
    resetActiveChatView();
    setProjectPanel(null);
    setChatProperties(null);
    setChatMenuId("");
    setProjectActionsOpen(false);
    loadChats(repo);
    void syncLocalChats(repo);
  }

  function clearProjectSelection() {
    setMobileMenuOpen(false);
    setView("projects");
    setRepoKey("");
    setChats([]);
    resetActiveChatView();
    setProjectPanel(null);
    setChatProperties(null);
    setChatMenuId("");
    setProjectActionsOpen(false);
    setGitNotice("");
    setDeployNotice("");
    setNginxNotice("");
    setSslNotice("");
    setLaunchNotice("");
  }

  function openSettingsView() {
    setMobileMenuOpen(false);
    setView("settings");
    setProjectPanel(null);
    setChatProperties(null);
    setChatMenuId("");
    loadUsers();
  }

  function openSearchView() {
    setMobileMenuOpen(false);
    setView("search");
    setProjectPanel(null);
    setChatProperties(null);
    setChatMenuId("");
    setSearchOpenedChat(null);
    void loadPublicSearch();
  }

  function openProfileView() {
    setMobileMenuOpen(false);
    setView("profile");
    setProjectPanel(null);
    setChatProperties(null);
    setChatMenuId("");
    setProfileNotice("");
    loadProfile();
  }

  function openSyncView() {
    setMobileMenuOpen(false);
    setView("sync");
    setProjectPanel(null);
    setChatProperties(null);
    setChatMenuId("");
    setSyncNotice("");
    syncAutoPingRef.current = "";
    refresh();
  }

  function applyProjectDefaultsToForm(options: { includePath: boolean }) {
    const defaults = defaultProjectValues(projectName, projectPanel === "new" ? projectFormAgent : selectedAgent);
    if (options.includePath) setProjectPath(defaults.path);
    setProjectDomain(defaults.domain);
    setProjectServerPath(defaults.serverPath);
    setProjectGithubUrl(defaults.githubUrl);
    setProjectDataPath(defaultProjectDataPath(projectDataLocation, options.includePath ? defaults.path : projectPath, defaults.serverPath));
    setProjectDeployEnabled(true);
    const defaultMode = isLinuxAgent(projectPanel === "new" ? projectFormAgent : selectedAgent) ? "local" : "ssh";
    setProjectDeployMode(defaultMode);
    if (!projectDeploySshTarget.trim()) setProjectDeploySshTarget(DEFAULT_DEPLOY_SSH_TARGET);
    if (!projectDeploySourceDir.trim()) setProjectDeploySourceDir("dist");
    if (!projectDeployBuildCommand.trim()) setProjectDeployBuildCommand(defaultBuildCommandForAgent(projectPanel === "new" ? projectFormAgent : selectedAgent));
  }

  function handleProjectAgentChange(agentId: string) {
    const agent = agents.find((item) => item.id === agentId) ?? selectedAgent;
    setProjectAgentId(agentId);
    if (projectPanel !== "new") return;
    const defaults = defaultProjectValues(projectName, agent);
    setProjectPath(defaults.path);
    setProjectServerPath(defaults.serverPath);
    setProjectGithubUrl(defaults.githubUrl);
    setProjectDomain(defaults.domain);
    const nextDataLocation = isLinuxAgent(agent) ? "server" : "local";
    setProjectDataLocation(nextDataLocation);
    setProjectDataPath(defaultProjectDataPath(nextDataLocation, defaults.path, defaults.serverPath));
    const defaultMode = isLinuxAgent(agent) ? "local" : "ssh";
    setProjectDeployMode(defaultMode);
    setProjectDeploySshTarget(defaultMode === "ssh" ? DEFAULT_DEPLOY_SSH_TARGET : "");
    setProjectDeployBuildCommand(defaultBuildCommandForAgent(agent));
  }

  function handleProjectNameChange(value: string) {
    const previousDataPath = defaultProjectDataPath(projectDataLocation, projectPath, projectServerPath);
    setProjectName(value);
    if (projectPanel !== "new") return;
    const defaults = defaultProjectValues(value, projectFormAgent);
    setProjectPath(defaults.path);
    setProjectDomain(defaults.domain);
    setProjectServerPath(defaults.serverPath);
    setProjectGithubUrl(defaults.githubUrl);
    if (!projectDataPath.trim() || projectDataPath === previousDataPath) {
      setProjectDataPath(defaultProjectDataPath(projectDataLocation, defaults.path, defaults.serverPath));
    }
  }

  function handleProjectDomainChange(value: string) {
    const previousDomain = normalizeProjectDomain(projectDomain);
    const previousServerPath = defaultServerPathForDomain(previousDomain);
    const previousGithubUrl = defaultGithubUrlForDomain(previousDomain);
    const previousDataPath = defaultProjectDataPath(projectDataLocation, projectPath, projectServerPath);
    setProjectDomain(value);
    const nextDomain = normalizeProjectDomain(value);
    if (!nextDomain) return;
    const nextServerPath = defaultServerPathForDomain(nextDomain);
    if (!projectServerPath.trim() || projectServerPath.trim() === previousServerPath) {
      setProjectServerPath(nextServerPath);
      if (projectDataLocation === "server" && (!projectDataPath.trim() || projectDataPath === previousDataPath)) {
        setProjectDataPath(defaultProjectDataPath("server", projectPath, nextServerPath));
      }
    }
    if (!projectGithubUrl.trim() || projectGithubUrl.trim() === previousGithubUrl) {
      setProjectGithubUrl(defaultGithubUrlForDomain(nextDomain));
    }
  }

  function handleProjectPathChange(value: string) {
    const previousDataPath = defaultProjectDataPath(projectDataLocation, projectPath, projectServerPath);
    setProjectPath(value);
    if (projectPanel === "new" && projectDataLocation === "local" && (!projectDataPath.trim() || projectDataPath === previousDataPath)) {
      setProjectDataPath(defaultProjectDataPath("local", value, projectServerPath));
    }
  }

  function handleProjectServerPathChange(value: string) {
    const previousDataPath = defaultProjectDataPath(projectDataLocation, projectPath, projectServerPath);
    setProjectServerPath(value);
    if (projectDataLocation === "server" && (!projectDataPath.trim() || projectDataPath === previousDataPath)) {
      setProjectDataPath(defaultProjectDataPath("server", projectPath, value));
    }
  }

  function handleProjectDataLocationChange(location: ProjectDataLocation) {
    setProjectDataLocation(location);
    setProjectDataPath(defaultProjectDataPath(location, projectPath, projectServerPath));
  }

  function openNewProject() {
    const defaults = defaultProjectValues("New Project", selectedAgent);
    setProjectName("New Project");
    setProjectAgentId(selectedAgent?.id ?? agents[0]?.id ?? "");
    setProjectPath(defaults.path);
    setProjectGithubUrl(defaults.githubUrl);
    setProjectServerPath(defaults.serverPath);
    setProjectDomain(defaults.domain);
    setProjectVisibility("private");
    const defaultMode = isLinuxAgent(selectedAgent) ? "local" : "ssh";
    setProjectDeployEnabled(true);
    setProjectDeployMode(defaultMode);
    setProjectDeploySshTarget(defaultMode === "ssh" ? DEFAULT_DEPLOY_SSH_TARGET : "");
    setProjectDeploySourceDir("dist");
    setProjectDeployRemoteSubdir("");
    setProjectDeployBuildCommand(defaultBuildCommandForAgent(selectedAgent));
    setProjectDeployCleanRemote(false);
    setProjectDataLocation(isLinuxAgent(selectedAgent) ? "server" : "local");
    setProjectDataPath(defaultProjectDataPath(isLinuxAgent(selectedAgent) ? "server" : "local", defaults.path, defaults.serverPath));
    setProjectStartPrompt("");
    setOriginalProjectPath("");
    setProjectWizardStep("project");
    setProjectPanel("new");
  }

  function openProjectSettings(repo: Repo) {
    setProjectName(repo.name);
    setProjectAgentId(repo.agentId);
    setProjectPath(repo.pathMasked);
    setProjectGithubUrl(repo.githubUrl ?? "");
    setProjectServerPath(repo.serverPath ?? "");
    setProjectDomain(repo.domain ?? "");
    setProjectVisibility(repo.visibility ?? "private");
    setProjectDeployMode(repo.deploy?.mode ?? "ssh");
    setProjectDeploySshTarget(repo.deploy?.sshTarget ?? "");
    setProjectDeploySourceDir(repo.deploy?.sourceDir ?? "dist");
    setProjectDeployRemoteSubdir(repo.deploy?.remoteSubdir ?? "");
    setProjectDeployBuildCommand(formatBuildCommand(repo.deploy) || defaultBuildCommandForAgent(agents.find((agent) => agent.id === repo.agentId)));
    setProjectDeployCleanRemote(repo.deploy?.cleanRemote ?? false);
    setProjectDeployEnabled(Boolean(repo.deploy));
    setProjectDataLocation(repo.data?.location ?? "local");
    setProjectDataPath(repo.data?.path ?? defaultProjectDataPath(repo.data?.location ?? "local", repo.pathMasked, repo.serverPath ?? ""));
    setProjectStartPrompt("");
    setOriginalProjectPath(repo.pathMasked);
    setSandbox(repo.defaultSandbox);
    setProjectPanel("settings");
    setProjectNotice("");
  }

  function openChatProperties(chat: Chat) {
    setMobileMenuOpen(false);
    setChatProperties(chat);
    setChatSettingsTitle(chat.title);
    setLinkedChatId("");
    setChatMenuId("");
    if (selectedRepo) loadHiddenLocalChats(selectedRepo);
  }

  function startRenameChat(chat: Chat) {
    setRenamingChatId(chat.id);
    setRenameTitle(chat.title);
    setChatMenuId("");
  }

  function cancelRenameChat() {
    setRenamingChatId("");
    setRenameTitle("");
  }

  useEffect(() => {
    api("/api/me").then(async (response) => {
      if (!response.ok) return;
      const data = await response.json();
      setCurrentUser(data.user);
      setCsrf(data.csrfToken);
      refresh();
    });
  }, []);

  useEffect(() => {
    const error = new URLSearchParams(window.location.search).get("oauth_error");
    if (!error) return;
    setAuthNotice(error === "registration_closed" ? "Регистрация временно закрыта." : error === "user_blocked" ? "Аккаунт заблокирован." : "OAuth вход не получился.");
  }, []);

  useEffect(() => {
    if (!registrationOpen && authMode === "register") setAuthMode("login");
  }, [authMode, registrationOpen]);

  useEffect(() => {
    if (!csrf) loadAuthOAuthProviders();
  }, [csrf]);

  useEffect(() => {
    if (!csrf || !isAdminRoute || currentUser?.role !== "admin") return;
    void loadAdminUsers();
    void loadAdminStats();
  }, [csrf, currentUser?.role, isAdminRoute]);

  useEffect(() => {
    if (!csrf || view !== "search") return;
    const timer = window.setTimeout(() => {
      void loadPublicSearch(searchType, searchQuery);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [csrf, view, searchType, searchQuery]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("cmc.codexRunSettings");
      if (!raw) return;
      const parsed = JSON.parse(raw) as { model?: string; reasoningEffort?: ReasoningEffort; speed?: CodexSpeed };
      if (parsed.model && CODEX_MODEL_OPTIONS.some((option) => option.value === parsed.model)) setCodexModel(parsed.model);
      if (parsed.reasoningEffort && REASONING_OPTIONS.some((option) => option.value === parsed.reasoningEffort)) setReasoningEffort(parsed.reasoningEffort);
      if (parsed.speed && SPEED_OPTIONS.some((option) => option.value === parsed.speed)) setCodexSpeed(parsed.speed);
    } catch {
      try {
        localStorage.removeItem("cmc.codexRunSettings");
      } catch {
        // Ignore blocked storage.
      }
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("cmc.codexRunSettings", JSON.stringify({
        model: codexModel,
        reasoningEffort,
        speed: codexSpeed
      }));
    } catch {
      // The settings are just a UI convenience; a blocked storage write should not break chat.
    }
  }, [codexModel, reasoningEffort, codexSpeed]);

  useEffect(() => {
    document.documentElement.dataset.theme = uiTheme;
    try {
      localStorage.setItem("cmc.uiTheme", uiTheme);
    } catch {
      // Theme is local preference only.
    }
  }, [uiTheme]);

  useEffect(() => {
    if (!csrf) return;
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    let ws: WebSocket | undefined;
    let reconnectTimer: number | undefined;
    let closed = false;

    const connect = () => {
      ws = new WebSocket(`${protocol}://${location.host}/api/ui/ws`);
      ws.onmessage = (event) => {
        try {
          enqueueUiMessage(JSON.parse(event.data));
        } catch {
          // Ignore malformed UI events; the websocket will continue.
        }
      };
      ws.onclose = () => {
        if (!closed) reconnectTimer = window.setTimeout(connect, 1500);
      };
    };

    connect();
    return () => {
      closed = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      if (loadChatsTimerRef.current) window.clearTimeout(loadChatsTimerRef.current);
      if (loadChatTimerRef.current) window.clearTimeout(loadChatTimerRef.current);
      if (loadJobTimerRef.current) window.clearTimeout(loadJobTimerRef.current);
      if (loadAllJobsTimerRef.current) window.clearTimeout(loadAllJobsTimerRef.current);
      if (wsFlushRafRef.current) window.cancelAnimationFrame(wsFlushRafRef.current);
      if (scrollStateRafRef.current) window.cancelAnimationFrame(scrollStateRafRef.current);
      ws?.close();
    };
  }, [csrf]);

  useEffect(() => {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }, []);

  useEffect(() => {
    document.body.classList.toggle("mobile-menu-open", mobileMenuOpen);
    return () => document.body.classList.remove("mobile-menu-open");
  }, [mobileMenuOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileMenuOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const updateFromScroll = () => scheduleChatBottomStateUpdate("scroll");
    const updateFromMeasure = () => scheduleChatBottomStateUpdate("measure");
    const scroller = getChatScroller();
    if (scroller !== document.documentElement && scroller !== document.body) {
      scroller.addEventListener("scroll", updateFromScroll, { passive: true });
    }
    window.addEventListener("scroll", updateFromScroll, { passive: true });
    window.addEventListener("resize", updateFromMeasure);
    window.requestAnimationFrame(updateFromMeasure);
    return () => {
      scroller.removeEventListener("scroll", updateFromScroll);
      window.removeEventListener("scroll", updateFromScroll);
      window.removeEventListener("resize", updateFromMeasure);
    };
  }, [activeChatId, messages.length, selectedRepo?.id, view]);

  useEffect(() => {
    if (!activeChat) {
      setShowChatScrollTop(false);
      setShowChatScrollBottom(false);
      document.documentElement.style.removeProperty("--composer-space");
      document.documentElement.style.removeProperty("--scroll-controls-bottom");
      return;
    }

    const update = () => {
      updateComposerPlacement();
      updateChatBottomState();
    };
    const timers = [
      window.setTimeout(update, 80),
      window.setTimeout(update, 260)
    ];
    const raf = window.requestAnimationFrame(update);
    const observer = new ResizeObserver(() => update());
    const scroller = getChatScroller();
    [scroller, shellRef.current, chatThreadRef.current, composerRef.current]
      .filter((element, index, list): element is HTMLElement => Boolean(element) && list.indexOf(element) === index)
      .forEach((element) => observer.observe(element));
    window.addEventListener("resize", update);

    return () => {
      window.cancelAnimationFrame(raf);
      timers.forEach((timer) => window.clearTimeout(timer));
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [activeChat, activeChatId, chatIsLoading, timelineItems.length, messages.length, jobs.length, view]);

  useEffect(() => {
    if (!showChatThinkingIndicator || !chatStickToBottomRef.current) return;
    const raf = window.requestAnimationFrame(() => scrollChatToLatest("smooth"));
    return () => window.cancelAnimationFrame(raf);
  }, [showChatThinkingIndicator, activeChatId]);

  useEffect(() => {
    if (!activeChat || chatIsLoading) return;

    for (const item of timelineItems) {
      const { message } = item;
      if (message.role !== "assistant") continue;
      const actionKey = `changes:${message.id}`;
      if (expandedActions[actionKey] === false) continue;

      const jobId = messageJobId(message);
      const messageJob = jobs.find((job) => job.id === jobId);
      const progress = messageJob ? progressByJob[messageJob.id] ?? messageJob.progress ?? null : null;
      const stat = messageJob?.gitDiffStat || (typeof message.metadata?.gitDiffStat === "string" ? message.metadata.gitDiffStat : "");
      const diff = messageJob?.gitDiff || (typeof message.metadata?.gitDiff === "string" ? message.metadata.gitDiff : "");
      if (!stat && !progress?.files?.length) continue;

      const fileDiffs = parseUnifiedDiff(diff);
      const rows = fileDiffs.length ? diffRowsFromFileDiffs(fileDiffs) : diffRows(stat || null, progress?.files);
      const summary = fileDiffs.length ? diffSummaryFromRows(rows) : diffSummary(stat || null, progress);
      if (rows.length || summary.files <= 0) continue;

      if (messageJob?.id && !messageJob.gitDiff) {
        const requestKey = `job:${messageJob.id}:${messageJob.status}:${messageJob.gitDiffStat?.length ?? 0}:${messageJob.gitDiffOmitted ? 1 : 0}`;
        if (!missingChangeDetailsRequestedRef.current.has(requestKey)) {
          missingChangeDetailsRequestedRef.current.add(requestKey);
          loadJobDetails(messageJob.id).catch(() => undefined);
        }
      }

      if (message.metadata?.metadataOmitted || message.metadata?.gitDiffOmitted) {
        const requestKey = `message:${message.id}:${message.metadata?.metadataOmitted ? 1 : 0}:${message.metadata?.gitDiffOmitted ? 1 : 0}`;
        if (!missingChangeDetailsRequestedRef.current.has(requestKey)) {
          missingChangeDetailsRequestedRef.current.add(requestKey);
          loadMessageDetails(message.id).catch(() => undefined);
        }
      }
    }
  }, [activeChat, chatIsLoading, expandedActions, jobs, messages, progressByJob, timelineItems]);

  useEffect(() => {
    const now = Date.now();
    if (rawLocalCodexBusy) {
      const detectedAt = localActivity?.busySinceAt || localActivity?.updatedAt || localActivity?.detectedAt || new Date(now).toISOString();
      setLocalBusyHold((current) => ({
        until: now + 7000,
        since: current.key === localBusyActivityKey ? current.since ?? detectedAt : detectedAt,
        key: localBusyActivityKey
      }));
      return;
    }
    if ((staleCurrentWebJob || staleLocalWebBusy) && localBusyHold.since) {
      setLocalBusyHold({ until: 0 });
      return;
    }
    if (localBusyHold.until <= now && localBusyHold.since) setLocalBusyHold({ until: 0 });
  }, [
    rawLocalCodexBusy,
    staleCurrentWebJob,
    staleLocalWebBusy,
    localActivity?.busySinceAt,
    localActivity?.updatedAt,
    localActivity?.detectedAt,
    localBusyActivityKey,
    selectedAgent?.current_job_id,
    nowTick,
    localBusyHold.until,
    localBusyHold.since,
    localBusyHold.key
  ]);

  useEffect(() => {
    if (!localCodexBusy && !activeRunBusy) return;
    const timer = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [localCodexBusy, activeRunBusy]);

  useEffect(() => {
    const messageIds = messages.map((message) => message.id);
    const nextIds = new Set(messageIds);
    const nextSignatures = new Map(messages.map((message) => [message.id, messageUpdateSignature(message)]));

    if (currentScrollChatRef.current !== activeChatId) {
      currentScrollChatRef.current = activeChatId;
      previousMessageIdsRef.current = nextIds;
      previousMessageSignaturesRef.current = nextSignatures;
      setHighlightedMessageIds(new Set());
      setShowJumpToLatest(false);
      chatStickToBottomRef.current = true;
      window.requestAnimationFrame(() => scrollChatToLatest("auto"));
      return;
    }

    const newIds = messageIds.filter((id) => !previousMessageIdsRef.current.has(id));
    const updatedIds = messages
      .filter((message) => previousMessageIdsRef.current.has(message.id))
      .filter((message) => previousMessageSignaturesRef.current.get(message.id) !== nextSignatures.get(message.id))
      .map((message) => message.id);
    const changedIds = [...new Set([...newIds, ...updatedIds])];
    previousMessageIdsRef.current = nextIds;
    previousMessageSignaturesRef.current = nextSignatures;
    if (!changedIds.length) return;

    setHighlightedMessageIds((current) => new Set([...current, ...changedIds]));
    window.setTimeout(() => {
      setHighlightedMessageIds((current) => {
        const next = new Set(current);
        changedIds.forEach((id) => next.delete(id));
        return next;
      });
    }, 1400);

    const shouldStickToBottom = chatStickToBottomRef.current;
    window.requestAnimationFrame(() => {
      if (shouldStickToBottom) {
        scrollChatToLatest("smooth");
        window.setTimeout(() => {
          if (chatStickToBottomRef.current) scrollChatToLatest("smooth");
        }, 180);
      }
      else {
        setShowJumpToLatest(true);
        setShowChatScrollBottom(true);
      }
    });
  }, [activeChatId, messages]);

  useEffect(() => {
    if (!imagePreview) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setImagePreview(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [imagePreview]);

  useEffect(() => {
    if (view !== "sync" || !csrf || !selectedAgent || selectedAgent.status !== "online" || vscodeBusy) return;
    if (syncAutoPingRef.current === selectedAgent.id) return;
    syncAutoPingRef.current = selectedAgent.id;
    void runVscodeCommand("ping", selectedAgent.id);
  }, [csrf, selectedAgent?.id, selectedAgent?.status, view, vscodeBusy]);

  useEffect(() => {
    if (!csrf || !activeJob || !isTerminalJobStatus(activeJob.status) || !activeJob.codexThreadId) return;
    if (!pendingVscodeThreadRefreshRef.current.has(activeJob.id)) return;
    pendingVscodeThreadRefreshRef.current.delete(activeJob.id);
    void runVscodeCommand("refreshThreadIfOpen", activeJob.agentId, { threadId: activeJob.codexThreadId }, { auto: true });
  }, [activeJob?.agentId, activeJob?.codexThreadId, activeJob?.id, activeJob?.status, csrf]);

  async function login(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setAuthNotice("");
    const response = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ email, password })
    });
    const data = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) {
      setAuthNotice(data.error === "user_blocked" ? "Аккаунт заблокирован." : "Не получилось войти: проверь email и пароль.");
      return;
    }
    setCurrentUser(data.user);
    setCsrf(data.csrfToken);
    refresh();
  }

  async function register(event: React.FormEvent) {
    event.preventDefault();
    if (!registrationOpen) {
      setAuthMode("login");
      setAuthNotice("Регистрация временно закрыта.");
      return;
    }
    setBusy(true);
    setAuthNotice("");
    const response = await api("/api/register", {
      method: "POST",
      body: JSON.stringify({ email, password, nickname: registerNickname.trim() })
    });
    const data = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) {
      setAuthNotice(data.error === "registration_closed" ? "Регистрация временно закрыта." : data.error === "user_exists" ? "Пользователь с таким email уже есть." : data.error === "nickname_taken" ? "Этот nickname уже занят." : "Регистрация не получилась.");
      return;
    }
    setCurrentUser(data.user);
    setCsrf(data.csrfToken);
    refresh();
  }

  function projectStartPromptWithSetup(promptText: string) {
    const details = [
      `Project: ${projectName.trim() || "Untitled"}`,
      `Folder: ${projectPath.trim() || "not set"}`,
      projectGithubUrl.trim() ? `GitHub: ${projectGithubUrl.trim()}` : "",
      projectServerPath.trim() ? `Server folder: ${projectServerPath.trim()}` : "",
      normalizeProjectDomain(projectDomain) ? `Domain: ${normalizeProjectDomain(projectDomain)}` : "",
      projectDraftDeployConfig ? `Deploy: ${projectDraftDeployConfig.mode}${projectDraftDeployConfig.mode === "ssh" ? ` via ${projectDraftDeployConfig.sshTarget}` : ""}, source ${projectDraftDeployConfig.sourceDir}` : "Deploy: not configured",
      projectDraftDataConfig ? `Data storage: ${projectDraftDataConfig.location}, ${projectDraftDataConfig.path}` : "",
      `Default sandbox: ${SANDBOX_LABELS[sandbox]}`
    ].filter(Boolean);
    return `${promptText.trim()}\n\nProject setup:\n${details.map((item) => `- ${item}`).join("\n")}`;
  }

  async function startProjectPrompt(repo: { agentId: string; id: string }, promptText: string): Promise<boolean> {
    if (!csrf || !promptText.trim()) return false;
    if (localCodexBusy) {
      setChatNoticeOk(false);
      setChatNotice("Локальный Codex сейчас занят в VS Code или другом локальном чате. Дождись завершения, потом можно запускать задачу из web.");
      return false;
    }
    const promptWithSetup = projectStartPromptWithSetup(promptText);
    const chatResponse = await api("/api/chats", {
      method: "POST",
      headers: { "x-csrf-token": csrf },
      body: JSON.stringify({
        agentId: repo.agentId,
        repoId: repo.id,
        title: promptText.slice(0, 120)
      })
    });
    const chatData = await chatResponse.json().catch(() => ({}));
    if (!chatResponse.ok) {
      setChatNoticeOk(false);
      setChatNotice(chatData.error || "Start prompt chat create failed.");
      return false;
    }

    const chatId = chatData.chatId as string;
    const response = await api("/api/jobs", {
      method: "POST",
      headers: { "x-csrf-token": csrf },
      body: JSON.stringify({
        agentId: repo.agentId,
        repoId: repo.id,
        chatId,
        prompt: promptWithSetup,
        sandbox,
        branchMode: "current",
        model: codexModel,
        reasoningEffort,
        speed: codexSpeed,
        attachments: []
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      setChatNoticeOk(false);
      setChatNotice(data.error || "Start prompt job failed.");
      return false;
    }
    setRepoKey(`${repo.agentId}:${repo.id}`);
    setActiveChatId(chatId);
    setProjectStartPrompt("");
    setChatNoticeOk(true);
    setChatNotice("Стартовый prompt запущен. Когда Codex закончит, можно нажать Launch для GitHub и деплоя.");
    await loadChat(chatId, data.jobId);
    return true;
  }

  async function saveProject(event: React.FormEvent) {
    event.preventDefault();
    const isNew = projectPanel === "new";
    const targetAgent = isNew ? projectFormAgent : selectedRepoAgent ?? selectedAgent;
    if (!csrf || !targetAgent || !projectName.trim() || !projectPath.trim()) return;
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const shouldRunPrompt = submitter?.value === "run-prompt" && Boolean(projectStartPrompt.trim());
    if ((isNew || projectSettingsNeedsAgent) && !projectSaveAgentOnline) {
      setProjectNotice(isNew
        ? "Выбранный агент offline. Новый проект можно сохранить после подключения агента."
        : "Агент проекта offline. Сейчас можно сохранить только Public/Private для Search; локальные поля сохранятся после подключения агента.");
      return;
    }
    setBusy(true);
    const normalizedDomain = normalizeProjectDomain(projectDomain);
    const deployConfig = projectDraftDeployConfig;
    const dataConfig = projectDraftDataConfig;
    const body: Record<string, unknown> = isNew ? {
      agentId: targetAgent.id,
      name: projectName.trim(),
      path: projectPath.trim(),
      githubUrl: projectGithubUrl.trim(),
      serverPath: projectServerPath.trim(),
      domain: normalizedDomain,
      visibility: projectVisibility,
      deploy: deployConfig,
      data: dataConfig,
      defaultSandbox: sandbox
    } : {
      visibility: projectVisibility
    };
    if (!isNew) {
      if (projectName.trim() !== selectedRepo?.name) body.name = projectName.trim();
      if (projectPath.trim() !== originalProjectPath) body.path = projectPath.trim();
      if (projectGithubUrl.trim() !== (selectedRepo?.githubUrl ?? "")) body.githubUrl = projectGithubUrl.trim();
      if (projectServerPath.trim() !== (selectedRepo?.serverPath ?? "")) body.serverPath = projectServerPath.trim();
      if (normalizedDomain !== (selectedRepo?.domain ?? "")) body.domain = normalizedDomain;
      if (JSON.stringify(deployConfig) !== JSON.stringify(selectedRepo?.deploy ?? null)) body.deploy = deployConfig;
      if (JSON.stringify(dataConfig) !== JSON.stringify(selectedRepo?.data ?? null)) body.data = dataConfig;
      if (sandbox !== selectedRepo?.defaultSandbox) body.defaultSandbox = sandbox;
    }
    const response = await api(isNew ? "/api/projects" : `/api/projects/${selectedRepo?.agentId}/${selectedRepo?.id}`, {
      method: isNew ? "POST" : "PUT",
      headers: { "x-csrf-token": csrf },
      body: JSON.stringify(body)
    });
    setBusy(false);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      setChatNoticeOk(false);
      setChatNotice(data.error === "agent_local_busy"
        ? "Локальный Codex сейчас занят в VS Code или другом локальном чате. Дождись завершения, потом можно запускать задачу из web."
        : data.error === "agent_offline"
          ? "Агент проекта offline. Public/Private можно сохранить отдельно, а локальные поля проекта - после подключения агента."
          : data.error || "Job start failed.");
      return;
    }
    const data = await response.json();
    const savedRepoId = isNew ? data.repoId as string | undefined : selectedRepo?.id;
    const savedAgentId = isNew ? targetAgent.id : selectedRepo?.agentId ?? targetAgent.id;
    await refresh();
    if (isNew && data.repoId) {
      setRepoKey(`${targetAgent.id}:${data.repoId}`);
      setSandbox("danger-full-access");
    }
    if (shouldRunPrompt && savedRepoId) {
      const started = await startProjectPrompt({ agentId: savedAgentId, id: savedRepoId }, projectStartPrompt.trim());
      setBusy(false);
      if (!started) return;
    } else {
      setBusy(false);
    }
    setProjectPanel(null);
  }

  async function deleteProject() {
    if (!csrf || !selectedRepo) return;
    const activeInProject = activeJob?.agentId === selectedRepo.agentId && activeJob.repoId === selectedRepo.id && ["queued", "assigned", "running"].includes(activeJob.status);
    if (activeInProject) {
      setProjectNotice("Stop the running job before removing this project from the service.");
      return;
    }
    setBusy(true);
    setProjectNotice("");
    const response = await api(`/api/projects/${selectedRepo.agentId}/${selectedRepo.id}`, {
      method: "DELETE",
      headers: { "x-csrf-token": csrf },
      body: "{}"
    });
    const data = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) {
      setProjectNotice(data.error === "project_has_running_job" ? "Stop the running job before removing this project from the service." : data.error || "Project remove failed.");
      return;
    }
    clearProjectSelection();
    await refresh();
  }

  async function createChat(event: React.FormEvent) {
    event.preventDefault();
    if (!selectedRepo || !csrf || !chatTitle.trim()) return;
    setBusy(true);
    const response = await api("/api/chats", {
      method: "POST",
      headers: { "x-csrf-token": csrf },
      body: JSON.stringify({ agentId: selectedRepo.agentId, repoId: selectedRepo.id, title: chatTitle.trim() })
    });
    setBusy(false);
    if (!response.ok) return;
    const { chatId } = await response.json();
    setChatTitle("");
    setMobileMenuOpen(false);
    await loadChats(selectedRepo);
    await loadChat(chatId);
  }

  async function createJob(event: React.FormEvent) {
    event.preventDefault();
    if (!selectedRepo || (!prompt.trim() && !attachments.length) || !csrf) return;
    if (localCodexBusy) {
      setChatNoticeOk(false);
      setChatNotice("Локальный Codex сейчас занят в VS Code или другом локальном чате. Дождись завершения, потом можно запускать задачу из web.");
      return;
    }
    let targetChatId = activeChatId;
    const promptText = prompt.trim() || "Посмотри вложенные файлы.";
    setBusy(true);
    if (!targetChatId) {
      const chatResponse = await api("/api/chats", {
        method: "POST",
        headers: { "x-csrf-token": csrf },
        body: JSON.stringify({
          agentId: selectedRepo.agentId,
          repoId: selectedRepo.id,
          title: promptText.slice(0, 120)
        })
      });
      if (!chatResponse.ok) {
        setBusy(false);
        return;
      }
      targetChatId = (await chatResponse.json()).chatId;
      setActiveChatId(targetChatId);
    }
    const response = await api("/api/jobs", {
      method: "POST",
      headers: { "x-csrf-token": csrf },
      body: JSON.stringify({
        agentId: selectedRepo.agentId,
        repoId: selectedRepo.id,
        chatId: targetChatId,
        prompt: promptText,
        sandbox,
        branchMode: "current",
        model: codexModel,
        reasoningEffort,
        speed: codexSpeed,
        attachments: attachments.map((attachment) => ({
          name: attachment.name,
          mimeType: attachment.mimeType,
          size: attachment.size,
          dataBase64: attachment.dataBase64
        }))
      })
    });
    setBusy(false);
    if (!response.ok) return;
    const { jobId } = await response.json();
    setPrompt("");
    setAttachments([]);
    setAttachmentNotice("");
    setVscodeNotice("");
    await loadChat(targetChatId, jobId);
  }

  async function shareChat(chat = activeChat) {
    if (!chat || !csrf) return;
    setShareBusy(true);
    setChatNotice("");
    setChatNoticeOk(false);
    setChatMenuId("");
    const response = await api(`/api/chats/${encodeURIComponent(chat.id)}/share`, {
      method: "POST",
      headers: { "x-csrf-token": csrf },
      body: "{}"
    });
    const data = await response.json().catch(() => ({}));
    setShareBusy(false);
    if (!response.ok) {
      setChatNotice(data.error || "Не получилось создать публичную ссылку на чат.");
      setChatNoticeOk(false);
      return;
    }
    const url = String(data.url || data.share?.url || "");
    if (url) {
      await navigator.clipboard?.writeText(url).catch(() => undefined);
      setChatNotice(`Ссылка на чат скопирована: ${url}`);
      setChatNoticeOk(true);
      return;
    }
    setChatNotice("Публичная ссылка создана, но сервер не вернул URL.");
    setChatNoticeOk(false);
  }

  async function hideChat(chat: Chat) {
    if (!csrf || !selectedRepo) return;
    const activeInChat = activeJob?.chatId === chat.id && ["queued", "assigned", "running"].includes(activeJob.status);
    if (activeInChat) return;
    setBusy(true);
    setChatNotice("");
    setChatNoticeOk(false);
    const response = await api(`/api/chats/${chat.id}/hide`, {
      method: "POST",
      headers: { "x-csrf-token": csrf },
      body: "{}"
    });
    const data = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) {
      setChatNoticeOk(false);
      setChatNotice(data.error === "chat_has_running_job" ? "Stop the running job before hiding this chat." : data.error || "Chat hide failed.");
      return;
    }
    setChatMenuId("");
    const nextChats = chats.filter((item) => item.id !== chat.id);
    setChats(nextChats);
    if (activeChatId === chat.id) {
      resetActiveChatView();
    }
    await loadChats(selectedRepo);
  }

  async function renameChat(event: React.FormEvent, chat: Chat) {
    event.preventDefault();
    if (!csrf || !selectedRepo) return;
    const title = renameTitle.trim();
    if (!title) return;
    setBusy(true);
    setChatNotice("");
    setChatNoticeOk(false);
    const response = await api(`/api/chats/${encodeURIComponent(chat.id)}`, {
      method: "PUT",
      headers: { "x-csrf-token": csrf },
      body: JSON.stringify({ title })
    });
    const data = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) {
      setChatNoticeOk(false);
      setChatNotice(data.error || "Chat rename failed.");
      return;
    }
    const updated = data.chat as Chat;
    setChats((current) => current.map((item) => item.id === updated.id ? updated : item));
    if (chatProperties?.id === updated.id) {
      setChatProperties(updated);
      setChatSettingsTitle(updated.title);
    }
    cancelRenameChat();
    await loadChats(selectedRepo);
  }

  async function saveChatProperties(event: React.FormEvent) {
    event.preventDefault();
    if (!csrf || !selectedRepo || !chatProperties) return;
    setBusy(true);
    setChatNotice("");
    setChatNoticeOk(false);
    const response = await api(`/api/chats/${chatProperties.id}`, {
      method: "PUT",
      headers: { "x-csrf-token": csrf },
      body: JSON.stringify({
        title: chatSettingsTitle.trim(),
        linkedChatId: linkedChatId || undefined
      })
    });
    const data = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) {
      setChatNoticeOk(false);
      setChatNotice(data.error || "Chat properties save failed.");
      return;
    }
    setChatProperties(data.chat);
    await loadChats(selectedRepo);
    if (linkedChatId || activeChatId === data.chat.id) await loadChat(data.chat.id);
    setLinkedChatId("");
  }

  async function restoreHiddenChat(chat: Chat) {
    if (!csrf || !selectedRepo) return;
    setBusy(true);
    const response = await api(`/api/chats/${chat.id}/unhide`, {
      method: "POST",
      headers: { "x-csrf-token": csrf },
      body: "{}"
    });
    setBusy(false);
    if (!response.ok) return;
    await loadChats(selectedRepo);
    await loadHiddenLocalChats(selectedRepo);
  }

  async function addFiles(files: FileList | File[]) {
    const list = Array.from(files);
    if (!list.length) return;
    setAttachmentNotice("");
    const currentSize = attachments.reduce((sum, item) => sum + item.size, 0);
    const nextSize = list.reduce((sum, file) => sum + file.size, currentSize);
    if (attachments.length + list.length > 8) {
      setAttachmentNotice("Можно прикрепить до 8 файлов к одному сообщению.");
      return;
    }
    if (list.some((file) => file.size > 5 * 1024 * 1024) || nextSize > 12 * 1024 * 1024) {
      setAttachmentNotice("Файл до 5 MB, суммарно до 12 MB на сообщение.");
      return;
    }
    try {
      const parsed = await Promise.all(list.map(readFileAttachment));
      setAttachments((current) => [...current, ...parsed]);
    } catch {
      setAttachmentNotice("Не получилось прочитать один из файлов.");
    }
  }

  function removeAttachment(id: string) {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id));
  }

  function handleComposerPaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files).filter((file) => file.size > 0);
    if (!files.length) return;
    event.preventDefault();
    addFiles(files);
  }

  function handleComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || !event.ctrlKey || event.repeat || event.nativeEvent.isComposing) return;
    const canSubmit = Boolean(prompt.trim() || attachments.length);
    if (busy || !canSubmit || localCodexBusy || activeRunBusy) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  async function cancelJob() {
    if (!activeJob || !csrf) return;
    await api(`/api/jobs/${activeJob.id}/cancel`, {
      method: "POST",
      headers: { "x-csrf-token": csrf },
      body: "{}"
    });
  }

  function addLocalProjectOperationMessage(operation: ProjectOperationKind, label: string, details: string[] = []) {
    if (!activeChatId || !selectedRepo) return "";
    const stamp = new Date().toISOString();
    const id = `local-project-operation:${operation}:${stamp}:${Math.random().toString(36).slice(2)}`;
    const message: ChatMessage = {
      id,
      chatId: activeChatId,
      role: "system",
      source: "web",
      externalId: id,
      content: projectOperationPendingContent(label, selectedRepo.name, details),
      metadata: {
        kind: "project-operation",
        operation,
        operationLabel: label,
        status: "running"
      },
      createdAt: stamp,
      attachments: []
    };
    setMessages((current) => [...current.filter((item) => item.id !== id), message]);
    return id;
  }

  function removeLocalProjectOperationMessage(messageId: string) {
    if (!messageId) return;
    setMessages((current) => current.filter((message) => message.id !== messageId));
  }

  async function runGitSync() {
    if (!selectedRepo || !csrf || !gitMessage.trim() || launchBusy || projectActionBusyRef.current.gitSync) return;
    projectActionBusyRef.current.gitSync = true;
    const targetChatId = activeChatId || activeChat?.id || "";
    const operationDetails = [`Сообщение коммита: \`${safeMarkdownInlineCode(gitMessage.trim())}\`.`];
    const pendingMessageId = targetChatId ? addLocalProjectOperationMessage("git-sync", "Commit & push", operationDetails) : "";
    setGitBusy(true);
    setActionMenuOpen(false);
    setProjectActionsOpen(false);
    setGitNotice(targetChatId ? "" : "Git sync started...");
    try {
      const response = await api(`/api/projects/${selectedRepo.agentId}/${selectedRepo.id}/git-sync`, {
        method: "POST",
        headers: { "x-csrf-token": csrf },
        body: JSON.stringify({
          message: gitMessage.trim(),
          remoteUrl: gitRemoteUrl.trim() || selectedRepo.githubUrl || undefined,
          chatId: targetChatId || undefined
        })
      });
      const data = await response.json().catch(() => ({}));
      removeLocalProjectOperationMessage(pendingMessageId);
      if (targetChatId) await loadChat(targetChatId).catch(() => undefined);
      if (!response.ok) {
        if (!targetChatId) setGitNotice(data.output || data.error || "Git sync failed.");
        return;
      }
      setGitRemoteUrl("");
      if (!targetChatId) setGitNotice(data.output || data.status || "Git sync completed.");
      await refresh();
    } catch (error) {
      removeLocalProjectOperationMessage(pendingMessageId);
      if (!targetChatId) setGitNotice(error instanceof Error ? error.message : "Git sync failed.");
    } finally {
      projectActionBusyRef.current.gitSync = false;
      setGitBusy(false);
    }
  }

  async function runVscodeCommand(
    command: VscodeCommand,
    agentId = selectedRepo?.agentId ?? selectedAgent?.id,
    payload: { text?: string; filePath?: string; threadId?: string } = {},
    options: { auto?: boolean } = {}
  ) {
    if (!agentId || !csrf) return;
    const requestSeq = ++vscodeRequestSeqRef.current;
    setVscodeBusy(true);
    setActionMenuOpen(false);
    setVscodeNotice(options.auto ? "Автоматически обновляю VS Code..." : "VS Code bridge command sent...");
    const response = await api(`/api/agents/${agentId}/vscode-command`, {
      method: "POST",
      headers: { "x-csrf-token": csrf },
      body: JSON.stringify({ command, ...payload })
    });
    const data = await response.json().catch(() => ({}));
    if (requestSeq !== vscodeRequestSeqRef.current) return;
    setVscodeBusy(false);
    if (!response.ok) {
      const errorText = data.error === "agent_replaced"
        ? "Агент переподключился во время VS Code команды. Нажми Ping ещё раз; если повторяется, запущены два агента с одним ID."
        : data.error === "agent_disconnected"
          ? "Агент отключился во время VS Code команды. Проверь, что Codex Agent или start-agent.bat всё ещё запущен."
          : data.output || data.error || "VS Code bridge command failed.";
      setVscodeNotice(errorText);
      return;
    }
    setVscodeNotice(data.output || (options.auto ? "VS Code chat refreshed." : "VS Code bridge command completed."));
  }

  async function syncGit(event: React.FormEvent) {
    event.preventDefault();
    await runGitSync();
  }

  async function deployProject() {
    if (!selectedRepo || !csrf || projectActionBusyRef.current.deploy) return;
    projectActionBusyRef.current.deploy = true;
    const targetChatId = activeChatId || activeChat?.id || "";
    const pendingMessageId = targetChatId ? addLocalProjectOperationMessage("deploy", "Deploy") : "";
    setDeployBusy(true);
    setActionMenuOpen(false);
    setDeployNotice(targetChatId ? "" : "Deploy started...");
    try {
      const response = await api(`/api/projects/${selectedRepo.agentId}/${selectedRepo.id}/deploy`, {
        method: "POST",
        headers: { "x-csrf-token": csrf },
        body: JSON.stringify({ chatId: targetChatId || undefined })
      });
      const data = await response.json().catch(() => ({}));
      removeLocalProjectOperationMessage(pendingMessageId);
      if (targetChatId) await loadChat(targetChatId).catch(() => undefined);
      if (!response.ok) {
        if (!targetChatId) setDeployNotice(data.output || data.error || "Deploy failed.");
        return;
      }
      if (!targetChatId) setDeployNotice(data.output || "Deploy completed.");
      await refresh();
    } catch (error) {
      removeLocalProjectOperationMessage(pendingMessageId);
      if (!targetChatId) setDeployNotice(error instanceof Error ? error.message : "Deploy failed.");
    } finally {
      projectActionBusyRef.current.deploy = false;
      setDeployBusy(false);
    }
  }

  async function configureNginx() {
    if (!selectedRepo || !csrf) return;
    setNginxBusy(true);
    setNginxNotice("Nginx setup started...");
    const response = await api(`/api/projects/${selectedRepo.agentId}/${selectedRepo.id}/nginx`, {
      method: "POST",
      headers: { "x-csrf-token": csrf },
      body: "{}"
    });
    const data = await response.json().catch(() => ({}));
    setNginxBusy(false);
    if (!response.ok) {
      setNginxNotice(data.output || data.error || "Nginx setup failed.");
      return;
    }
    setNginxNotice(data.output || "Nginx configured.");
    await refresh();
  }

  async function configureSsl() {
    if (!selectedRepo || !csrf) return;
    setSslBusy(true);
    setSslNotice("SSL setup started...");
    const response = await api(`/api/projects/${selectedRepo.agentId}/${selectedRepo.id}/ssl`, {
      method: "POST",
      headers: { "x-csrf-token": csrf },
      body: "{}"
    });
    const data = await response.json().catch(() => ({}));
    setSslBusy(false);
    if (!response.ok) {
      setSslNotice(data.output || data.error || "SSL setup failed.");
      return;
    }
    setSslNotice(data.output || "SSL configured.");
    await refresh();
  }

  async function launchProject() {
    if (!selectedRepo || !csrf) return;
    const output: string[] = [];
    const append = (label: string, text: string) => {
      output.push(`== ${label} ==\n${text}`);
      setLaunchNotice(output.join("\n\n"));
    };
    const callProjectAction = async (label: string, path: string, body: Record<string, unknown> = {}) => {
      setLaunchNotice([...output, `== ${label} ==\nRunning...`].join("\n\n"));
      const response = await api(path, {
        method: "POST",
        headers: { "x-csrf-token": csrf },
        body: JSON.stringify(body)
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.output || data.error || `${label} failed.`);
      append(label, data.output || "Done.");
      return data;
    };

    setLaunchBusy(true);
    setActionMenuOpen(false);
    setLaunchNotice("Launch started...");
    try {
      const remoteUrl = gitRemoteUrl.trim() || selectedRepo.githubUrl || "";
      if (remoteUrl) {
        try {
          const data = await callProjectAction(
            "GitHub + push",
            `/api/projects/${selectedRepo.agentId}/${selectedRepo.id}/git-sync`,
            {
              message: gitMessage.trim() || `Launch ${selectedRepo.name}`,
              remoteUrl,
              createRemote: true,
              remoteVisibility: "private"
            }
          );
          setGitNotice(data.output || "GitHub sync completed.");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          append("GitHub + push", `Failed, continuing local launch.\n${message}`);
          setGitNotice(message);
        }
      } else {
        append("GitHub + push", "Skipped: GitHub repository is not configured.");
      }

      if (hasDeployConfig(selectedRepo)) {
        const data = await callProjectAction("Deploy", `/api/projects/${selectedRepo.agentId}/${selectedRepo.id}/deploy`);
        setDeployNotice(data.output || "Deploy completed.");
      } else {
        append("Deploy", "Skipped: server folder or deploy mode is not configured.");
      }

      if (selectedRepo.domain) {
        const data = await callProjectAction("Nginx", `/api/projects/${selectedRepo.agentId}/${selectedRepo.id}/nginx`);
        setNginxNotice(data.output || "Nginx configured.");
      } else {
        append("Nginx", "Skipped: domain is not configured.");
      }

      if (selectedRepo.domain) {
        const data = await callProjectAction("SSL", `/api/projects/${selectedRepo.agentId}/${selectedRepo.id}/ssl`);
        setSslNotice(data.output || "SSL configured.");
      }

      const url = projectUrl(selectedRepo.domain);
      if (url) append("Open", url);
    } catch (error) {
      append("Launch failed", error instanceof Error ? error.message : String(error));
    } finally {
      setLaunchBusy(false);
      await refresh();
    }
  }

  async function createUser(event: React.FormEvent) {
    event.preventDefault();
    if (!csrf || currentUser?.role !== "admin" || !newUserEmail.trim() || !newUserPassword) return;
    setBusy(true);
    setSettingsNotice("");
    const response = await api("/api/users", {
      method: "POST",
      headers: { "x-csrf-token": csrf },
      body: JSON.stringify({ email: newUserEmail.trim(), password: newUserPassword, role: newUserRole })
    });
    setBusy(false);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      setSettingsNotice(data.error || "User create failed.");
      return;
    }
    setNewUserEmail("");
    setNewUserPassword("");
    setNewUserRole("user");
    setSettingsNotice("User created.");
    await loadUsers();
  }

  async function selectAdminUser(userId: string) {
    setAdminSelectedUserId(userId);
    setAdminOpenedChat(null);
    setAdminNotice("");
    await loadAdminChats(userId);
  }

  async function adminChangePassword(event: React.FormEvent) {
    event.preventDefault();
    if (!csrf || !adminSelectedUserId || adminPassword.length < 8) return;
    setBusy(true);
    setAdminNotice("");
    const response = await api(`/api/admin/users/${encodeURIComponent(adminSelectedUserId)}/password`, {
      method: "POST",
      headers: { "x-csrf-token": csrf },
      body: JSON.stringify({ password: adminPassword })
    });
    const data = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) {
      setAdminNotice(data.error || "Пароль не изменился.");
      return;
    }
    setAdminPassword("");
    setAdminNotice("Пароль изменён.");
  }

  async function adminToggleBlock(user: AdminUser) {
    if (!csrf) return;
    setBusy(true);
    setAdminNotice("");
    const response = await api(`/api/admin/users/${encodeURIComponent(user.id)}/block`, {
      method: "POST",
      headers: { "x-csrf-token": csrf },
      body: JSON.stringify({ blocked: !user.blockedAt })
    });
    const data = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) {
      setAdminNotice(data.error === "cannot_block_self" ? "Себя заблокировать нельзя." : data.error || "Статус пользователя не изменился.");
      return;
    }
    setAdminNotice(data.user?.blockedAt ? "Пользователь заблокирован." : "Пользователь разблокирован.");
    await loadAdminUsers(user.id);
  }

  async function adminImpersonate(user: AdminUser) {
    if (!csrf || user.blockedAt) return;
    setBusy(true);
    setAdminNotice("");
    const response = await api(`/api/admin/users/${encodeURIComponent(user.id)}/impersonate`, {
      method: "POST",
      headers: { "x-csrf-token": csrf },
      body: "{}"
    });
    const data = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) {
      setAdminNotice(data.error === "user_blocked" ? "Пользователь заблокирован." : data.error || "Не получилось авторизоваться за пользователя.");
      return;
    }
    setCurrentUser(data.user);
    setCsrf(data.csrfToken);
    window.location.href = "/";
  }

  async function adminOpenChat(chat: AdminChat) {
    const response = await api(`/api/chats/${encodeURIComponent(chat.id)}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      setAdminNotice(data.error || "Чат не открылся.");
      return;
    }
    setAdminOpenedChat({ chat: data.chat, messages: data.messages ?? [], jobs: data.jobs ?? [] });
  }

  function toggleAdminMetric(metric: AdminStatsMetric) {
    setAdminStatsVisible((current) => ({ ...current, [metric]: !current[metric] }));
  }

  async function createAgent(event: React.FormEvent) {
    event.preventDefault();
    if (!csrf || !newAgentName.trim()) return;
    await createAgentSetup(newAgentName.trim(), newAgentId.trim() || undefined, currentUser?.role === "admin" ? newAgentUserId || undefined : undefined);
  }

  async function createAgentSetup(name: string, agentId?: string, userId?: string, setupPlatform: "windows" | "linux" = "windows") {
    if (!csrf || !name.trim()) return;
    setBusy(true);
    setSettingsNotice("");
    const response = await api("/api/agents", {
      method: "POST",
      headers: { "x-csrf-token": csrf },
      body: JSON.stringify({
        name: name.trim(),
        id: agentId?.trim() || undefined,
        userId,
        setupPlatform
      })
    });
    setBusy(false);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      setSettingsNotice(data.error || "Agent create failed.");
      return;
    }
    setAgentSetup(data.setup);
    setNewAgentId("");
    setSettingsNotice("Agent created. Save the setup script now; the token is shown only once.");
    await refresh();
  }

  async function createAnotherComputerSetup() {
    const stamp = new Date();
    const suffix = [
      stamp.getFullYear(),
      String(stamp.getMonth() + 1).padStart(2, "0"),
      String(stamp.getDate()).padStart(2, "0"),
      String(stamp.getHours()).padStart(2, "0"),
      String(stamp.getMinutes()).padStart(2, "0")
    ].join("");
    await createAgentSetup(`Windows Agent ${suffix}`, `windows-${suffix}`, currentUser?.role === "admin" ? newAgentUserId || undefined : undefined);
  }

  async function downloadAgentSetup(agentOverride?: Agent, setupPlatform: "windows" | "linux" = "windows") {
    if (!csrf || busy) return;
    setBusy(true);
    setSyncNotice("");
    setSettingsNotice("");
    const targetAgent = agentOverride ?? selectedAgent;
    const existingOfflineAgent = targetAgent && targetAgent.status !== "online" ? targetAgent : null;
    const response = existingOfflineAgent
      ? await api(`/api/agents/${encodeURIComponent(existingOfflineAgent.id)}/setup`, {
        method: "POST",
        headers: { "x-csrf-token": csrf },
        body: JSON.stringify({ setupPlatform })
      })
      : await api("/api/agents", {
        method: "POST",
        headers: { "x-csrf-token": csrf },
        body: JSON.stringify({
          name: setupPlatform === "linux" ? "Server Ubuntu" : "Home Windows Agent",
          id: setupPlatform === "linux" ? "agent-linux" : "home-windows",
          setupPlatform
        })
      });
    setBusy(false);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      setSyncNotice(data.error === "agent_online"
        ? "Агент уже online: новый setup-файл не нужен."
        : data.error || "Не получилось подготовить setup-файл.");
      return;
    }
    const setup = data.setup as AgentSetup | undefined;
    if (!setup?.setupBatch && !setup?.setupPowerShell && !setup?.setupShell) {
      setSyncNotice("Сервер не вернул setup-файл.");
      return;
    }
    setAgentSetup(setup);
    const setupText = setupPlatform === "linux" ? setup.setupShell : setup.setupBatch || setup.setupPowerShell;
    downloadTextFile(setup.setupFileName || (setupPlatform === "linux" ? "setup-agent-linux.sh" : "setup-agent.bat"), setupText ?? "", setupPlatform === "linux" ? "text/x-shellscript;charset=utf-8" : "application/x-bat;charset=utf-8");
    const notice = setupPlatform === "linux"
      ? "Скачал setup-agent-linux.sh. На сервере запусти: bash setup-agent-linux.sh; затем выполни codex login, если CLI ещё не авторизован."
      : "Скачал setup-agent.bat. Он скачает компактный agent-package.zip и запустит агента без клонирования репозитория.";
    setSyncNotice(notice);
    setSettingsNotice(notice);
    await refresh();
  }

  async function downloadLinuxAgentSetup() {
    const linuxAgent = agents.find((agent) => agent.id === "agent-linux")
      ?? agents.find((agent) => isLinuxAgent(agent) && agent.status !== "online");
    await downloadAgentSetup(linuxAgent, "linux");
  }

  async function deleteAgent(agent: Agent) {
    if (!csrf || busy) return;
    const agentRepos = repos.filter((repo) => repo.agentId === agent.id);
    if (agent.status === "online" || agentRepos.length) {
      setSyncNotice("Удалять можно только offline-агента без проектов.");
      return;
    }
    if (!window.confirm(`Удалить подключение "${agent.name}"? Это действие нельзя отменить.`)) return;
    setBusy(true);
    setSyncNotice("");
    const response = await api(`/api/agents/${encodeURIComponent(agent.id)}`, {
      method: "DELETE",
      headers: { "x-csrf-token": csrf },
      body: "{}"
    });
    setBusy(false);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = data.error === "agent_online"
        ? "Агент online: сначала останови его на компьютере."
        : data.error === "agent_has_data"
          ? "У агента есть проекты, чаты или задачи. Сначала удали/перенеси данные."
          : data.error || "Не получилось удалить агента.";
      setSyncNotice(message);
      return;
    }
    setAgents((current) => current.filter((item) => item.id !== agent.id));
    setSyncNotice(`Агент ${agent.name} удалён.`);
    await refresh();
  }

  function showAgentStopGuide(agent: Agent) {
    const lines = isLinuxAgent(agent) ? [
      `${agent.name} останавливается на сервере ${agent.hostname || agent.id}.`,
      "",
      "Если установлен systemd runtime-agent:",
      "systemctl stop codex-agent-linux.service",
      "",
      "Если сервис запущен не от root:",
      "systemctl --user stop codex-agent-linux.service",
      "",
      "Файлы агента обычно лежат в ~/codex-agent."
    ] : [
      `${agent.name} останавливается только на компьютере ${agent.hostname || agent.id}.`,
      "",
      "Если установлен runtime-агент:",
      "%USERPROFILE%\\codex-agent\\stop-agent.bat",
      "",
      "Если Windows пишет Access is denied, запусти этот .bat через Run as administrator.",
      "",
      "Если открыт Codex Agent native app, нажми Stop в его окне."
    ];
    setSyncNotice(lines.join("\n"));
  }

  async function saveProfile(event: React.FormEvent) {
    event.preventDefault();
    if (!csrf) return;
    setBusy(true);
    setProfileNotice("");
    const response = await api("/api/profile", {
      method: "PUT",
      headers: { "x-csrf-token": csrf },
      body: JSON.stringify({
        nickname: profileNickname.trim(),
        bio: profileBio,
        avatarDataUrl: profileAvatarDataUrl
      })
    });
    const data = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) {
      setProfileNotice(data.error === "nickname_taken" ? "Этот nickname уже занят." : data.error || "Profile update failed.");
      return;
    }
    setCurrentUser(data.user);
    setProfileStatsData(data.stats);
    setOauthProviders(data.oauth);
    setProfileNotice("Profile saved.");
  }

  async function changePassword(event: React.FormEvent) {
    event.preventDefault();
    if (!csrf || !currentPassword || !newPassword) return;
    setBusy(true);
    setProfileNotice("");
    const response = await api("/api/profile/password", {
      method: "POST",
      headers: { "x-csrf-token": csrf },
      body: JSON.stringify({ currentPassword, newPassword })
    });
    const data = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) {
      setProfileNotice(data.error === "invalid_current_password" ? "Текущий пароль неверный." : data.error || "Password change failed.");
      return;
    }
    setCurrentPassword("");
    setNewPassword("");
    setProfileNotice("Password changed.");
  }

  async function connectOAuth(provider: OAuthProvider["provider"]) {
    if (!csrf) return;
    setBusy(true);
    setProfileNotice("");
    const response = await api(`/api/profile/oauth/${provider}/start`, {
      method: "POST",
      headers: { "x-csrf-token": csrf },
      body: "{}"
    });
    const data = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) {
      setProfileNotice(data.error === "oauth_provider_not_configured" ? "OAuth для этого провайдера пока не настроен на сервере." : data.error || "OAuth start failed.");
      return;
    }
    if (data.url) location.href = data.url;
  }

  async function startAuthOAuth(provider: OAuthProvider["provider"]) {
    setBusy(true);
    setAuthNotice("");
    const response = await api(`/api/oauth/${provider}/start`, {
      method: "POST",
      body: JSON.stringify({ returnTo: "/" })
    });
    const data = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) {
      setAuthNotice(data.error === "oauth_provider_not_configured" ? `${oauthLabel(provider)} OAuth ещё не настроен на сервере.` : data.error || "OAuth start failed.");
      return;
    }
    if (data.url) location.href = data.url;
  }

  function updateProfileAvatar(file?: File) {
    if (!file) return;
    if (!isPreviewableImage(file.type) || file.size > 1024 * 1024) {
      setProfileNotice("Аватарка: PNG/JPEG/WebP/GIF/AVIF/BMP до 1 MB.");
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => setProfileNotice("Не получилось прочитать аватарку.");
    reader.onload = () => {
      setProfileAvatarDataUrl(String(reader.result ?? ""));
      setProfileNotice("");
    };
    reader.readAsDataURL(file);
  }

  function oauthIcon(provider: OAuthProvider["provider"]) {
    if (provider === "github") return <Github size={17} />;
    if (provider === "mailru") return <Mail size={17} />;
    return <Link2 size={17} />;
  }

  function oauthLabel(provider: OAuthProvider["provider"]) {
    return provider === "mailru" ? "Mail.ru" : provider === "vk" ? "VK ID" : provider === "github" ? "GitHub" : "Google";
  }

  function renderSearch() {
    const emptyLabel = searchQuery.trim()
      ? "Ничего не найдено."
      : searchType === "projects" ? "Публичных проектов пока нет." : "Пользователей пока нет.";
    return (
      <section className="settings-work search-work">
        <section className="project-form wide">
          <div className="section-head">
            <h2><Search size={18} /> Search</h2>
            <button className="secondary" type="button" onClick={() => void loadPublicSearch()}><RefreshCw size={16} /> Refresh</button>
          </div>
          <div className="search-controls">
            <input
              placeholder={searchType === "projects" ? "Искать публичные проекты, домены, авторов..." : "Искать профили по email, nickname, bio..."}
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
            />
            <div className="segments">
              <button className={searchType === "projects" ? "active" : ""} type="button" onClick={() => {
                setSearchType("projects");
                setSearchOpenedChat(null);
              }}>Projects</button>
              <button className={searchType === "profiles" ? "active" : ""} type="button" onClick={() => {
                setSearchType("profiles");
                setSearchOpenedChat(null);
              }}>Profiles</button>
            </div>
          </div>

          {searchNotice && <div className="notice danger">{searchNotice}</div>}

          {searchType === "projects" ? (
            <div className="public-result-list">
              {searchProjects.map((project) => (
                <article className="public-project-card" key={`${project.agentId}:${project.id}`}>
                  <div>
                    <h3>{project.name}</h3>
                    <p>{project.domain || project.githubUrl || "Без публичного домена"}</p>
                  </div>
                  <div className="public-project-meta">
                    <a href={project.author.profileUrl}><UserCircle size={15} /> {project.author.nickname || project.author.email}</a>
                    <span>{project.chatCount} chats</span>
                    {project.url && <a href={project.url} target="_blank" rel="noreferrer"><ExternalLink size={15} /> Open result</a>}
                  </div>
                  <div className="public-chat-pills">
                    {project.latestChats.map((chat) => (
                      <button key={chat.id} type="button" onClick={() => void openPublicChat(chat)}>{chat.title}</button>
                    ))}
                    {!project.latestChats.length && <span className="small-empty">У проекта пока нет публичных чатов.</span>}
                  </div>
                </article>
              ))}
              {!searchProjects.length && <div className="empty">{emptyLabel}</div>}
            </div>
          ) : (
            <div className="public-result-list">
              {searchProfiles.map((profile) => (
                <article className="public-profile-result" key={profile.id}>
                  <div className="profile-avatar small">
                    {profile.avatarDataUrl ? <img alt="" src={profile.avatarDataUrl} /> : <UserCircle size={32} />}
                  </div>
                  <div>
                    <h3>{profile.nickname || profile.email}</h3>
                    <p>{profile.bio || profile.email}</p>
                    <div className="public-project-meta">
                      <span>{profile.stats.chats} chats</span>
                      <span>{profile.stats.projects} projects</span>
                      <span>{profile.publicProjects} public</span>
                    </div>
                  </div>
                  <a className="secondary compact" href={profile.profileUrl}><ExternalLink size={15} /> Open profile</a>
                </article>
              ))}
              {!searchProfiles.length && <div className="empty">{emptyLabel}</div>}
            </div>
          )}

          {searchOpenedChat && <PublicChatThread payload={searchOpenedChat} onPreview={setImagePreview} />}
        </section>
      </section>
    );
  }

  function renderAdmin() {
    const selectedAdminUser = adminUsers.find((user) => user.id === adminSelectedUserId) ?? adminUsers[0];
    const latestStats = adminStats[adminStats.length - 1] ?? { dau: 0, wau: 0, mau: 0, registrations: 0 };
    const selectedStats = selectedAdminUser?.stats ?? { chats: 0, jobs: 0, completedJobs: 0, failedJobs: 0, projects: 0, generationSeconds: 0 };

    return (
      <main className="admin-page">
        <header className="admin-header">
          <div>
            <span><ShieldCheck size={18} /> Admin</span>
            <h1>codex.rodion.pro</h1>
            <p>{currentUser?.email}</p>
          </div>
          <div className="admin-header-actions">
            <a className="secondary" href="/"><ArrowLeft size={16} /> В приложение</a>
            <button className="secondary" type="button" onClick={() => {
              void loadAdminUsers();
              void loadAdminStats();
            }}><RefreshCw size={16} /> Обновить</button>
            <button className="secondary" type="button" onClick={logout}><LogOut size={16} /> Выйти</button>
          </div>
        </header>

        <div className="admin-tabs">
          <button className={adminTab === "users" ? "active" : ""} type="button" onClick={() => setAdminTab("users")}><UserCircle size={16} /> Пользователи</button>
          <button className={adminTab === "stats" ? "active" : ""} type="button" onClick={() => setAdminTab("stats")}><Activity size={16} /> Статистика</button>
        </div>

        {adminNotice && <div className="notice">{adminNotice}</div>}

        {adminTab === "users" ? (
          <section className="admin-users-layout">
            <section className="admin-card admin-user-list">
              <div className="section-head">
                <h2><UserCircle size={18} /> Пользователи</h2>
                <strong>{adminUsers.length}</strong>
              </div>
              {adminUsers.map((user) => (
                <button
                  className={`admin-user-row ${selectedAdminUser?.id === user.id ? "active" : ""} ${user.blockedAt ? "blocked" : ""}`}
                  key={user.id}
                  type="button"
                  onClick={() => void selectAdminUser(user.id)}
                >
                  <span>
                    <strong>{user.nickname || user.email}</strong>
                    <small>{user.email}</small>
                  </span>
                  <em>{user.blockedAt ? "blocked" : user.role}</em>
                </button>
              ))}
              {!adminUsers.length && <div className="empty small-empty">Пользователей пока нет.</div>}
            </section>

            <section className="admin-card admin-user-detail">
              {selectedAdminUser ? (
                <>
                  <div className="admin-user-title">
                    <div>
                      <h2>{selectedAdminUser.nickname || selectedAdminUser.email}</h2>
                      <p>{selectedAdminUser.email}</p>
                    </div>
                    <span className={selectedAdminUser.blockedAt ? "admin-status blocked" : "admin-status"}>{selectedAdminUser.blockedAt ? "Blocked" : selectedAdminUser.role}</span>
                  </div>
                  <div className="admin-stat-grid">
                    <div><span>Чаты</span><strong>{selectedStats.chats}</strong></div>
                    <div><span>Запуски</span><strong>{selectedStats.jobs}</strong></div>
                    <div><span>Проекты</span><strong>{selectedStats.projects}</strong></div>
                    <div><span>Агенты</span><strong>{selectedAdminUser.agents}</strong></div>
                    <div><span>Создан</span><strong>{formatDateTime(selectedAdminUser.createdAt) || "n/a"}</strong></div>
                    <div><span>Активность</span><strong>{formatDateTime(selectedAdminUser.lastActiveAt) || "нет"}</strong></div>
                  </div>

                  <div className="admin-action-grid">
                    <form onSubmit={adminChangePassword}>
                      <input autoComplete="new-password" placeholder="Новый пароль" type="password" value={adminPassword} onChange={(event) => setAdminPassword(event.target.value)} />
                      <button disabled={busy || adminPassword.length < 8} type="submit"><KeyRound size={16} /> Поменять пароль</button>
                    </form>
                    <button className={selectedAdminUser.blockedAt ? "secondary" : "danger-button"} disabled={busy || selectedAdminUser.id === currentUser?.id} type="button" onClick={() => void adminToggleBlock(selectedAdminUser)}>
                      <ShieldCheck size={16} /> {selectedAdminUser.blockedAt ? "Разблокировать" : "Заблокировать"}
                    </button>
                    <button className="secondary" disabled={busy || Boolean(selectedAdminUser.blockedAt)} type="button" onClick={() => void adminImpersonate(selectedAdminUser)}>
                      <LogOut size={16} /> Авторизоваться за пользователя
                    </button>
                  </div>

                  <div className="admin-chats">
                    <div className="section-head">
                      <h2><MessageSquare size={18} /> Чаты пользователя</h2>
                      <button className="secondary compact" type="button" onClick={() => void loadAdminChats(selectedAdminUser.id)}><RefreshCw size={14} /> Refresh</button>
                    </div>
                    <div className="admin-chat-list">
                      {adminChats.map((chat) => (
                        <button className={adminOpenedChat?.chat.id === chat.id ? "active" : ""} key={chat.id} type="button" onClick={() => void adminOpenChat(chat)}>
                          <span>
                            <strong>{chat.title}</strong>
                            <small>{chat.agentName} · {chat.repoName || chat.repoId}</small>
                          </span>
                          <em>{chat.messageCount} msg · {formatDateTime(chat.updatedAt)}</em>
                        </button>
                      ))}
                      {!adminChats.length && <div className="empty small-empty">У пользователя пока нет чатов.</div>}
                    </div>
                    {adminOpenedChat && (
                      <section className="admin-chat-view">
                        <div className="section-head">
                          <h2>{adminOpenedChat.chat.title}</h2>
                          <span>{adminOpenedChat.jobs.length} runs</span>
                        </div>
                        {adminOpenedChat.messages.map((message) => (
                          <article className={`admin-chat-message ${message.role}`} key={message.id}>
                            <div className="message-meta">
                              <span>{message.role === "user" ? (selectedAdminUser.nickname || selectedAdminUser.email) : message.role === "system" ? "System" : "Codex"}</span>
                              <small>{formatDateTime(message.createdAt)}</small>
                            </div>
                            {message.role === "system"
                              ? <div className="system-message-body">{normalizeDisplayText(message.content).trim()}</div>
                              : renderRichText(message.content, "rich-text message-body")}
                            {renderMessageAttachments(message.attachments, setImagePreview)}
                          </article>
                        ))}
                      </section>
                    )}
                  </div>
                </>
              ) : (
                <div className="empty">Выбери пользователя.</div>
              )}
            </section>
          </section>
        ) : (
          <section className="admin-card admin-stats-panel">
            <div className="section-head">
              <h2><Activity size={18} /> Активность</h2>
              <button className="secondary compact" type="button" onClick={() => void loadAdminStats()}><RefreshCw size={14} /> Refresh</button>
            </div>
            <div className="admin-stat-grid compact">
              <div><span>DAU</span><strong>{latestStats.dau}</strong></div>
              <div><span>WAU</span><strong>{latestStats.wau}</strong></div>
              <div><span>MAU</span><strong>{latestStats.mau}</strong></div>
              <div><span>Регистрации сегодня</span><strong>{latestStats.registrations}</strong></div>
            </div>
            <div className="admin-chart-controls">
              {(Object.keys(ADMIN_METRIC_META) as AdminStatsMetric[]).map((metric) => (
                <label key={metric} style={{ "--metric-color": ADMIN_METRIC_META[metric].color } as React.CSSProperties}>
                  <input checked={adminStatsVisible[metric]} type="checkbox" onChange={() => toggleAdminMetric(metric)} />
                  <span>{ADMIN_METRIC_META[metric].label}</span>
                </label>
              ))}
            </div>
            <AdminStatsChart points={adminStats} visible={adminStatsVisible} />
          </section>
        )}

        {imagePreview && (
          <div className="image-lightbox" role="dialog" aria-modal="true" aria-label={imagePreview.name} onClick={() => setImagePreview(null)}>
            <figure onClick={(event) => event.stopPropagation()}>
              <button aria-label="Close image preview" type="button" onClick={() => setImagePreview(null)}>
                <X size={20} />
              </button>
              <img alt={imagePreview.name} src={imagePreview.src} />
              <figcaption>
                <strong>{imagePreview.name}</strong>
                <span>{imagePreview.mimeType} · {formatBytes(imagePreview.size)}</span>
              </figcaption>
            </figure>
          </div>
        )}
      </main>
    );
  }

  function renderProfile() {
    const stats = profileStatsData ?? { chats: 0, jobs: 0, completedJobs: 0, failedJobs: 0, projects: 0, generationSeconds: 0 };
    const displayName = currentUser?.nickname || currentUser?.email || "Profile";
    const ownProfileUrl = profileUrl(currentUser);
    return (
      <section className="settings-work profile-work">
        <section className="profile-hero">
          <div className="profile-avatar">
            {profileAvatarDataUrl || currentUser?.avatarDataUrl ? <img alt="" src={profileAvatarDataUrl || currentUser?.avatarDataUrl || ""} /> : <UserCircle size={54} />}
          </div>
          <div>
            <h2>{displayName}</h2>
            <p>{currentUser?.email}</p>
            <small><CalendarDays size={14} /> Registered {formatDateTime(currentUser?.createdAt) || "unknown"}</small>
          </div>
        </section>

        <section className="profile-grid">
          <div className="stat-card"><MessageSquare size={18} /><span>Chats</span><strong>{stats.chats}</strong></div>
          <div className="stat-card"><Activity size={18} /><span>Runs</span><strong>{stats.jobs}</strong></div>
          <div className="stat-card"><CheckCircle2 size={18} /><span>Completed</span><strong>{stats.completedJobs}</strong></div>
          <div className="stat-card"><FolderGit2 size={18} /><span>Projects</span><strong>{stats.projects}</strong></div>
          <div className="stat-card wide"><Clock3 size={18} /><span>Generation time</span><strong>{formatDuration(stats.generationSeconds)}</strong></div>
        </section>

        <section className="settings-card profile-card">
          <h2><Link2 size={18} /> Public profile link</h2>
          <div className="copy-row">
            <input readOnly value={ownProfileUrl} />
            <button
              className="secondary"
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(ownProfileUrl);
                setProfileNotice("Profile link copied.");
              }}
            >
              <Link2 size={16} /> Copy
            </button>
          </div>
        </section>

        <form className="settings-card profile-card" onSubmit={saveProfile}>
          <h2><UserCircle size={18} /> Profile parameters</h2>
          <label>
            Unique nickname
            <input placeholder="rodion" value={profileNickname} onChange={(event) => setProfileNickname(event.target.value)} />
          </label>
          <label>
            Description
            <textarea placeholder="Коротко о себе и своём сетапе..." value={profileBio} onChange={(event) => setProfileBio(event.target.value)} />
          </label>
          <label className="avatar-upload">
            <Camera size={16} /> Update avatar
            <input accept="image/png,image/jpeg,image/gif,image/webp,image/avif,image/bmp" type="file" onChange={(event) => updateProfileAvatar(event.currentTarget.files?.[0])} />
          </label>
          <button disabled={busy} type="submit"><Save size={16} /> Save profile</button>
        </form>

        <form className="settings-card profile-card" onSubmit={changePassword}>
          <h2><KeyRound size={18} /> Password</h2>
          <input autoComplete="current-password" placeholder="current password" type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} />
          <input autoComplete="new-password" placeholder="new password" type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
          <button disabled={busy || !currentPassword || newPassword.length < 8} type="submit"><KeyRound size={16} /> Change password</button>
        </form>

        <section className="settings-card profile-card">
          <h2><Link2 size={18} /> OAuth connections</h2>
          <div className="oauth-list">
            {oauthProviders.map((provider) => (
              <div className="oauth-row" key={provider.provider}>
                <span>{oauthIcon(provider.provider)} {oauthLabel(provider.provider)}</span>
                <small>{provider.connected ? `Connected${provider.displayName ? ` as ${provider.displayName}` : ""}` : provider.configured ? "Ready to connect" : "Server config needed"}</small>
                <button disabled={busy} type="button" onClick={() => connectOAuth(provider.provider)}>
                  {provider.connected ? "Reconnect" : "Connect"}
                </button>
              </div>
            ))}
          </div>
        </section>

        {profileNotice && <div className="notice">{profileNotice}</div>}
      </section>
    );
  }

  function renderDeployModeSelect() {
    return (
      <label>
        Deploy mode
        <select
          value={projectDeployEnabled ? projectDeployMode : "none"}
          onChange={(event) => {
            const value = event.target.value as "none" | "ssh" | "local";
            if (value === "none") {
              setProjectDeployEnabled(false);
              return;
            }
            setProjectDeployEnabled(true);
            setProjectDeployMode(value);
            if (value === "ssh" && !projectDeploySshTarget.trim()) setProjectDeploySshTarget(DEFAULT_DEPLOY_SSH_TARGET);
          }}
        >
          <option value="none">No deploy yet</option>
          <option value="ssh">SSH upload from this agent</option>
          <option value="local">Local server copy</option>
        </select>
      </label>
    );
  }

  function renderDeployFields() {
    return (
      <>
        <label>
          Server project folder
          <input placeholder="/var/www/project.domain" value={projectServerPath} onChange={(event) => handleProjectServerPathChange(event.target.value)} />
        </label>
        <label>
          Domain or subdomain
          <input
            placeholder={`playground or playground.${PROJECT_DOMAIN_ROOT}`}
            value={projectDomain}
            onBlur={() => setProjectDomain(normalizeProjectDomain(projectDomain))}
            onChange={(event) => handleProjectDomainChange(event.target.value)}
          />
        </label>
        {projectUrl(projectDomain) && (
          <div className="project-preview">
            <span>Project URL</span>
            <a href={projectUrl(projectDomain)} target="_blank" rel="noreferrer">{projectUrl(projectDomain)}</a>
          </div>
        )}
        {!projectDeployEnabled && (
          <div className="wizard-muted">
            Deploy can be connected later from project settings.
          </div>
        )}
        {projectDeployEnabled && (
          <>
        <label>
          Deploy SSH target
          <input disabled={projectDeployMode === "local"} placeholder="myserver" value={projectDeployMode === "local" ? "" : projectDeploySshTarget} onChange={(event) => setProjectDeploySshTarget(event.target.value)} />
        </label>
        <div className="wizard-two-col">
          <label>
            Deploy source folder
            <input placeholder="dist" value={projectDeploySourceDir} onChange={(event) => setProjectDeploySourceDir(event.target.value)} />
          </label>
          <label>
            Deploy target subfolder
            <input placeholder="dist, optional" value={projectDeployRemoteSubdir} onChange={(event) => setProjectDeployRemoteSubdir(event.target.value)} />
          </label>
        </div>
        <label>
          Build command
          <input placeholder={defaultBuildCommandForAgent(projectPanel === "new" ? projectFormAgent : selectedAgent)} value={projectDeployBuildCommand} onChange={(event) => setProjectDeployBuildCommand(event.target.value)} />
        </label>
        <label className="checkbox-row">
          <input checked={projectDeployCleanRemote} type="checkbox" onChange={(event) => setProjectDeployCleanRemote(event.target.checked)} />
          Clean server folder before upload
        </label>
          </>
        )}
      </>
    );
  }

  function renderDataFields() {
    return (
      <>
        <div className="storage-choice" role="group" aria-label="Data storage location">
          <button className={projectDataLocation === "local" ? "active" : ""} type="button" onClick={() => handleProjectDataLocationChange("local")}>
            <FolderGit2 size={16} />
            <span>
              <strong>Local</strong>
              <small>Project agent folder</small>
            </span>
          </button>
          <button className={projectDataLocation === "server" ? "active" : ""} type="button" onClick={() => handleProjectDataLocationChange("server")}>
            <Server size={16} />
            <span>
              <strong>Server</strong>
              <small>Deploy machine folder</small>
            </span>
          </button>
        </div>
        <label>
          Data folder
          <input value={projectDataPath} onChange={(event) => setProjectDataPath(event.target.value)} />
        </label>
      </>
    );
  }

  function renderProjectWizardStep() {
    if (projectWizardStep === "project") {
      return (
        <div className="wizard-step-panel">
          <label>
            Name
            <input value={projectName} onChange={(event) => handleProjectNameChange(event.target.value)} />
          </label>
          <label>
            Agent
            <select value={projectAgentId || projectFormAgent?.id || ""} onChange={(event) => handleProjectAgentChange(event.target.value)}>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name} · {agent.status}{isLinuxAgent(agent) ? " · Linux" : ""}
                </option>
              ))}
            </select>
          </label>
          <label>
            Folder on selected agent
            <input value={projectPath} onChange={(event) => handleProjectPathChange(event.target.value)} />
          </label>
          <label>
            Project visibility
            <select value={projectVisibility} onChange={(event) => setProjectVisibility(event.target.value as ProjectVisibility)}>
              <option value="private">Private: виден только владельцу и админам</option>
              <option value="public">Public: проект и его чаты видны в Search</option>
            </select>
          </label>
        </div>
      );
    }
    if (projectWizardStep === "git") {
      return (
        <div className="wizard-step-panel">
          <label>
            GitHub repository
            <input placeholder="https://github.com/WizardJIOCb/project.git" value={projectGithubUrl} onChange={(event) => setProjectGithubUrl(event.target.value)} />
          </label>
          <div className="wizard-summary-grid">
            <div><span>Local repo</span><strong>{projectPath || "not set"}</strong></div>
            <div><span>Default commit</span><strong>{`Update ${projectName.trim() || "project"}`}</strong></div>
          </div>
        </div>
      );
    }
    if (projectWizardStep === "deploy") {
      return (
        <div className="wizard-step-panel">
          {renderDeployModeSelect()}
          {renderDeployFields()}
        </div>
      );
    }
    if (projectWizardStep === "data") {
      return (
        <div className="wizard-step-panel">
          {renderDataFields()}
          <div className="wizard-summary-grid">
            <div><span>Location</span><strong>{projectDataLocation}</strong></div>
            <div><span>Folder</span><strong>{projectDataPath || "not set"}</strong></div>
          </div>
        </div>
      );
    }
    return (
      <div className="wizard-step-panel ready">
        <div className="wizard-summary-grid">
          <div><span>Project</span><strong>{projectName || "Untitled"}</strong></div>
          <div><span>Agent</span><strong>{projectFormAgent?.name || "No agent"}</strong></div>
          <div><span>Folder</span><strong>{projectPath || "not set"}</strong></div>
          <div><span>GitHub</span><strong>{projectGithubUrl || "not connected"}</strong></div>
          <div><span>Deploy</span><strong>{projectDraftDeployConfig ? `${projectDraftDeployConfig.mode} · ${projectServerPath || "server path"}` : "not configured"}</strong></div>
          <div><span>Data</span><strong>{projectDraftDataConfig ? `${projectDraftDataConfig.location} · ${projectDraftDataConfig.path}` : "not configured"}</strong></div>
          <div><span>Domain</span><strong>{normalizeProjectDomain(projectDomain) || "not set"}</strong></div>
          <div><span>Visibility</span><strong>{projectVisibility}</strong></div>
        </div>
        <label>
          Start prompt
          <textarea
            placeholder="Опишите первый шаг для Codex после сохранения проекта"
            value={projectStartPrompt}
            onChange={(event) => setProjectStartPrompt(event.target.value)}
          />
        </label>
        <div className="segments">
          {SANDBOXES.map((item) => (
            <button className={sandbox === item ? "active" : ""} key={item} type="button" onClick={() => setSandbox(item)}>{SANDBOX_LABELS[item]}</button>
          ))}
        </div>
      </div>
    );
  }

  function renderProjectWizard() {
    const canGoBack = projectWizardStepIndex > 0;
    const canGoNext = projectWizardStepIndex >= 0 && projectWizardStepIndex < PROJECT_WIZARD_STEPS.length - 1;
    const nextStep = () => {
      if (!projectWizardCanContinue) return;
      const next = PROJECT_WIZARD_STEPS[projectWizardStepIndex + 1];
      if (next) setProjectWizardStep(next.id);
    };
    const previousStep = () => {
      const previous = PROJECT_WIZARD_STEPS[projectWizardStepIndex - 1];
      if (previous) setProjectWizardStep(previous.id);
    };

    return (
      <form className="project-form project-wizard" onSubmit={saveProject}>
        <div className="section-head">
          <h2><FolderGit2 size={18} /> New project</h2>
          <div className="section-actions">
            <button className="secondary" type="button" onClick={() => applyProjectDefaultsToForm({ includePath: true })}>
              <Wrench size={15} /> Defaults
            </button>
            <button className="secondary" type="button" onClick={() => setProjectPanel(null)}>Close</button>
          </div>
        </div>
        <div className="wizard-steps">
          {PROJECT_WIZARD_STEPS.map((step, index) => (
            <button
              className={step.id === projectWizardStep ? "active" : index < projectWizardStepIndex ? "done" : ""}
              key={step.id}
              type="button"
              onClick={() => setProjectWizardStep(step.id)}
            >
              <span>{index + 1}</span>
              {step.label}
            </button>
          ))}
        </div>
        {renderProjectWizardStep()}
        {projectNotice && <div className="notice danger">{projectNotice}</div>}
        {!projectSaveAgentOnline && (
          <div className="notice warning">Выбранный агент offline. Новый проект можно сохранить после подключения агента.</div>
        )}
        <div className="project-form-actions wizard-actions">
          {canGoBack ? (
            <button className="secondary" type="button" onClick={previousStep}><ArrowLeft size={16} /> Back</button>
          ) : (
            <button className="secondary" type="button" onClick={() => setProjectPanel(null)}>Cancel</button>
          )}
          {canGoNext ? (
            <button disabled={!projectWizardCanContinue} type="button" onClick={nextStep}>Next <ArrowRight size={16} /></button>
          ) : (
            <>
              <button disabled={!canSaveProject} type="submit" value="save"><Save size={16} /> Create project</button>
              <button className="secondary" disabled={!canSaveAndRunProject} type="submit" value="run-prompt"><Play size={16} /> Create & run prompt</button>
            </>
          )}
        </div>
      </form>
    );
  }

  function renderProjectSettingsForm() {
    return (
      <form className="project-form" onSubmit={saveProject}>
        <div className="section-head">
          <h2>Project settings</h2>
          <div className="section-actions">
            <button className="secondary" type="button" onClick={() => applyProjectDefaultsToForm({ includePath: false })}>
              <Wrench size={15} /> Defaults
            </button>
            <button className="secondary" type="button" onClick={() => setProjectPanel(null)}>Close</button>
          </div>
        </div>
        <label>
          Name
          <input value={projectName} onChange={(event) => handleProjectNameChange(event.target.value)} />
        </label>
        <label>
          Folder on selected agent
          <input value={projectPath} onChange={(event) => handleProjectPathChange(event.target.value)} />
        </label>
        <label>
          GitHub repository
          <input placeholder="https://github.com/WizardJIOCb/project.git" value={projectGithubUrl} onChange={(event) => setProjectGithubUrl(event.target.value)} />
        </label>
        {renderDeployModeSelect()}
        {renderDeployFields()}
        <label>
          Project visibility
          <select value={projectVisibility} onChange={(event) => setProjectVisibility(event.target.value as ProjectVisibility)}>
            <option value="private">Private: виден только владельцу и админам</option>
            <option value="public">Public: проект и его чаты видны в Search</option>
          </select>
        </label>
        {renderDataFields()}
        <label>
          Start prompt
          <textarea
            placeholder="Опишите первый шаг для Codex после сохранения проекта"
            value={projectStartPrompt}
            onChange={(event) => setProjectStartPrompt(event.target.value)}
          />
        </label>
        <div className="segments">
          {SANDBOXES.map((item) => (
            <button className={sandbox === item ? "active" : ""} key={item} type="button" onClick={() => setSandbox(item)}>{SANDBOX_LABELS[item]}</button>
          ))}
        </div>
        {projectNotice && <div className="notice danger">{projectNotice}</div>}
        {projectPanel === "settings" && selectedRepoAgent?.status !== "online" && (
          <div className="notice">
            {projectSettingsNeedsAgent
              ? "Агент проекта offline: сейчас можно сохранить только Public/Private для Search. Локальные поля сохранятся после подключения агента."
              : "Агент проекта offline: Public/Private для Search можно сохранить прямо сейчас."}
          </div>
        )}
        <div className="project-form-actions">
          <button disabled={!canSaveProject} type="submit" value="save"><Save size={16} /> Save project</button>
          <button className="secondary" disabled={!canSaveAndRunProject} type="submit" value="run-prompt"><Play size={16} /> Save & run prompt</button>
        </div>
        <button className="danger-button" disabled={busy || !selectedRepo} type="button" onClick={deleteProject}>Remove project from service</button>
      </form>
    );
  }

  function renderSettings() {
    return (
      <section className="settings-work">
        <section className="project-form wide">
          <div className="section-head">
            <h2><Settings size={18} /> Profile setup</h2>
          </div>
          <div className="notice">
            Пользователь запускает Windows-agent у себя на ПК, логинится в Codex локально через <code>codex login</code>, а сайт только отправляет задачи его агенту.
            Для второго ПК или ноутбука создай отдельного агента: один <code>agentId</code> рассчитан на одно активное подключение.
          </div>
          <div className="settings-card appearance-card">
            <div className="section-head">
              <h2><Palette size={18} /> Appearance</h2>
              <strong>{UI_THEME_OPTIONS.find((option) => option.value === uiTheme)?.label}</strong>
            </div>
            <div className="theme-grid">
              {UI_THEME_OPTIONS.map((option) => (
                <button
                  className={uiTheme === option.value ? "theme-option active" : "theme-option"}
                  key={option.value}
                  type="button"
                  onClick={() => setUiTheme(option.value)}
                >
                  <span className="theme-swatches" aria-hidden="true">
                    {option.swatches.map((color) => <i key={color} style={{ background: color }} />)}
                  </span>
                  <span>
                    <strong>{option.label}</strong>
                    <small>{option.note}</small>
                  </span>
                  {uiTheme === option.value && <Check size={16} />}
                </button>
              ))}
            </div>
          </div>
          <form className="settings-card" onSubmit={createAgent}>
            <h2><Bot size={18} /> Create personal agent</h2>
            <label>
              Agent name
              <input value={newAgentName} onChange={(event) => setNewAgentName(event.target.value)} />
            </label>
            <label>
              Agent id, optional
              <input placeholder="my-windows-agent" value={newAgentId} onChange={(event) => setNewAgentId(event.target.value)} />
            </label>
            {currentUser?.role === "admin" && (
              <label>
                Owner
                <select value={newAgentUserId} onChange={(event) => setNewAgentUserId(event.target.value)}>
                  <option value="">Me</option>
                  {users.map((user) => <option key={user.id} value={user.id}>{user.email}</option>)}
                </select>
              </label>
            )}
            <button disabled={busy || !newAgentName.trim()} type="submit"><Plus size={16} /> Create agent & setup</button>
          </form>
          {agentSetup && (
            <div className="settings-card">
              <h2>{agentSetup.platform === "linux" ? "Linux setup" : "Windows setup"}</h2>
              <p>
                {agentSetup.platform === "linux"
                  ? <>На Ubuntu-сервере: установи Node.js LTS и Codex CLI, выполни <code>codex login</code>, затем запусти <code>setup-agent-linux.sh</code>.</>
                  : <>На ПК пользователя: установи Node.js LTS и Codex CLI, выполни <code>codex login</code>, затем запусти скачанный <code>setup-agent.bat</code>. Он скачает только runtime-пакет агента.</>}
              </p>
              <button className="secondary" type="button" onClick={() => (
                downloadTextFile(
                  agentSetup.setupFileName || (agentSetup.platform === "linux" ? "setup-agent-linux.sh" : "setup-agent.bat"),
                  agentSetup.platform === "linux" ? agentSetup.setupShell || agentSetup.setupPowerShell : agentSetup.setupBatch || agentSetup.setupPowerShell,
                  agentSetup.platform === "linux" ? "text/x-shellscript;charset=utf-8" : "application/x-bat;charset=utf-8"
                )
              )}>
                <Download size={16} /> Download {agentSetup.setupFileName || (agentSetup.platform === "linux" ? "setup-agent-linux.sh" : "setup-agent.bat")}
              </button>
              <textarea className="code-textarea" readOnly value={agentSetup.platform === "linux" ? agentSetup.setupShell || "" : agentSetup.setupPowerShell} />
              <label>
                Agent config
                <textarea className="code-textarea small" readOnly value={agentSetup.configJson} />
              </label>
            </div>
          )}
          {currentUser?.role === "admin" && (
            <form className="settings-card" onSubmit={createUser}>
              <h2>Create user</h2>
              <input autoComplete="off" placeholder="email" value={newUserEmail} onChange={(event) => setNewUserEmail(event.target.value)} />
              <input autoComplete="new-password" placeholder="temporary password" type="password" value={newUserPassword} onChange={(event) => setNewUserPassword(event.target.value)} />
              <select value={newUserRole} onChange={(event) => setNewUserRole(event.target.value as "admin" | "user")}>
                <option value="user">user</option>
                <option value="admin">admin</option>
              </select>
              <button disabled={busy || !newUserEmail.trim() || !newUserPassword} type="submit"><Plus size={16} /> Create user</button>
            </form>
          )}
          {settingsNotice && <div className="notice">{settingsNotice}</div>}
          {currentUser?.role === "admin" && (
            <div className="settings-card">
              <h2>Users</h2>
              {users.map((user) => (
                <div className="settings-row" key={user.id}>
                  <span>{user.email}</span>
                  <strong>{user.role}</strong>
                </div>
              ))}
              {!users.length && <span className="small-empty">No users loaded.</span>}
            </div>
          )}
          <div className="settings-card">
            <div>
              <h2>Agents</h2>
              <p>Для другого компьютера нужен отдельный агент, иначе устройства будут перехватывать один и тот же статус.</p>
            </div>
            {agents.map((agent) => (
              <div className="settings-row agent-settings-row" key={agent.id}>
                <div className="agent-settings-main">
                  <span>{agent.name}</span>
                  <small>{agent.id}</small>
                </div>
                <div className="agent-settings-actions">
                  <strong>{agent.status}</strong>
                  <button
                    className="secondary compact"
                    disabled={busy || agent.status === "online"}
                    type="button"
                    title={agent.status === "online" ? "Stop this agent first to rotate its setup token. For another PC, use Add another computer." : "Download setup-agent.bat"}
                    onClick={() => void downloadAgentSetup(agent)}
                  >
                    <Download size={15} /> Setup
                  </button>
                </div>
              </div>
            ))}
            {!agents.length && <span className="small-empty">No agents yet.</span>}
            <button className="agent-add-button" disabled={busy} type="button" onClick={() => void createAnotherComputerSetup()}>
              <Plus size={16} /> Add another computer
            </button>
          </div>
        </section>
      </section>
    );
  }

  function renderSync() {
    const reposByAgent = new Map<string, Repo[]>();
    repos.forEach((repo) => {
      const current = reposByAgent.get(repo.agentId) ?? [];
      current.push(repo);
      reposByAgent.set(repo.agentId, current);
    });
    const repoKeyValue = syncRepo ? `${syncRepo.agentId}:${syncRepo.id}` : "";
    const syncRepoAgent = syncRepo ? agents.find((agent) => agent.id === syncRepo.agentId) : undefined;
    const controlAgent = syncRepoAgent ?? selectedAgent;
    const controlIsLinux = isLinuxAgent(controlAgent);
    const linuxAgent = agents.find((agent) => agent.id === "agent-linux") ?? agents.find((agent) => isLinuxAgent(agent));
    const agentSeenAt = formatDateTime(controlAgent?.last_seen_at);
    const agentReady = Boolean(controlAgent && controlAgent.status === "online");
    const repoReady = Boolean(syncRepo);
    const codexReady = Boolean(controlAgent?.codex_version);
    const bridgeReady = vscodeNotice && !/failed|agent_offline|agent_replaced|agent_disconnected|timeout|unavailable|closed|переподключился|отключился|ошибка|не удалось/i.test(vscodeNotice);
    const syncNoticeOk = /прошла|скачал|online/i.test(syncNotice);
    const setupButtonLabel = controlAgent
      ? controlAgent.status === "online" ? "Агент уже online" : "Скачать установщик агента"
      : "Создать агента и скачать установщик";
    const linuxSetupButtonLabel = linuxAgent
      ? linuxAgent.status === "online" ? "Linux-агент online" : "Скачать setup Linux-агента"
      : "Добавить server agent-linux";
    const statusRows = [
      {
        label: "Web service",
        ok: true,
        value: "codex.rodion.pro отвечает"
      },
      {
        label: controlIsLinux ? "Linux server agent" : "Windows agent",
        ok: agentReady,
        value: controlAgent ? `${controlAgent.name} · ${controlAgent.status}${agentSeenAt ? ` · ${agentSeenAt}` : ""}` : "Агент не найден"
      },
      {
        label: "Codex CLI",
        ok: codexReady,
        value: controlAgent?.codex_version || "Версия ещё не получена от агента"
      },
      {
        label: "Git",
        ok: Boolean(controlAgent?.git_version),
        value: controlAgent?.git_version || "Версия ещё не получена от агента"
      },
      {
        label: "Project allowlist",
        ok: repoReady,
        value: syncRepo ? `${syncRepo.name} · ${syncRepo.pathMasked}` : "Нет доступных проектов"
      },
      {
        label: controlIsLinux ? "Server bridge" : "VS Code bridge",
        ok: controlIsLinux ? agentReady : Boolean(bridgeReady),
        value: controlIsLinux ? "Linux agent works through direct WebSocket; VS Code bridge is not required." : vscodeNotice || "Нажми Ping VS Code"
      }
    ];

    return (
      <section className="settings-work sync-work">
        <section className="project-form wide">
          <div className="section-head">
            <h2><PlugZap size={18} /> Sync</h2>
            <button className="secondary" type="button" onClick={refresh}><RefreshCw size={16} /> Refresh</button>
          </div>

          <div className="settings-card sync-setup-card">
            <div>
              <h2><Download size={18} /> Windows agent setup</h2>
              <p>
                Скачай персональный <code>setup-agent.bat</code> и запусти его на домашнем Windows ПК.
                Он скачает компактный <code>agent-package.zip</code> в папку <code>%USERPROFILE%\codex-agent</code>, запишет конфиг и токен, затем запустит агента.
                Полный репозиторий не скачивается.
              </p>
            </div>
            <button className="sync-setup-button" disabled={busy || Boolean(controlAgent && controlAgent.status === "online")} type="button" onClick={() => void downloadAgentSetup(controlAgent)}>
              <Download size={16} /> {setupButtonLabel}
            </button>
          </div>

          <div className="settings-card sync-setup-card server-setup-card">
            <div>
              <h2><Server size={18} /> Linux server agent</h2>
              <p>
                Добавляет постоянное подключение <code>agent-linux</code> на Ubuntu-сервере. Агент работает как systemd service, хранит проекты на сервере и может деплоить локально в <code>/var/www</code> без домашнего Windows ПК.
              </p>
            </div>
            <button className="sync-setup-button" disabled={busy || Boolean(linuxAgent && linuxAgent.status === "online")} type="button" onClick={() => void downloadLinuxAgentSetup()}>
              <Server size={16} /> {linuxSetupButtonLabel}
            </button>
          </div>

          <div className="settings-card sync-guide-card">
            <h2><ShieldCheck size={18} /> Что означает online</h2>
            <p>
              Online значит, что сервер видит WebSocket от агента. Windows-агент может работать как node-процесс на домашнем ПК, Linux-агент - как systemd service на сервере.
              Останавливать нужно там, где он установлен: <code>stop-agent.bat</code> на Windows или <code>systemctl stop codex-agent-linux</code> на сервере.
            </p>
            <div className="sync-steps">
              <article><strong>1</strong><span>Скачать setup для нужного агента</span></article>
              <article><strong>2</strong><span>Установить Node.js LTS, Codex CLI и выполнить <code>codex login</code></span></article>
              <article><strong>3</strong><span>Запустить setup; он сохранит token и allowlist проектов</span></article>
              <article><strong>4</strong><span>Для каждого ПК или сервера использовать отдельный agentId</span></article>
            </div>
          </div>

          <div className="settings-card">
            <div className="section-head">
              <h2><Bot size={18} /> Доступные подключения</h2>
              <div className="section-actions">
                <button className="secondary" disabled={busy || Boolean(linuxAgent && linuxAgent.status === "online")} type="button" onClick={() => void downloadLinuxAgentSetup()}>
                  <Server size={16} /> Новый сервер
                </button>
                <button className="secondary" disabled={busy} type="button" onClick={() => void createAnotherComputerSetup()}>
                  <Plus size={16} /> Новый компьютер
                </button>
              </div>
            </div>
            <div className="agent-connection-list">
              {agents.map((agent) => {
                const agentRepos = reposByAgent.get(agent.id) ?? [];
                const firstRepo = agentRepos[0];
                const agentOnline = agent.status === "online";
                const lastSeen = formatDateTime(agent.last_seen_at);
                const canDeleteAgent = !agentOnline && agentRepos.length === 0;
                return (
                  <article className={`agent-connection ${agentOnline ? "online" : "offline"}`} key={agent.id}>
                    <div className="agent-connection-title">
                      <span className={`status ${agentOnline ? "ok" : "bad"}`}>{agentOnline ? <Wifi size={14} /> : <WifiOff size={14} />} {agentOnline ? "Online" : "Offline"}</span>
                      <strong>{agent.name}</strong>
                    </div>
                    <div className="agent-connection-meta">
                      <span>ID: <code>{agent.id}</code></span>
                      <span>Host: {agent.hostname || "ещё не подключался"}</span>
                      {agent.os && <span>OS: {agent.os}</span>}
                      <span>Projects: {agentRepos.length}</span>
                      {lastSeen && <span>Last seen: {lastSeen}</span>}
                    </div>
                    <div className="agent-connection-actions">
                      <button className="secondary compact" disabled={!firstRepo} type="button" onClick={() => {
                        if (firstRepo) setSyncRepoKey(`${firstRepo.agentId}:${firstRepo.id}`);
                      }}>
                        <Check size={14} /> Выбрать
                      </button>
                      <button className="secondary compact" disabled={busy || agentOnline} type="button" onClick={() => void downloadAgentSetup(agent)}>
                        <Download size={14} /> Setup
                      </button>
                      <button
                        className="secondary compact"
                        title="Показать, как остановить агента на его компьютере"
                        type="button"
                        onClick={() => showAgentStopGuide(agent)}
                      >
                        <Square size={14} /> Как остановить
                      </button>
                      <button
                        className="secondary compact danger-compact"
                        disabled={busy || !canDeleteAgent}
                        title={canDeleteAgent ? "Удалить пустое offline-подключение" : "Удалять можно только offline-агента без проектов"}
                        type="button"
                        onClick={() => void deleteAgent(agent)}
                      >
                        <Trash2 size={14} /> Удалить
                      </button>
                    </div>
                    {agentOnline && !agentRepos.length && (
                      <p>Подключение живое, но проектов у этого агента нет. Для существующих проектов запусти setup того агента, к которому они привязаны.</p>
                    )}
                  </article>
                );
              })}
              {!agents.length && <span className="small-empty">Агенты ещё не созданы.</span>}
            </div>
          </div>

          <div className="sync-grid">
            {statusRows.map((row) => (
              <article className={`sync-status ${row.ok ? "ok" : "bad"}`} key={row.label}>
                {row.ok ? <CheckCircle2 size={18} /> : <ShieldCheck size={18} />}
                <span>{row.label}</span>
                <strong>{row.value}</strong>
              </article>
            ))}
          </div>

          <div className="settings-card">
            <h2><FolderGit2 size={18} /> Project sync target</h2>
            <p>
              Локальные чаты синхронизируются через агента выбранного проекта. Если проект привязан к offline-агенту, Sync будет недоступен, даже если другой агент online.
            </p>
            <label>
              Project
              <select value={repoKeyValue} onChange={(event) => setSyncRepoKey(event.target.value)}>
                {repos.map((repo) => (
                  <option key={`${repo.agentId}:${repo.id}`} value={`${repo.agentId}:${repo.id}`}>
                    {repo.name} · {repo.currentBranch || "no branch"}
                  </option>
                ))}
              </select>
            </label>
            <div className="sync-actions">
              <button disabled={!agentReady || controlIsLinux || vscodeBusy} type="button" onClick={() => runVscodeCommand("ping", controlAgent?.id)}>
                <Terminal size={16} /> Ping VS Code
              </button>
              <button disabled={!agentReady || controlIsLinux || vscodeBusy} type="button" onClick={() => runVscodeCommand("newCodexPanel", controlAgent?.id)}>
                <Bot size={16} /> Open Codex panel
              </button>
              <button disabled={!agentReady || controlIsLinux || vscodeBusy || !activeCodexThreadId} type="button" onClick={() => runVscodeCommand("reopenThread", controlAgent?.id, { threadId: activeCodexThreadId })}>
                <MessageSquare size={16} /> Reopen active chat
              </button>
              <button disabled={!syncRepo || !agentReady || localChatSyncing} type="button" onClick={() => syncRepo && syncLocalChats(syncRepo)}>
                <RefreshCw className={localChatSyncing ? "spin" : ""} size={16} /> Sync local chats
              </button>
            </div>
            {syncNotice && <div className={syncNoticeOk ? "notice" : "notice danger"}>{syncNotice}</div>}
            {vscodeNotice && <div className={bridgeReady ? "notice" : "notice danger"}>{vscodeNotice}</div>}
          </div>

          <div className="settings-card">
            <h2><Play size={18} /> Запуск и права</h2>
            <div className="settings-row">
              <span>Запустить установленный runtime-агент</span>
              <strong>%USERPROFILE%\codex-agent\start-agent.bat</strong>
            </div>
            <div className="settings-row">
              <span>Остановить runtime-агент</span>
              <strong>%USERPROFILE%\codex-agent\stop-agent.bat</strong>
            </div>
            <div className="settings-row">
              <span>Запустить native-менеджер из репозитория</span>
              <strong>start-native-agent.bat</strong>
            </div>
            <div className="settings-row">
              <span>Права агента</span>
              <strong>только исходящий WebSocket, только проекты из allowlist</strong>
            </div>
          </div>
        </section>
      </section>
    );
  }

  async function logout() {
    if (csrf) await api("/api/logout", { method: "POST", headers: { "x-csrf-token": csrf }, body: "{}" });
    setCsrf(undefined);
    setCurrentUser(null);
  }

  function expandChangeCard(actionKey: string, message: ChatMessage, job?: Job) {
    const willExpand = expandedActions[actionKey] === false;
    setExpandedActions((current) => ({ ...current, [actionKey]: current[actionKey] === false }));
    if (!willExpand) return;
    if (job?.id && (job.gitDiffOmitted || (job.gitDiffStat && !job.gitDiff))) {
      loadJobDetails(job.id).catch(() => undefined);
    }
    if (message.metadata?.metadataOmitted || message.metadata?.gitDiffOmitted) {
      loadMessageDetails(message.id).catch(() => undefined);
    }
  }

  function expandCodexActions(actionKey: string, message: ChatMessage) {
    const willExpand = !expandedActions[actionKey];
    setExpandedActions((current) => ({ ...current, [actionKey]: !current[actionKey] }));
    if (willExpand && message.metadata?.metadataOmitted) {
      loadMessageDetails(message.id).catch(() => undefined);
    }
  }

  function toggleFileDiff(diffKey: string, message: ChatMessage, job?: Job, fileDiff?: FileDiff) {
    const willExpand = !expandedActions[diffKey];
    setExpandedActions((current) => ({ ...current, [diffKey]: !current[diffKey] }));
    if (!willExpand || fileDiff) {
      return;
    }
    if (job?.id && (job.gitDiffOmitted || (job.gitDiffStat && !job.gitDiff))) {
      loadJobDetails(job.id).catch(() => undefined);
    }
    if (message.metadata?.metadataOmitted || message.metadata?.gitDiffOmitted) {
      loadMessageDetails(message.id).catch(() => undefined);
    }
  }

  function renderCodexChangeCard(message: ChatMessage, job?: Job, progress?: JobProgress | null) {
    const stat = job?.gitDiffStat || (typeof message.metadata?.gitDiffStat === "string" ? message.metadata.gitDiffStat : "");
    const diff = job?.gitDiff || (typeof message.metadata?.gitDiff === "string" ? message.metadata.gitDiff : "");
    if (message.role !== "assistant" || (!stat && !hasProgressChanges(progress))) return null;
    const fileDiffs = parseUnifiedDiff(diff);
    const exactRows = diffRowsFromFileDiffs(fileDiffs);
    const rows = exactRows.length ? exactRows : diffRows(stat || null, progress?.files);
    const summary = exactRows.length ? diffSummaryFromRows(exactRows) : diffSummary(stat || null, progress);
    if (summary.files <= 0 && !rows.length) return null;
    const actionKey = `changes:${message.id}`;
    const fileListVisible = expandedActions[actionKey] !== false;
    const durationSeconds = job?.finishedAt ? jobDurationSeconds(job) : messageDurationSeconds(message);
    return (
      <div className="codex-change-card">
        <div className="codex-change-head">
          <div className="codex-change-title">
            <span className="change-icon"><Wrench size={16} /></span>
            <div>
              <strong>Edited {summary.files} {summary.files === 1 ? "file" : "files"}</strong>
              <small>
                {durationSeconds > 0 && <span className="duration">Worked for {formatDuration(durationSeconds)}</span>}
                {summary.added !== null && <span className="added">+{summary.added}</span>}
                {summary.deleted !== null && <span className="deleted">-{summary.deleted}</span>}
              </small>
            </div>
          </div>
          <button type="button" onClick={() => expandChangeCard(actionKey, message, job)}>
            {fileListVisible ? "Hide" : "Details"}
          </button>
        </div>
        {fileListVisible && rows.length ? (
          <div className="codex-change-files">
            {rows.map((row) => {
              const fileDiff = findFileDiffInList(fileDiffs, row.file);
              const diffKey = `filediff:${message.id}:${row.file}`;
              const fileExpanded = Boolean(expandedActions[diffKey]);
              return (
                <div className="codex-change-file" key={row.file}>
                  <button
                    className="codex-change-file-row"
                    type="button"
                    onClick={() => toggleFileDiff(diffKey, message, job, fileDiff)}
                  >
                    <span>{row.file}</span>
                    <small className="diff-meta">
                      {renderDiffRowMeta(row)}
                      <ChevronDown className={fileExpanded ? "open" : ""} size={15} />
                    </small>
                  </button>
                  {fileExpanded && (fileDiff ? renderFileDiff(fileDiff) : <div className="codex-change-loading">Loading diff...</div>)}
                </div>
              );
            })}
          </div>
        ) : fileListVisible ? (
          <div className="codex-change-empty">
            {summary.files > 0 ? "File list is loading or not available yet." : "No files changed."}
          </div>
        ) : null}
      </div>
    );
  }

  function renderFileDiff(fileDiff: FileDiff) {
    return (
      <div className="file-diff-panel">
        {fileDiff.lines.map((line, index) => (
          <div className={`file-diff-line ${line.type}`} key={`${line.oldLine ?? ""}:${line.newLine ?? ""}:${index}`}>
            <span className="line-number">{line.oldLine ?? ""}</span>
            <span className="line-number">{line.newLine ?? ""}</span>
            <code>{line.text || " "}</code>
          </div>
        ))}
      </div>
    );
  }

  function renderCodexActions(message: ChatMessage, job?: Job) {
    const jobId = messageJobId(message);
    const webActions = job && job.id === activeJob?.id && jobId === activeJob.id ? codexActionEntries(logs) : [];
    const actions = webActions.length ? webActions : metadataCodexActions(message);
    if (!actions.length) return null;
    const actionKey = `actions:${message.id}`;
    const expanded = Boolean(expandedActions[actionKey]);
    return (
      <div className="message-actions run-actions">
        <button type="button" onClick={() => expandCodexActions(actionKey, message)}>
          <Terminal size={15} />
          <span>Ran {actions.length} commands</span>
          <ChevronDown className={expanded ? "open" : ""} size={15} />
        </button>
        {expanded && (
          <div className="message-action-details command-details">
            {actions.map((action, index) => renderCommandCard(message.id, action, index))}
          </div>
        )}
      </div>
    );
  }

  function renderCommandCard(ownerKey: string, action: CodexAction, index: number) {
    const parsed = parseCommandOutput(action.output);
    const commandKey = `command:${ownerKey}:${action.id || index}`;
    const commandOpen = expandedActions[commandKey] !== false;
    const status = commandStatusLabel(action, parsed.exitCode);
    const body = parsed.body || (action.status.toLowerCase().includes("running") ? "Command is still running..." : "");
    return (
      <div className={`command-card ${status.toLowerCase()}`} key={action.id || index}>
        <button
          className="command-card-toggle"
          type="button"
          onClick={() => setExpandedActions((current) => ({ ...current, [commandKey]: current[commandKey] === false }))}
        >
          <span>{commandRunLabel(action, parsed.wallTime)}</span>
          <ChevronDown className={commandOpen ? "open" : ""} size={15} />
        </button>
        {commandOpen && (
          <div className="command-console">
            <div className="command-console-head">
              <span>Shell</span>
              {parsed.exitCode && <small>Exit {parsed.exitCode}</small>}
            </div>
            <pre>
              <code>
                <span className="command-prompt">$ {action.command}</span>
                {body && <>{`\n\n${body}`}</>}
              </code>
            </pre>
            <div className="command-console-status">
              <span>{status}</span>
            </div>
          </div>
        )}
      </div>
    );
  }

  function renderLiveActivity() {
    if (!activeJob) return null;
    const entries = liveActivityEntries(logs);
    if (!entries.length && !activeProgress) return null;
    const actionKey = `live-activity:${activeJob.id}`;
    const expanded = expandedActions[actionKey] !== false;
    const commandCount = entries.filter((entry) => entry.kind === "command").length;
    const updateCount = entries.filter((entry) => entry.kind !== "command").length;
    return (
      <section className="live-activity-card" aria-live="polite">
        <button
          className="live-activity-toggle"
          type="button"
          onClick={() => setExpandedActions((current) => ({ ...current, [actionKey]: current[actionKey] === false }))}
        >
          <Activity size={16} />
          <span>
            <strong>Ход работы</strong>
            <small>{activeProgress ? jobProgressMessage(activeProgress) : "Жду события от локального Codex"}</small>
          </span>
          <em>{[updateCount ? `ответов: ${updateCount}` : "", commandCount ? `команд: ${commandCount}` : ""].filter(Boolean).join(" · ") || "ожидание"}</em>
          <ChevronDown className={expanded ? "open" : ""} size={15} />
        </button>
        {expanded && (
          <div className="live-activity-timeline">
            {entries.length ? entries.map(renderLiveActivityEntry) : (
              <div className="live-activity-empty">Жду события от Codex...</div>
            )}
          </div>
        )}
      </section>
    );
  }

  function renderLiveActivityEntry(entry: LiveActivityEntry, index: number) {
    if (entry.kind === "command" && entry.action) return renderLiveCommandEntry(entry, index);
    const isError = entry.kind === "error";
    return (
      <article className={`live-activity-entry ${entry.kind}`} key={entry.id || index}>
        <span className="live-activity-marker">{isError ? <X size={13} /> : <Bot size={13} />}</span>
        <div className="live-activity-content">
          <div className="live-activity-meta">
            <strong>{isError ? "Ошибка" : "Codex"}</strong>
            <small>{new Date(entry.at).toLocaleTimeString()}</small>
          </div>
          {renderRichText(entry.text ?? "", "rich-text compact live-activity-text")}
        </div>
      </article>
    );
  }

  function renderLiveCommandEntry(entry: LiveActivityEntry, index: number) {
    const action = entry.action!;
    const parsed = parseCommandOutput(action.output);
    const status = commandStatusLabel(action, parsed.exitCode);
    const commandKey = `live-command:${activeJob?.id}:${action.id || index}`;
    const hasDetails = Boolean(parsed.body || action.output || status === "Running");
    const commandOpen = status === "Failed" || Boolean(expandedActions[commandKey]);
    return (
      <article className={`live-activity-entry command ${status.toLowerCase()}`} key={entry.id || index}>
        <span className="live-activity-marker"><Terminal size={13} /></span>
        <div className="live-activity-content">
          <button
            className="live-command-row"
            disabled={!hasDetails}
            type="button"
            onClick={() => setExpandedActions((current) => ({ ...current, [commandKey]: !current[commandKey] }))}
          >
            <span className={`live-status ${status.toLowerCase()}`}>{status}</span>
            <code>{action.command}</code>
            <small>{new Date(entry.at).toLocaleTimeString()}</small>
            {hasDetails && <ChevronDown className={commandOpen ? "open" : ""} size={14} />}
          </button>
          {hasDetails && commandOpen && (
            <pre className="live-command-output">
              <code>{parsed.body || "Команда ещё выполняется..."}</code>
            </pre>
          )}
        </div>
      </article>
    );
  }

  function renderCollapsedRunTrace(finalMessage: ChatMessage, summary: CollapsedRunSummary) {
    const actionKey = `runtrace:${finalMessage.id}`;
    const expanded = Boolean(expandedActions[actionKey]);
    const updateCount = summary.messages.length;
    const traceLabel = `${updateCount} шагов${summary.commandCount ? ` · ${summary.commandCount} команд` : ""}`;
    return (
      <div className="run-trace">
        <button
          type="button"
          onClick={() => setExpandedActions((current) => ({ ...current, [actionKey]: !current[actionKey] }))}
        >
          <Clock3 size={15} />
          <span>{traceLabel}</span>
          <ChevronDown className={expanded ? "open" : ""} size={15} />
        </button>
        {expanded && (
          <div className="run-trace-details">
            {summary.messages.map((message, index) => {
              const jobId = messageJobId(message);
              const messageJob = jobId ? jobs.find((job) => job.id === jobId) ?? summary.job : summary.job;
              return (
                <article className="run-trace-step" key={message.id}>
                  <div className="message-meta">
                    <span>Шаг {index + 1}</span>
                    <small>{formatDateTime(message.createdAt)}</small>
                  </div>
                  {renderRichText(message.content, "rich-text message-body")}
                  {renderMessageAttachments(message.attachments, setImagePreview)}
                  {renderCodexActions(message, messageJob)}
                </article>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  function renderActiveRun() {
    if (!activeJob || !activeRunBusy) return null;
    const promptAlreadyVisible = messages.some((message) => isJobPromptMessage(message, activeJob.id));
    const showActiveDiff = hasProgressChanges(activeProgress);
    return (
      <>
        {!promptAlreadyVisible && (
          <div className="job-head">
            <span className={`pill ${activeJob.status}`}><CheckCircle2 size={15} /> {activeJob.status}</span>
            <strong>{activeJob.prompt}</strong>
          </div>
        )}
        {renderLiveActivity()}
        {activeProgress && showActiveDiff && (
          <div className="progress-wrap">
            <div className="progress-panel">
              <div>
                <span className="progress-label">{jobProgressLabel(activeProgress)}</span>
                <strong>{jobProgressMessage(activeProgress)}</strong>
              </div>
              <div className="progress-stats">
                <span>{activeProgress.filesChanged ?? 0} files</span>
                <span>+{activeProgress.added ?? 0}</span>
                <span>-{activeProgress.deleted ?? 0}</span>
              </div>
            </div>
            {activeProgress.files?.length ? (
              <div className="progress-files">
                {(activeProgress.files ?? []).slice(0, 8).map((file) => (
                  <div key={file.path}>
                    <span>{file.path}</span>
                    <small className="diff-meta">
                      <span className="diff-added">+{file.added}</span>
                      <span className="diff-deleted">-{file.deleted}</span>
                    </small>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        )}
      </>
    );
  }

  function openProjectNewChat() {
    if (!selectedRepo) return;
    setChatProperties(null);
    setChatMenuId("");
    setChatNotice("");
    setChatNoticeOk(false);
    resetActiveChatView();
    window.requestAnimationFrame(() => {
      composerRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      composerRef.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
    });
  }

  function renderProjectOverview() {
    if (!selectedRepo || activeChat) return null;
    const previewLabel = selectedRepo.domain || selectedRepo.githubUrl || selectedRepo.pathMasked;
    return (
      <section className="project-home" aria-label="Обзор проекта">
        {selectedProjectUrl ? (
          <div className="project-site-preview">
            <div className="project-site-framebar">
              <span className="project-site-browser">
                <i />
                <i />
                <i />
                <strong>{selectedProjectUrl}</strong>
              </span>
              <a className="project-site-open" href={selectedProjectUrl} target="_blank" rel="noreferrer">
                <ExternalLink size={14} /> Open
              </a>
            </div>
            <iframe
              loading="lazy"
              referrerPolicy="no-referrer"
              sandbox="allow-forms allow-popups allow-same-origin allow-scripts"
              src={selectedProjectUrl}
              title={`Preview ${selectedRepo.name}`}
            />
          </div>
        ) : (
          <article className="project-site-card">
            <div className="project-home-head">
              <div>
                <h3><ExternalLink size={16} /> Сайт</h3>
                <small>{previewLabel}</small>
              </div>
              <button className="secondary compact" type="button" onClick={() => openProjectSettings(selectedRepo)}>
                <Settings size={15} /> Домен
              </button>
            </div>
            <div className="project-site-empty">
              <ExternalLink size={18} />
              <strong>Домен не привязан</strong>
              <small>{selectedRepo.githubUrl || selectedRepo.pathMasked}</small>
            </div>
          </article>
        )}
        <article className="project-recent-card">
          <div className="project-home-head">
            <div>
              <h3><MessageSquare size={16} /> Последние чаты</h3>
              <small>{recentProjectChats.length ? `${recentProjectChats.length} последних` : "Нет истории"}</small>
            </div>
            <button className="secondary compact" type="button" onClick={openProjectNewChat}>
              <Plus size={15} /> Новый чат
            </button>
          </div>
          <div className="project-recent-list">
            {recentProjectChats.map((chat) => (
              <button
                className="project-recent-chat"
                key={chat.id}
                type="button"
                onClick={() => {
                  setMobileMenuOpen(false);
                  setView("projects");
                  loadChat(chat.id, undefined, true).catch(() => undefined);
                }}
              >
                <span>
                  <strong>{chat.title}</strong>
                  <small>{chatIdentityText(chat)}</small>
                </span>
                <time dateTime={chat.updatedAt}>{formatDateTime(chat.updatedAt)}</time>
              </button>
            ))}
            {!recentProjectChats.length && (
              <div className="project-recent-empty">
                <MessageSquare size={18} />
                <strong>Чатов пока нет</strong>
                <small>Первое сообщение создаст чат.</small>
              </div>
            )}
          </div>
        </article>
      </section>
    );
  }

  function renderComposer() {
    if (!selectedRepo) return null;
    const canSubmit = Boolean(prompt.trim() || attachments.length);
    const runDisabled = busy || !canSubmit || localCodexBusy || activeRunBusy;
    const selectedModelLabel = CODEX_MODEL_OPTIONS.find((option) => option.value === codexModel)?.label ?? codexModel;
    const selectedReasoningLabel = REASONING_OPTIONS.find((option) => option.value === reasoningEffort)?.label ?? reasoningEffort;
    const selectedSpeedLabel = SPEED_OPTIONS.find((option) => option.value === codexSpeed)?.label ?? codexSpeed;
    const showCodexBusy = localCodexBusy || activeRunBusy;
    return (
      <form className="composer" ref={composerRef} onSubmit={createJob}>
        {attachments.length > 0 && (
          <div className="attachment-list">
            {attachments.map((attachment) => (
              <div className="attachment-chip" key={attachment.id}>
                {attachment.previewUrl ? <img alt="" className="attachment-thumb" src={attachment.previewUrl} /> : <Paperclip size={16} />}
                <span>
                  <strong>{attachment.name}</strong>
                  <small>{attachment.mimeType} · {formatBytes(attachment.size)}</small>
                </span>
                <button aria-label={`Remove ${attachment.name}`} className="attachment-remove" type="button" onClick={() => removeAttachment(attachment.id)}>
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
        {attachmentNotice && <div className="notice danger">{attachmentNotice}</div>}
        <textarea
          placeholder="Опишите задачу, что вы хотите сделать сегодня?"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={handleComposerKeyDown}
          onPaste={handleComposerPaste}
        />
        <div className="sticky-submit">
          <input
            className="file-input"
            id="composer-attachment-input"
            multiple
            type="file"
            onChange={(event) => {
              if (event.currentTarget.files) addFiles(event.currentTarget.files);
              event.currentTarget.value = "";
            }}
          />
          <button className="run-button" disabled={runDisabled} type="submit">
            {showCodexBusy ? <RefreshCw className="spin" size={18} /> : <Play size={18} />}
            {showCodexBusy ? `${activeRunBusy ? jobProgressLabel(activeProgress) : "Codex занят"} ${formatDuration(thinkingSeconds)}` : "Отправить"}
          </button>
          <label className="attachment-picker" htmlFor="composer-attachment-input" title="Attach files">
            <Paperclip size={18} />
          </label>
          <div className="sandbox-control">
            <button
              aria-expanded={sandboxMenuOpen}
              aria-label={`Sandbox mode: ${SANDBOX_LABELS[sandbox]}`}
              className="sandbox-trigger"
              title={`Sandbox mode: ${SANDBOX_LABELS[sandbox]}`}
              type="button"
              onClick={() => {
                setActionMenuOpen(false);
                setSandboxMenuOpen((value) => !value);
              }}
            >
              <ShieldCheck size={18} />
            </button>
            {sandboxMenuOpen && (
              <div className="sandbox-menu" role="menu">
                {selectedRepo.allowedSandboxes.map((item) => (
                  <button
                    className={sandbox === item ? "selected" : ""}
                    key={item}
                    role="menuitemcheckbox"
                    aria-checked={sandbox === item}
                    type="button"
                    onClick={() => {
                      setSandbox(item);
                      setSandboxMenuOpen(false);
                    }}
                  >
                    <span>{SANDBOX_LABELS[item]}</span>
                    {sandbox === item && <Check size={16} />}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="action-control">
            <button
              aria-expanded={actionMenuOpen}
              aria-label="Message actions"
              className="action-trigger"
              title="Actions"
              type="button"
              onClick={() => {
                setSandboxMenuOpen(false);
                setActionMenuOpen((value) => !value);
              }}
            >
              <MoreHorizontal size={18} />
            </button>
            {actionMenuOpen && (
              <div className="action-menu" role="menu">
                <button className="project-menu-action" disabled={launchBusy || gitBusy || deployBusy || nginxBusy || sslBusy || !hasDeployConfig(selectedRepo)} role="menuitem" type="button" onClick={launchProject}>
                  <Rocket size={16} />
                  <span className="step-badge">1-4</span>
                  <span>Launch</span>
                </button>
                <button className="project-menu-action" disabled={launchBusy || gitBusy || !gitMessage.trim()} role="menuitem" type="button" onClick={runGitSync}>
                  <UploadCloud size={16} />
                  <span className="step-badge">1</span>
                  <span>Commit & push</span>
                </button>
                <button className="project-menu-action" disabled={launchBusy || deployBusy || !hasDeployConfig(selectedRepo)} role="menuitem" type="button" onClick={deployProject}>
                  <UploadCloud size={16} />
                  <span className="step-badge">2</span>
                  <span>Deploy</span>
                </button>
                <button className="project-menu-action" disabled={launchBusy || nginxBusy || !hasDeployConfig(selectedRepo) || !selectedRepo.domain} role="menuitem" type="button" onClick={configureNginx}>
                  <Settings size={16} />
                  <span className="step-badge">3</span>
                  <span>Nginx</span>
                </button>
                <button className="project-menu-action" disabled={launchBusy || sslBusy || !hasDeployConfig(selectedRepo) || !selectedRepo.domain} role="menuitem" type="button" onClick={configureSsl}>
                  <Settings size={16} />
                  <span className="step-badge">4</span>
                  <span>SSL</span>
                </button>
                <button
                  className="project-menu-action"
                  disabled={!selectedProjectUrl}
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    if (!selectedProjectUrl) return;
                    setActionMenuOpen(false);
                    window.open(selectedProjectUrl, "_blank", "noopener,noreferrer");
                  }}
                >
                  <ExternalLink size={16} />
                  <span className="step-badge">5</span>
                  <span>Open</span>
                </button>
                <div className="menu-divider" />
                <button disabled={vscodeBusy} role="menuitem" type="button" onClick={() => runVscodeCommand("openSidebar")}>
                  <PanelLeftOpen size={16} />
                  <span>Open VS Code Codex</span>
                </button>
                <button disabled={vscodeBusy || !activeCodexThreadId} role="menuitem" type="button" onClick={() => runVscodeCommand("openThread", selectedRepo.agentId, { threadId: activeCodexThreadId })}>
                  <MessageSquare size={16} />
                  <span>Open current VS Code thread</span>
                </button>
                <button disabled={vscodeBusy || !activeCodexThreadId} role="menuitem" type="button" onClick={() => runVscodeCommand("reopenThread", selectedRepo.agentId, { threadId: activeCodexThreadId })}>
                  <RefreshCw size={16} />
                  <span>Reopen current thread</span>
                </button>
                <button disabled={vscodeBusy} role="menuitem" type="button" onClick={() => runVscodeCommand("newChat")}>
                  <MessageSquare size={16} />
                  <span>New VS Code chat</span>
                </button>
                <button disabled={vscodeBusy} role="menuitem" type="button" onClick={() => runVscodeCommand("addToThread")}>
                  <Plus size={16} />
                  <span>Add current context</span>
                </button>
                <div className="menu-divider" />
                <div className="menu-section">
                  <span className="menu-section-title">Intelligence</span>
                  {REASONING_OPTIONS.map((option) => (
                    <button
                      className={reasoningEffort === option.value ? "selected" : ""}
                      key={option.value}
                      role="menuitemcheckbox"
                      aria-checked={reasoningEffort === option.value}
                      type="button"
                      onClick={() => setReasoningEffort(option.value)}
                    >
                      <span>{option.label}</span>
                      {reasoningEffort === option.value && <Check size={15} />}
                    </button>
                  ))}
                </div>
                <div className="menu-section">
                  <span className="menu-section-title">Model</span>
                  {CODEX_MODEL_OPTIONS.map((option) => (
                    <button
                      className={codexModel === option.value ? "selected" : ""}
                      key={option.value}
                      role="menuitemcheckbox"
                      aria-checked={codexModel === option.value}
                      type="button"
                      onClick={() => setCodexModel(option.value)}
                    >
                      <span>{option.label}</span>
                      {codexModel === option.value && <Check size={15} />}
                    </button>
                  ))}
                </div>
                <div className="menu-section">
                  <span className="menu-section-title">Speed</span>
                  {SPEED_OPTIONS.map((option) => (
                    <button
                      className={`speed-option ${codexSpeed === option.value ? "selected" : ""}`}
                      key={option.value}
                      role="menuitemcheckbox"
                      aria-checked={codexSpeed === option.value}
                      type="button"
                      onClick={() => setCodexSpeed(option.value)}
                    >
                      <span>
                        <strong>{option.label}</strong>
                        <small>{option.note}</small>
                      </span>
                      {codexSpeed === option.value && <Check size={15} />}
                    </button>
                  ))}
                </div>
                <div className="menu-summary">
                  {selectedModelLabel} · {selectedReasoningLabel} · {selectedSpeedLabel}
                </div>
                {vscodeNotice && <div className="menu-summary">{vscodeNotice}</div>}
              </div>
            )}
          </div>
          {activeJob && ["queued", "assigned", "running"].includes(activeJob.status) && (
            <button className="stop" type="button" onClick={cancelJob}><Square size={18} /> Stop</button>
          )}
        </div>
      </form>
    );
  }

  if (!csrf) {
    return (
      <main className="login">
        <section className="login-panel">
          <img className="brand-logo large" src="/favicon.svg" alt="" />
          <h1>Codex Control</h1>
          <p>Домашний Codex, управляемый с iPhone.</p>
          <div className={`auth-tabs ${registrationOpen ? "" : "single"}`}>
            <button className={authMode === "login" ? "active" : ""} type="button" onClick={() => setAuthMode("login")}>Вход</button>
            {registrationOpen && <button className={authMode === "register" ? "active" : ""} type="button" onClick={() => setAuthMode("register")}>Регистрация</button>}
          </div>
          <form onSubmit={authMode === "login" ? login : register}>
            <input autoComplete="email" placeholder="email" value={email} onChange={(event) => setEmail(event.target.value)} />
            {authMode === "register" && (
              <input autoComplete="nickname" placeholder="nickname, optional" value={registerNickname} onChange={(event) => setRegisterNickname(event.target.value)} />
            )}
            <input autoComplete={authMode === "login" ? "current-password" : "new-password"} placeholder="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
            <button disabled={busy || !email.trim() || !password || (authMode === "register" && password.length < 8)} type="submit"><Play size={18} /> {authMode === "login" ? "Войти" : "Создать аккаунт"}</button>
          </form>
          <div className="oauth-login">
            <span>{registrationOpen ? "Войти или зарегистрироваться через" : "Войти через"}</span>
            <div>
              {(authOauthProviders.length ? authOauthProviders : ["google", "vk"].map((provider) => ({ provider, connected: false, configured: false } as OAuthProvider))).map((provider) => (
                <button key={provider.provider} type="button" disabled={busy} onClick={() => startAuthOAuth(provider.provider)} title={provider.configured ? oauthLabel(provider.provider) : `${oauthLabel(provider.provider)} не настроен`}>
                  {oauthIcon(provider.provider)}
                  <span>{oauthLabel(provider.provider)}</span>
                </button>
              ))}
            </div>
          </div>
          {authNotice && <div className="notice danger">{authNotice}</div>}
        </section>
      </main>
    );
  }

  if (isAdminRoute) {
    if (currentUser?.role !== "admin") {
      return (
        <main className="login">
          <section className="login-panel">
            <img className="brand-logo large" src="/favicon.svg" alt="" />
            <h1>Admin</h1>
            <p>Нужны права администратора.</p>
            <a className="secondary" href="/"><ArrowLeft size={16} /> Вернуться</a>
          </section>
        </main>
      );
    }
    return renderAdmin();
  }

  return (
    <>
    <main className={`app-frame ${sidebarCollapsed ? "nav-collapsed" : ""}`}>
      <aside className={`app-nav ${mobileMenuOpen ? "open" : ""}`}>
        <div className="nav-brand">
          <img className="brand-logo" src="/favicon.svg" alt="" />
          <strong>codex.rodion.pro</strong>
          <button className="icon mobile-nav-close" type="button" onClick={() => setMobileMenuOpen(false)} title="Закрыть меню">
            <X size={18} />
          </button>
        </div>
        <nav>
          <div className="nav-group">
            <button className={view === "projects" ? "nav-item active" : "nav-item"} onClick={clearProjectSelection}><FolderGit2 size={17} /> Projects</button>
            <div className="nav-subtree">
              <button className={view === "search" ? "nav-leaf project active" : "nav-leaf project"} type="button" onClick={openSearchView}>
                <span className="nav-project-title">
                  <Search size={14} />
                  <span>Search</span>
                </span>
                <small>Public projects and profiles</small>
              </button>
              {repos.map((repo) => {
                const selected = selectedRepo?.agentId === repo.agentId && selectedRepo.id === repo.id;
                const currentRepoKey = `${repo.agentId}:${repo.id}`;
                const busyProjectCount = busyCountByRepo.get(currentRepoKey) ?? 0;
                return (
                  <div className="nav-project" key={currentRepoKey}>
                    <button className={selected ? "nav-leaf project active" : "nav-leaf project"} onClick={() => selectProject(repo)}>
                      <span className="nav-project-title">
                        {busyProjectCount > 0 && (
                          <span className="busy-indicator" aria-label={`${busyProjectCount} working chats`}>
                            <RefreshCw className="spin" size={13} />
                            {busyProjectCount > 1 && <small>{busyProjectCount}</small>}
                          </span>
                        )}
                        <span>{repo.name}</span>
                      </span>
                      <small>{repoAgentLabel(repo)} · {repo.currentBranch || "no branch"} · {repo.dirty ? "dirty" : "clean"}</small>
                    </button>
                    {selected && (
                      <div className="nav-project-chats">
                        <form className="nav-new-chat" onSubmit={createChat}>
                          <input placeholder="New chat title" value={chatTitle} onChange={(event) => setChatTitle(event.target.value)} />
                          <button
                            className="nav-sync-chat"
                            disabled={localChatSyncing || !online}
                            onClick={() => syncLocalChats(repo).catch(() => {
                              setChatNoticeOk(false);
                              setChatNotice("Не получилось синхронизировать локальные чаты.");
                            })}
                            title="Синхронизировать локальные чаты Codex/VS Code"
                            type="button"
                          >
                            <RefreshCw className={localChatSyncing ? "spin" : ""} size={14} />
                            <span>Sync</span>
                          </button>
                          <button disabled={busy || !chatTitle.trim()}><Plus size={14} /></button>
                        </form>
                        {chats.map((chat) => (
                          <div className={activeChatId === chat.id ? "nav-chat-row active" : "nav-chat-row"} key={chat.id}>
                            {renamingChatId === chat.id ? (
                              <form className="nav-chat-rename" onSubmit={(event) => renameChat(event, chat)}>
                                <input
                                  autoFocus
                                  value={renameTitle}
                                  onChange={(event) => setRenameTitle(event.target.value)}
                                  onKeyDown={(event) => {
                                    if (event.key === "Escape") cancelRenameChat();
                                  }}
                                />
                                <button disabled={busy || !renameTitle.trim()} title="Сохранить имя" type="submit">
                                  <Check size={14} />
                                </button>
                                <button title="Отмена" type="button" onClick={cancelRenameChat}>
                                  <X size={14} />
                                </button>
                              </form>
                            ) : (
                              <>
                                {(() => {
                                  const chatIsBusy = activeBusyChatIds.has(chat.id)
                                    || (localBusyRepoKey === currentRepoKey && localBusyChatTitle === chat.title)
                                    || (localBusyRepoKey === currentRepoKey && localBusyChatId === chat.id);
                                  return (
                                    <button className="nav-leaf chat-child" type="button" onClick={() => {
                                      setMobileMenuOpen(false);
                                      setView("projects");
                                      loadChat(chat.id, undefined, true).catch(() => undefined);
                                    }}>
                                      <span className="nav-chat-title">
                                        {chatIsBusy && <RefreshCw className="spin" size={13} />}
                                        <span>{chat.title}</span>
                                      </span>
                                      <small>{chatIdentityText(chat)} · {formatDateTime(chat.updatedAt)}</small>
                                    </button>
                                  );
                                })()}
                                <button className="nav-menu-trigger" disabled={busy} type="button" onClick={() => setChatMenuId((value) => value === chat.id ? "" : chat.id)} title="Chat menu">
                                  <MoreHorizontal size={15} />
                                </button>
                                {chatMenuId === chat.id && (
                                  <div className="nav-chat-menu">
                                    <button type="button" onClick={() => startRenameChat(chat)}>Переименовать</button>
                                    <button type="button" onClick={() => openChatProperties(chat)}>Свойства</button>
                                    <button type="button" disabled={shareBusy} onClick={() => shareChat(chat)}>Ссылка</button>
                                    <button
                                      type="button"
                                      disabled={activeJob?.chatId === chat.id && ["queued", "assigned", "running"].includes(activeJob.status)}
                                      onClick={() => hideChat(chat)}
                                    >
                                      Скрыть
                                    </button>
                                  </div>
                                )}
                              </>
                            )}
                          </div>
                        ))}
                        {!chats.length && <span className="nav-empty inset">No chats</span>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          <button className={view === "settings" ? "nav-item active" : "nav-item"} onClick={openSettingsView}><Settings size={17} /> Settings</button>
          <button className={view === "sync" ? "nav-item active" : "nav-item"} onClick={openSyncView}><PlugZap size={17} /> Sync</button>
          <button className={view === "profile" ? "nav-item active" : "nav-item"} onClick={openProfileView}><UserCircle size={17} /> Profile</button>
          {currentUser?.role === "admin" && (
            <button className="nav-item" onClick={() => { window.location.href = "/admin"; }}><ShieldCheck size={17} /> Admin</button>
          )}
        </nav>
        <div className={`nav-agent ${online ? "online" : "offline"}`}>
          <span>{online ? "Online" : "Offline"}</span>
          <strong>{selectedAgent?.name ?? "Home Windows Agent"}</strong>
          <small>{selectedAgent?.hostname ?? "Waiting for heartbeat"}</small>
        </div>
      </aside>
      {mobileMenuOpen && <button className="mobile-menu-backdrop" aria-label="Закрыть меню" type="button" onClick={() => setMobileMenuOpen(false)} />}

      <section className="shell" ref={shellRef} onScroll={() => scheduleChatBottomStateUpdate("scroll")}>
      <header className="app-header">
        <div className="topbar">
          <div className="top-nav-controls">
            <button
              className="icon sidebar-toggle"
              type="button"
              onClick={() => setSidebarCollapsed((value) => !value)}
              title={sidebarCollapsed ? "Показать боковую панель" : "Скрыть боковую панель"}
            >
              {sidebarCollapsed ? <PanelLeftOpen size={19} /> : <PanelLeftClose size={19} />}
            </button>
            <button className="icon mobile-menu-toggle" type="button" onClick={() => setMobileMenuOpen(true)} title="Меню">
              <Menu size={19} />
            </button>
          </div>
          <div className="top-title">
            <span className={`status ${online ? "ok" : "bad"}`}>{online ? <Wifi size={16} /> : <WifiOff size={16} />} {selectedAgentStatusLabel}</span>
            <h1>{view === "settings" ? "Settings" : view === "profile" ? "Profile" : view === "sync" ? "Sync" : view === "search" ? "Search" : selectedRepo ? selectedRepo.name : "Projects"}</h1>
          </div>
          <div className="top-actions">
            {selectedRepo && <button className="icon" onClick={clearProjectSelection} title="Проекты"><ArrowLeft size={18} /></button>}
            <button className="icon" onClick={refresh} title="Обновить"><RefreshCw size={18} /></button>
            <button className="icon" onClick={logout} title="Выйти"><LogOut size={18} /></button>
          </div>
        </div>

        {selectedAgent && (
          <section className="machine-strip">
            <article className="machine">
              <strong>{selectedAgent.name}</strong>
              <span>{selectedAgent.hostname || selectedAgent.id}</span>
              <small>{selectedAgent.codex_version || "codex not probed"} · {selectedAgent.git_version || "git not probed"}</small>
            </article>
          </section>
        )}
      </header>

      {view === "settings" && renderSettings()}
      {view === "profile" && renderProfile()}
      {view === "sync" && renderSync()}
      {view === "search" && renderSearch()}

      {view === "projects" && !selectedRepo && (
        <section className="project-picker">
          <div className="section-head">
            <h2><FolderGit2 size={18} /> Projects</h2>
            <button className="secondary" onClick={openNewProject}><Plus size={16} /> Add project</button>
          </div>
          <div className="project-grid">
            {repos.map((repo) => (
              <article className="project-card" key={`${repo.agentId}:${repo.id}`}>
                <button className="project-main" onClick={() => selectProject(repo)}>
                  <strong>{repo.name}</strong>
                  <span><Server size={14} /> {repoAgentLabel(repo)}</span>
                  <span><GitBranch size={14} /> {repo.currentBranch || "no branch"} · {repo.dirty ? "dirty" : "clean"}</span>
                  <small>{repo.pathMasked}</small>
                  {repo.domain && <small>{repo.domain}</small>}
                </button>
                <button className="project-settings-button" onClick={() => {
                  setRepoKey(`${repo.agentId}:${repo.id}`);
                  openProjectSettings(repo);
                }} title="Настройки проекта" type="button"><Settings size={15} /></button>
              </article>
            ))}
          </div>
        </section>
      )}

      {view === "projects" && projectPanel && (
        projectPanel === "new" ? renderProjectWizard() : renderProjectSettingsForm()
      )}

      {view === "projects" && selectedRepo && (
        <section className="project-workspace">
          {chatProperties && (
            <form className="project-form chat-properties" onSubmit={saveChatProperties}>
              <div className="section-head">
                <h2><MessageSquare size={18} /> Свойства чата</h2>
                <button className="secondary" type="button" onClick={() => setChatProperties(null)}>Close</button>
              </div>
              <label>
                Название
                <input value={chatSettingsTitle} onChange={(event) => setChatSettingsTitle(event.target.value)} />
              </label>
              <div className="settings-row">
                <span>Источник</span>
                <strong>{chatProperties.source || "web"}</strong>
              </div>
              {chatProperties.externalId && (
                <div className="settings-row">
                  <span>Local chat id</span>
                  <strong>{chatProperties.externalId}</strong>
                </div>
              )}
              <label>
                Подключить локальный Codex/VS Code чат
                <select value={linkedChatId} onChange={(event) => setLinkedChatId(event.target.value)}>
                  <option value="">Не менять связь</option>
                  {hiddenLocalChats.map((chat) => (
                    <option key={chat.id} value={chat.id}>{chat.source}: {chat.title}</option>
                  ))}
                </select>
              </label>
              <p>Скрытые локальные чаты можно вернуть или подключить к текущему веб-чату. История при скрытии не удаляется.</p>
              <div className="hidden-chat-list">
                {hiddenLocalChats.map((chat) => (
                  <div className="settings-row" key={chat.id}>
                    <span>{chat.source}: {chat.title}</span>
                    <button className="secondary" type="button" onClick={() => restoreHiddenChat(chat)}>Вернуть</button>
                  </div>
                ))}
                {!hiddenLocalChats.length && <span className="small-empty">Нет скрытых локальных чатов для этого проекта.</span>}
              </div>
              {chatNotice && <div className={chatNoticeOk ? "notice success" : "notice danger"}>{chatNotice}</div>}
              <button disabled={busy || !chatSettingsTitle.trim()} type="submit"><Save size={16} /> Save chat</button>
            </form>
          )}

          <section className="chat-work">
            <div className="section-head">
              <div className="chat-heading">
                <h2><MessageSquare size={18} /> <span>{activeChat?.title ?? "Обзор проекта"}</span></h2>
                {activeChat && (
                  <small title={activeChat.externalId || undefined}>
                    {chatIdentityText(activeChat)}
                  </small>
                )}
              </div>
              <div className="section-actions">
                <button className="secondary compact" type="button" onClick={openProjectNewChat}>
                  <Plus size={15} /> Новый чат
                </button>
                {activeChat && (
                  <button
                    aria-label="Скопировать ссылку на чат"
                    className="icon tiny"
                    disabled={shareBusy}
                    onClick={() => shareChat(activeChat)}
                    title="Скопировать ссылку на чат"
                    type="button"
                  >
                    <Link2 size={16} />
                  </button>
                )}
                <button className="icon tiny" onClick={() => openProjectSettings(selectedRepo)} title="Настройки"><Settings size={16} /></button>
              </div>
            </div>
            <div className="repo-meta">
              <GitBranch size={16} /> {selectedRepo.currentBranch || "no branch"} · {selectedRepo.dirty ? "dirty" : "clean"} · {selectedRepo.pathMasked}
              {selectedRepo.domain && <> · {selectedRepo.domain}</>}
              {selectedRepo.serverPath && <> · {selectedRepo.serverPath}</>}
            </div>
            {selectedRepoAgent && selectedRepoAgent.status !== "online" && (
              <div className="notice warning agent-bind-notice">
                <p>
                  Этот проект привязан к <strong>{selectedRepoAgent.name}</strong>, сейчас он offline.
                  {onlineAgentOnSameHost
                    ? <> На этом же ПК online <strong>{onlineAgentOnSameHost.name}</strong>, но у него нет этих проектов и чатов, поэтому Sync получает 503.</>
                    : <> Пока агент проекта offline, локальные чаты не синхронизируются.</>}
                </p>
                <button className="secondary compact" disabled={busy} type="button" onClick={() => void downloadAgentSetup(selectedRepoAgent)}>
                  <Download size={15} /> Setup для {selectedRepoAgent.name}
                </button>
              </div>
            )}
            {!activeChat && renderProjectOverview()}
            <form className="project-cockpit" onSubmit={syncGit}>
              <div className="cockpit-main">
                <div className="cockpit-title">
                  <strong>{selectedRepo.name}</strong>
                  <span>
                    <GitBranch size={14} /> {selectedRepo.currentBranch || "no branch"} · {selectedRepo.dirty ? "dirty" : "clean"}
                    {selectedRepo.data?.path && <> · <Database size={14} /> {selectedRepo.data.path}</>}
                  </span>
                </div>
                <button
                  className="cockpit-launch"
                  disabled={launchBusy || gitBusy || deployBusy || nginxBusy || sslBusy || !hasDeployConfig(selectedRepo)}
                  type="button"
                  onClick={() => {
                    setProjectActionsOpen(false);
                    void launchProject();
                  }}
                >
                  <Rocket size={16} />
                  Launch
                </button>
                <div className="project-action-control">
                  <button
                    aria-expanded={projectActionsOpen}
                    className="secondary compact"
                    type="button"
                    onClick={() => setProjectActionsOpen((value) => !value)}
                  >
                    <MoreHorizontal size={16} /> Actions
                  </button>
                  {projectActionsOpen && (
                    <div className="project-action-menu" role="menu">
                      <button disabled={launchBusy || gitBusy || !gitMessage.trim()} role="menuitem" type="submit" onClick={() => setProjectActionsOpen(false)}>
                        <UploadCloud size={16} />
                        <span className="step-badge">1</span>
                        <span>Commit & push</span>
                      </button>
                      <button disabled={launchBusy || deployBusy || !hasDeployConfig(selectedRepo)} role="menuitem" type="button" onClick={() => {
                        setProjectActionsOpen(false);
                        void deployProject();
                      }}>
                        <UploadCloud size={16} />
                        <span className="step-badge">2</span>
                        <span>Deploy</span>
                      </button>
                      <button disabled={launchBusy || nginxBusy || !hasDeployConfig(selectedRepo) || !selectedRepo.domain} role="menuitem" type="button" onClick={() => {
                        setProjectActionsOpen(false);
                        void configureNginx();
                      }}>
                        <Settings size={16} />
                        <span className="step-badge">3</span>
                        <span>Nginx</span>
                      </button>
                      <button disabled={launchBusy || sslBusy || !hasDeployConfig(selectedRepo) || !selectedRepo.domain} role="menuitem" type="button" onClick={() => {
                        setProjectActionsOpen(false);
                        void configureSsl();
                      }}>
                        <Settings size={16} />
                        <span className="step-badge">4</span>
                        <span>SSL</span>
                      </button>
                      <button disabled={!selectedProjectUrl} role="menuitem" type="button" onClick={() => {
                        if (!selectedProjectUrl) return;
                        setProjectActionsOpen(false);
                        window.open(selectedProjectUrl, "_blank", "noopener,noreferrer");
                      }}>
                        <ExternalLink size={16} />
                        <span className="step-badge">5</span>
                        <span>Open</span>
                      </button>
                      <div className="menu-divider" />
                      <button role="menuitem" type="button" onClick={() => {
                        setProjectActionsOpen(false);
                        openProjectSettings(selectedRepo);
                      }}>
                        <Settings size={16} />
                        <span>Project settings</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
              <div className="cockpit-fields">
                <input aria-label="Commit message" value={gitMessage} onChange={(event) => setGitMessage(event.target.value)} />
                <input aria-label="Remote URL" placeholder="origin URL, optional" value={gitRemoteUrl} onChange={(event) => setGitRemoteUrl(event.target.value)} />
              </div>
              {(gitNotice || launchNotice || deployNotice || nginxNotice || sslNotice) && (
                <div className="cockpit-notices">
                  {gitNotice && <pre>{gitNotice}</pre>}
                  {launchNotice && <pre>{launchNotice}</pre>}
                  {deployNotice && <pre>{deployNotice}</pre>}
                  {nginxNotice && <pre>{nginxNotice}</pre>}
                  {sslNotice && <pre>{sslNotice}</pre>}
                </div>
              )}
            </form>
            {activeChat ? (
              <>
                {chatNotice && <div className={chatNoticeOk ? "notice success" : "notice danger"}>{chatNotice}</div>}
                <section className="workspace">
                  <section className="job-detail">
                    <section className="chat-thread" ref={chatThreadRef}>
                      {chatIsLoading ? (
                        <div className="chat-loading">
                          <span className="chat-loading-orbit" aria-hidden="true">
                            <RefreshCw className="spin" size={22} />
                          </span>
                          <strong>Загружаю чат</strong>
                          <small>{chatLoadingLabel}</small>
                          <div className={`chat-loading-progress ${chatLoadingDeterminate ? "" : "indeterminate"}`} aria-label="Прогресс загрузки чата">
                            <span style={chatLoadingDeterminate ? { width: `${chatLoadingPercent}%` } : undefined} />
                          </div>
                          <small>
                            {chatLoadingProgress?.loadedBytes
                              ? chatLoadingProgress.totalBytes
                                ? `${formatBytes(chatLoadingProgress.loadedBytes)} из ${formatBytes(chatLoadingProgress.totalBytes)} · ${chatLoadingPercent}%`
                                : `Получено ${formatBytes(chatLoadingProgress.loadedBytes)}`
                              : "Ожидаю ответ сервера"}
                          </small>
                        </div>
                      ) : (
                        <>
                          {timelineItems.length ? timelineItems.map((item, index) => {
                            const { message, collapsedRun } = item;
                            const jobId = messageJobId(message);
                            const messageJob = jobs.find((job) => job.id === jobId);
                            const messageProgress = messageJob ? progressByJob[messageJob.id] ?? messageJob.progress ?? null : null;
                            const isNew = highlightedMessageIds.has(message.id);
                            const isFirst = index === 0;
                            const isLast = index === timelineItems.length - 1;
                            const isProjectOperation = isProjectOperationMessage(message);
                            const author = isProjectOperation
                              ? projectOperationLabel(message)
                              : message.role === "user"
                                ? currentUser?.nickname || currentUser?.email || "You"
                                : message.source === "vscode"
                                  ? "VS Code"
                                  : "Codex";
                            const assistantDetails = message.role === "assistant" || message.role === "tool" || message.role === "system"
                              ? messageRunDetails(message, messageJob, collapsedRun)
                              : undefined;
                            return (
                              <article
                                className={`message ${message.role}${isProjectOperation ? " service-message" : ""}${isNew ? " new-message" : ""}`}
                                key={message.id}
                                ref={isFirst || isLast ? (node) => {
                                  if (isFirst) firstMessageRef.current = node;
                                  if (isLast) lastMessageRef.current = node;
                                } : undefined}
                              >
                                <div className="message-meta">
                                  {message.role === "system" ? (
                                    <>
                                      <span>{author}</span>
                                      <small>{formatDateTime(message.createdAt)}</small>
                                    </>
                                  ) : assistantDetails ? (
                                    <div className="message-author-stack">
                                      <span>
                                        {author}
                                        {assistantDetails.settings.length > 0 && <small className="message-run-settings">{assistantDetails.settings.join(" · ")}</small>}
                                      </span>
                                      {assistantDetails.timing.length > 0 && <small>{assistantDetails.timing.join(" · ")}</small>}
                                    </div>
                                  ) : message.role === "user" ? (
                                    <div className="message-author-stack">
                                      <span>{author}</span>
                                      <small>{formatDateTime(message.createdAt)}</small>
                                    </div>
                                  ) : (
                                    <>
                                      <span>{author}</span>
                                      <small>
                                        {formatDateTime(message.createdAt)}
                                        {collapsedRun && <> · Работал {formatDuration(collapsedRun.durationSeconds)}</>}
                                      </small>
                                    </>
                                  )}
                                </div>
                                {collapsedRun && renderCollapsedRunTrace(message, collapsedRun)}
                                {message.role === "system" ? (
                                  isProjectOperation
                                    ? renderRichText(message.content, "rich-text message-body service-log-body")
                                    : (
                                      <div className="system-message-body" title={normalizeDisplayText(message.content).trim()}>
                                        {normalizeDisplayText(message.content).trim()}
                                      </div>
                                    )
                                ) : renderRichText(message.content, "rich-text message-body")}
                                {renderMessageAttachments(message.attachments, setImagePreview)}
                                {renderCodexActions(message, messageJob)}
                                {renderCodexChangeCard(message, messageJob, messageProgress)}
                              </article>
                            );
                          }) : (
                            <div className="empty">Начни этот чат или дождись синхронизации истории из локального Codex/VS Code.</div>
                          )}
                          {renderChatThinkingIndicator()}
                          {renderActiveRun()}
                        </>
                      )}
                    </section>
                    {renderComposer()}
                  </section>
                </section>
              </>
            ) : (
              <>
                <div className="empty">Нет выбранного чата. Первое сообщение создаст чат, следующие продолжат его.</div>
                {renderComposer()}
              </>
            )}
          </section>
        </section>
      )}
      </section>

      <aside className="agent-console">
        <section className="agent-card">
          <div className="section-head">
            <h2><Bot size={18} /> Home Windows Agent</h2>
            <span className={`status ${online ? "ok" : "bad"}`}>{online ? "Online" : "Offline"}</span>
          </div>
          <div className="metric-grid">
            <div><span>Queue</span><strong>{jobs.filter((job) => ["queued", "assigned", "running"].includes(job.status)).length}</strong></div>
            <div><span>Mode</span><strong>{SANDBOX_LABELS[sandbox]}</strong></div>
            <div><span>Branch</span><strong>{selectedRepo?.currentBranch ?? "n/a"}</strong></div>
          </div>
          <div className="agent-rules">
            <span>Filesystem Access <strong>{sandbox === "danger-full-access" ? "Full" : "Scoped"}</strong></span>
            <span>Network Access <strong>{sandbox === "danger-full-access" ? "Enabled" : "Restricted"}</strong></span>
            <span>Auto Deploy <strong>{hasDeployConfig(selectedRepo) ? "Ready" : "Not set"}</strong></span>
          </div>
          <div className={`local-activity ${localCodexBusy ? "busy" : "idle"}`}>
            <div>
              <span>Local Codex</span>
              <strong>{localCodexBusy ? "Busy" : "Idle"}</strong>
            </div>
            <p>{localActivity?.summary ?? "Waiting for local activity heartbeat."}</p>
            {localActivity?.chatTitle && <small>{localActivity.chatTitle}</small>}
            {localActivity?.updatedAt && <small>Updated {new Date(localActivity.updatedAt).toLocaleTimeString()}</small>}
          </div>
          <div className="codex-limit">
            <div>
              <span>Codex Account</span>
              <strong>{selectedAgent?.codexUsage?.status === "signed-in" ? "Signed in" : selectedAgent?.codexUsage?.status === "signed-out" ? "Signed out" : "Unknown"}</strong>
            </div>
            <p>{selectedAgent?.codexUsage?.summary ?? "Waiting for agent limit probe."}</p>
            {typeof selectedAgent?.codexUsage?.usedPercent === "number" && (
              <div className="limit-bar" aria-label="Codex usage">
                <span style={{ width: `${selectedAgent.codexUsage.usedPercent}%` }} />
              </div>
            )}
            <small>
              {selectedAgent?.codexUsage?.remaining !== undefined && selectedAgent?.codexUsage?.limit !== undefined
                ? `${selectedAgent.codexUsage.remaining} of ${selectedAgent.codexUsage.limit} left`
                : "Exact remaining limit is not exposed by Codex CLI."}
            </small>
            {selectedAgent?.codexUsage?.checkedAt && <small>Checked {formatDateTime(selectedAgent.codexUsage.checkedAt)}</small>}
          </div>
        </section>

        <section className="agent-card">
          <div className="section-head">
            <h2><Activity size={18} /> Recent Runs</h2>
          </div>
          <div className="compact-runs">
            {jobs.slice(0, 6).map((job) => (
              <button className="compact-run" key={job.id} onClick={() => openJob(job)}>
                <span>{job.prompt.slice(0, 56)}</span>
                <small className={job.status}>{job.status}</small>
              </button>
            ))}
            {!jobs.length && <div className="empty small-empty">No runs in selected chat.</div>}
          </div>
        </section>
      </aside>
      {imagePreview && (
        <div className="image-lightbox" role="dialog" aria-modal="true" aria-label={imagePreview.name} onClick={() => setImagePreview(null)}>
          <figure onClick={(event) => event.stopPropagation()}>
            <button aria-label="Close image preview" type="button" onClick={() => setImagePreview(null)}>
              <X size={20} />
            </button>
            <img alt={imagePreview.name} src={imagePreview.src} />
            <figcaption>
              <strong>{imagePreview.name}</strong>
              <span>{imagePreview.mimeType} · {formatBytes(imagePreview.size)}</span>
            </figcaption>
          </figure>
        </div>
      )}
    </main>
    {activeChat && (showChatScrollTop || showChatScrollBottom) && (
      <div className="chat-scroll-controls" aria-label="Прокрутка чата">
        {showChatScrollTop && (
          <button className="scroll-up" type="button" onClick={() => scrollChatToTop("smooth")} title="К началу чата">
            <ArrowUp size={18} />
          </button>
        )}
        {showChatScrollBottom && (
          <button className={`scroll-down ${showJumpToLatest ? "has-new" : ""}`} type="button" onClick={() => scrollChatToLatest("smooth")} title="К последним сообщениям">
            <ArrowDown size={18} />
          </button>
        )}
      </div>
    )}
    </>
  );
}

const sharedToken = shareTokenFromLocation();
const publicProfileSlug = publicProfileSlugFromLocation();
createRoot(document.getElementById("root")!).render(
  sharedToken
    ? <SharedChatPage token={sharedToken} />
    : publicProfileSlug
      ? <PublicProfilePage slug={publicProfileSlug} />
      : <App />
);
