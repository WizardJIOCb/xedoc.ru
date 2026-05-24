import net from "node:net";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import * as vscode from "vscode";

type BridgeCommand = "ping" | "openSidebar" | "newChat" | "newCodexPanel" | "addToThread" | "addFileToThread" | "openThread" | "reopenThread" | "refreshThreadIfOpen";

type BridgeRequest = {
  command?: unknown;
  text?: unknown;
  filePath?: unknown;
  threadId?: unknown;
};

type BridgeResponse = {
  ok: boolean;
  output?: string;
  error?: string;
};

const ALLOWED_COMMANDS = new Set<BridgeCommand>([
  "ping",
  "openSidebar",
  "newChat",
  "newCodexPanel",
  "addToThread",
  "addFileToThread",
  "openThread",
  "reopenThread",
  "refreshThreadIfOpen"
]);

let server: net.Server | undefined;
let chatsProvider: CodexRodionChatsProvider | undefined;

type CodexThread = {
  id: string;
  title: string;
  updatedAt: string;
};

type ExportedChatMessage = {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  source: "codex";
  externalId: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
};

type AgentConfig = {
  serverUrl?: string;
  tokenEnv?: string;
};

const CODEX_CONTEXT_TAGS = [
  "environment_context",
  "permissions instructions",
  "collaboration_mode",
  "apps_instructions",
  "skills_instructions",
  "plugins_instructions"
];

function pipePath(): string {
  const configured = process.env.CMC_VSCODE_BRIDGE_PIPE?.trim();
  if (configured) return configured;
  if (process.platform === "win32") return "\\\\.\\pipe\\codex-rodion-vscode-bridge";
  return `${os.tmpdir()}/codex-rodion-vscode-bridge.sock`;
}

function validateRequest(value: unknown): { ok: true; request: Required<Pick<BridgeRequest, "command">> & BridgeRequest } | { ok: false; error: string } {
  if (!value || typeof value !== "object") return { ok: false, error: "invalid_request" };
  const request = value as BridgeRequest;
  if (typeof request.command !== "string" || !ALLOWED_COMMANDS.has(request.command as BridgeCommand)) {
    return { ok: false, error: "unsupported_command" };
  }
  if (request.text !== undefined && typeof request.text !== "string") return { ok: false, error: "invalid_text" };
  if (request.filePath !== undefined && typeof request.filePath !== "string") return { ok: false, error: "invalid_file_path" };
  if (request.threadId !== undefined && typeof request.threadId !== "string") return { ok: false, error: "invalid_thread_id" };
  if (typeof request.text === "string" && request.text.length > 16000) return { ok: false, error: "text_too_large" };
  if (typeof request.filePath === "string" && request.filePath.length > 500) return { ok: false, error: "file_path_too_large" };
  if (typeof request.threadId === "string" && (request.threadId.length < 1 || request.threadId.length > 300)) return { ok: false, error: "thread_id_too_large" };
  return { ok: true, request: request as Required<Pick<BridgeRequest, "command">> & BridgeRequest };
}

function codexThreadUri(threadId: string): vscode.Uri {
  return vscode.Uri.file(`/local/${threadId}`).with({ scheme: "openai-codex", authority: "route" });
}

function isCodexThreadTab(tab: vscode.Tab, threadId: string): boolean {
  const input = tab.input;
  if (!(input instanceof vscode.TabInputCustom)) return false;
  return input.viewType === "chatgpt.conversationEditor"
    && input.uri.scheme === "openai-codex"
    && (input.uri.authority === "route" || input.uri.authority === "extension")
    && input.uri.path === `/local/${threadId}`;
}

function codexThreadTabs(threadId: string): vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => isCodexThreadTab(tab, threadId));
}

async function closeCodexThreadTabs(threadId: string): Promise<number> {
  const tabs = codexThreadTabs(threadId);
  if (!tabs.length) return 0;
  await vscode.window.tabGroups.close(tabs, true);
  return tabs.length;
}

async function refreshCodexThreadIfOpen(threadId: string): Promise<number> {
  const tabs = codexThreadTabs(threadId);
  if (!tabs.length) return 0;
  await vscode.window.tabGroups.close(tabs, true);
  await openCodexThread(threadId);
  return tabs.length;
}

async function openCodexThread(threadId: string): Promise<void> {
  await vscode.commands.executeCommand("vscode.openWith", codexThreadUri(threadId), "chatgpt.conversationEditor", {
    preserveFocus: false,
    preview: false,
    viewColumn: vscode.ViewColumn.Active
  });
}

function codexHome(): string {
  return join(os.homedir(), ".codex");
}

function threadIdFromRolloutPath(path: string): string | undefined {
  return basename(path).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)?.[1];
}

function readSessionTitles(): Map<string, string> {
  const titles = new Map<string, string>();
  const path = join(codexHome(), "session_index.jsonl");
  if (!existsSync(path)) return titles;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { id?: unknown; thread_name?: unknown };
      if (typeof row.id === "string" && typeof row.thread_name === "string" && row.thread_name.trim()) {
        titles.set(row.id, row.thread_name.trim());
      }
    } catch {
      // Ignore corrupt local index rows.
    }
  }
  return titles;
}

function collectRolloutFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) stack.push(path);
      else if (/^rollout-.+\.jsonl$/i.test(entry) && threadIdFromRolloutPath(path)) files.push(path);
    }
  }
  return files;
}

function textFromContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    for (const key of ["text", "input_text", "output_text"]) {
      if (typeof row[key] === "string") return [row[key] as string];
    }
    return [];
  }).join("\n").trim();
}

function isCodexContextMessage(content: string): boolean {
  return !stripLeadingCodexContextBlocks(content);
}

function stripLeadingCodexContextBlocks(content: string): string {
  let value = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!value) return "";

  for (;;) {
    const before = value;
    value = value
      .replace(/^\s*#?\s*AGENTS\.md instructions for[^\n]*\n+\s*<INSTRUCTIONS>\s*[\s\S]*?<\/INSTRUCTIONS>\s*/i, "")
      .replace(/^\s*<INSTRUCTIONS>\s*[\s\S]*?<\/INSTRUCTIONS>\s*/i, "")
      .trimStart();

    for (const tag of CODEX_CONTEXT_TAGS) {
      const escaped = escapeRegex(tag);
      value = value.replace(new RegExp(`^\\s*<${escaped}>\\s*[\\s\\S]*?<\\/${escaped}>\\s*`, "i"), "").trimStart();
    }

    if (value === before) break;
  }

  if (/^\s*#?\s*AGENTS\.md instructions for\b/i.test(value) && /<INSTRUCTIONS>/i.test(value)) return "";
  if (/^\s*AGENTS\.md\s+Project rules\b/i.test(value)) return "";
  return value.trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function titleFromContent(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let content = stripLeadingCodexContextBlocks(value)
    .replace(/<image>[\s\S]*?<\/image>/gi, "")
    .replace(/<image\s*\/>/gi, "")
    .trim();
  const requestMatch = content.match(/My request for Codex:\s*([\s\S]+)/i);
  if (requestMatch?.[1]) content = requestMatch[1];
  content = content.replace(/\s+/g, " ").trim();
  if (!content || isCodexContextMessage(content) || /^# Context from my IDE setup:/i.test(content)) return undefined;
  return content.slice(0, 120);
}

function readRolloutSummary(path: string): { title?: string; updatedAt?: string } {
  let title: string | undefined;
  let updatedAt: string | undefined;
  try {
    const text = readFileSync(path, "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let row: any;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof row.timestamp === "string") updatedAt = row.timestamp;
      if (!title && row.type === "response_item" && row.payload?.type === "message" && row.payload?.role === "user") {
        const content = stripLeadingCodexContextBlocks(textFromContent(row.payload.content)).replace(/\s+/g, " ").trim();
        title = titleFromContent(content);
      }
    }
  } catch {
    return {};
  }
  return { title, updatedAt };
}

function readLocalCodexThreads(): CodexThread[] {
  const titles = readSessionTitles();
  return collectRolloutFiles(join(codexHome(), "sessions"))
    .map((rolloutPath) => {
      const id = threadIdFromRolloutPath(rolloutPath)!;
      const rollout = readRolloutSummary(rolloutPath);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(rolloutPath).mtimeMs;
      } catch {
        // Keep the item with an old timestamp if the file disappears mid-refresh.
      }
      return {
        id,
        title: titleFromContent(titles.get(id)) || rollout.title || "Codex chat",
        updatedAt: rollout.updatedAt || new Date(mtimeMs || 0).toISOString()
      };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 80);
}

function rolloutPathForThread(threadId: string): string | undefined {
  return collectRolloutFiles(join(codexHome(), "sessions")).find((path) => threadIdFromRolloutPath(path) === threadId);
}

function readCodexThreadMessages(path: string): ExportedChatMessage[] {
  const messages: ExportedChatMessage[] = [];
  const text = readFileSync(path, "utf8");
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let row: any;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.type !== "response_item" || row.payload?.type !== "message") continue;
    const role = row.payload.role;
    if (role !== "user" && role !== "assistant" && role !== "system" && role !== "tool") continue;
    const content = stripLeadingCodexContextBlocks(textFromContent(row.payload.content)).trim();
    if (!content || isCodexContextMessage(content)) continue;
    messages.push({
      role,
      content: content.slice(0, 200000),
      source: "codex",
      externalId: `${basename(path)}:${index}`,
      createdAt: typeof row.timestamp === "string" ? row.timestamp : new Date().toISOString()
    });
  }
  return messages;
}

function readAgentConfig(): AgentConfig {
  const candidates = [
    process.env.CMC_AGENT_CONFIG,
    ...(vscode.workspace.workspaceFolders?.map((folder) => join(folder.uri.fsPath, "apps", "agent-windows", "agent.config.json")) ?? []),
    join(os.homedir(), "codex-agent", "apps", "agent-windows", "agent.config.json")
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      return JSON.parse(readFileSync(candidate, "utf8")) as AgentConfig;
    } catch {
      // Try the next known config path.
    }
  }
  return {};
}

function serverOriginFromConfig(config: AgentConfig): string {
  const explicit = process.env.CMC_PUBLIC_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const serverUrl = config.serverUrl?.trim();
  if (!serverUrl) return "https://codex.rodion.pro";
  return serverUrl
    .replace(/^wss:/i, "https:")
    .replace(/^ws:/i, "http:")
    .replace(/\/api\/agent\/ws\/?$/i, "")
    .replace(/\/+$/, "");
}

function postJson(url: string, token: string, body: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const data = Buffer.from(JSON.stringify(body), "utf8");
    const transport = target.protocol === "http:" ? http : https;
    const request = transport.request({
      method: "POST",
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "Content-Length": String(data.byteLength)
      },
      timeout: 15000
    }, (response) => {
      let responseText = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        responseText += chunk;
        if (responseText.length > 2_000_000) request.destroy(new Error("response_too_large"));
      });
      response.on("end", () => {
        let parsed: any = {};
        try {
          parsed = responseText ? JSON.parse(responseText) : {};
        } catch {
          reject(new Error("invalid_server_response"));
          return;
        }
        if ((response.statusCode ?? 500) >= 400) {
          reject(new Error(String(parsed.error ?? `server_${response.statusCode}`)));
          return;
        }
        resolve(parsed);
      });
    });
    request.on("timeout", () => request.destroy(new Error("share_timeout")));
    request.on("error", reject);
    request.end(data);
  });
}

async function shareCodexThread(threadId: string): Promise<string> {
  const rolloutPath = rolloutPathForThread(threadId);
  if (!rolloutPath) throw new Error("codex_thread_not_found");
  const messages = readCodexThreadMessages(rolloutPath);
  if (!messages.length) throw new Error("codex_thread_has_no_messages");
  const title = titleFromContent(readSessionTitles().get(threadId)) || titleFromContent(messages.find((message) => message.role === "user")?.content) || "Codex chat";
  const updatedAt = messages.at(-1)?.createdAt ?? readRolloutSummary(rolloutPath).updatedAt ?? new Date().toISOString();
  const config = readAgentConfig();
  const tokenEnv = config.tokenEnv || "CMC_AGENT_TOKEN";
  const token = process.env[tokenEnv]?.trim() || process.env.CMC_AGENT_TOKEN?.trim();
  if (!token) throw new Error(`${tokenEnv}_missing`);
  const origin = serverOriginFromConfig(config);
  const result = await postJson(`${origin}/api/agent/shared-chats`, token, {
    repoId: "vscode-export",
    source: "codex",
    externalId: threadId,
    title,
    updatedAt,
    messages
  });
  const url = typeof result.url === "string" ? result.url : typeof result.share?.url === "string" ? result.share.url : "";
  if (!url) throw new Error("share_url_missing");
  await vscode.env.clipboard.writeText(url);
  return url;
}

function webviewHtml(): string {
  const nonce = randomBytes(16).toString("base64");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { margin: 0; padding: 10px; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font: var(--vscode-font-size) var(--vscode-font-family); }
    .toolbar { display: flex; gap: 6px; align-items: center; margin-bottom: 10px; }
    button { border: 1px solid var(--vscode-button-border, transparent); color: var(--vscode-button-foreground); background: var(--vscode-button-background); padding: 4px 8px; border-radius: 3px; cursor: pointer; }
    button.secondary { color: var(--vscode-foreground); background: var(--vscode-button-secondaryBackground); }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .status { color: var(--vscode-descriptionForeground); font-size: 11px; margin-left: auto; }
    .list { display: flex; flex-direction: column; gap: 6px; }
    .item { border: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border)); background: var(--vscode-editor-background); border-radius: 4px; padding: 8px; }
    .title { font-weight: 600; line-height: 1.35; margin-bottom: 4px; word-break: break-word; }
    .meta { color: var(--vscode-descriptionForeground); font-size: 11px; margin-bottom: 8px; }
    .actions { display: flex; gap: 6px; }
    .empty { color: var(--vscode-descriptionForeground); padding: 16px 4px; }
  </style>
</head>
<body>
  <div class="toolbar">
    <button id="refresh">Обновить</button>
    <button class="secondary" id="codex">Codex</button>
    <span class="status" id="status">Loading...</span>
  </div>
  <div class="list" id="list"></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const list = document.getElementById('list');
    const status = document.getElementById('status');
    function formatDateTime(value) {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return '';
      return date.toLocaleString('ru-RU', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      });
    }
    document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
    document.getElementById('codex').addEventListener('click', () => vscode.postMessage({ type: 'openSidebar' }));
    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type !== 'threads') return;
      const threads = Array.isArray(message.threads) ? message.threads : [];
      status.textContent = String(threads.length) + ' chats';
      list.innerHTML = threads.length ? '' : '<div class="empty">No local Codex chats found.</div>';
      for (const thread of threads) {
        if (!thread || typeof thread.id !== 'string') continue;
        const item = document.createElement('article');
        item.className = 'item';
        item.innerHTML = '<div class="title"></div><div class="meta"></div><div class="actions"><button data-action="open">Открыть</button><button class="secondary" data-action="reopen">Переоткрыть</button><button class="secondary" data-action="export">Ссылка</button></div>';
        item.querySelector('.title').textContent = String(thread.title || 'Codex chat');
        item.querySelector('.meta').textContent = formatDateTime(thread.updatedAt);
        item.querySelector('[data-action="open"]').addEventListener('click', () => vscode.postMessage({ type: 'openThread', threadId: thread.id }));
        item.querySelector('[data-action="reopen"]').addEventListener('click', () => vscode.postMessage({ type: 'reopenThread', threadId: thread.id }));
        item.querySelector('[data-action="export"]').addEventListener('click', () => vscode.postMessage({ type: 'exportThread', threadId: thread.id }));
        list.appendChild(item);
      }
    });
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}

class CodexRodionChatsProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = webviewHtml();
    view.webview.onDidReceiveMessage((message) => {
      void this.handleMessage(message);
    });
    void this.refresh();
  }

  async refresh(): Promise<void> {
    await this.view?.webview.postMessage({ type: "threads", threads: readLocalCodexThreads() });
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== "object") return;
    const request = message as { type?: unknown; threadId?: unknown };
    if (request.type === "ready" || request.type === "refresh") {
      await this.refresh();
      return;
    }
    if (request.type === "openSidebar") {
      await vscode.commands.executeCommand("chatgpt.openSidebar");
      return;
    }
    if ((request.type === "openThread" || request.type === "reopenThread") && typeof request.threadId === "string") {
      if (request.type === "reopenThread") await closeCodexThreadTabs(request.threadId);
      await openCodexThread(request.threadId);
      return;
    }
    if (request.type === "exportThread" && typeof request.threadId === "string") {
      try {
        const url = await shareCodexThread(request.threadId);
        const open = await vscode.window.showInformationMessage(`Ссылка на чат скопирована: ${url}`, "Открыть");
        if (open === "Открыть") await vscode.env.openExternal(vscode.Uri.parse(url));
      } catch (error) {
        await vscode.window.showWarningMessage(`Не получилось экспортировать чат: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

async function executeBridgeCommand(request: Required<Pick<BridgeRequest, "command">> & BridgeRequest): Promise<BridgeResponse> {
  switch (request.command) {
    case "ping":
      return { ok: true, output: "pong" };
    case "openSidebar":
      await vscode.commands.executeCommand("chatgpt.openSidebar");
      return { ok: true, output: "Codex sidebar opened." };
    case "newChat":
      await vscode.commands.executeCommand("chatgpt.newChat");
      return { ok: true, output: "New Codex chat requested." };
    case "newCodexPanel":
      await vscode.commands.executeCommand("chatgpt.newCodexPanel");
      return { ok: true, output: "New Codex panel requested." };
    case "addToThread":
      await vscode.commands.executeCommand("chatgpt.addToThread");
      return { ok: true, output: "Add to current Codex thread requested." };
    case "addFileToThread": {
      if (typeof request.filePath !== "string" || !request.filePath) return { ok: false, error: "file_path_required" };
      await vscode.commands.executeCommand("chatgpt.addFileToThread", vscode.Uri.file(request.filePath));
      return { ok: true, output: "File add to Codex thread requested." };
    }
    case "openThread": {
      if (typeof request.threadId !== "string" || !request.threadId.trim()) return { ok: false, error: "thread_id_required" };
      await openCodexThread(request.threadId.trim());
      return { ok: true, output: "Codex thread opened in VS Code." };
    }
    case "reopenThread": {
      if (typeof request.threadId !== "string" || !request.threadId.trim()) return { ok: false, error: "thread_id_required" };
      const threadId = request.threadId.trim();
      const closed = await closeCodexThreadTabs(threadId);
      await openCodexThread(threadId);
      return { ok: true, output: closed ? "Codex thread reopened in VS Code." : "Codex thread opened in VS Code." };
    }
    case "refreshThreadIfOpen": {
      if (typeof request.threadId !== "string" || !request.threadId.trim()) return { ok: false, error: "thread_id_required" };
      const refreshed = await refreshCodexThreadIfOpen(request.threadId.trim());
      return { ok: true, output: refreshed ? "Codex thread refreshed in VS Code." : "Codex thread is not open in VS Code." };
    }
    default:
      return { ok: false, error: "unsupported_command" };
  }
}

function writeResponse(socket: net.Socket, response: BridgeResponse): void {
  socket.write(JSON.stringify(response) + "\n", () => socket.end());
}

async function handleLine(socket: net.Socket, line: string): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    writeResponse(socket, { ok: false, error: "invalid_json" });
    return;
  }
  const validated = validateRequest(parsed);
  if (!validated.ok) {
    writeResponse(socket, { ok: false, error: validated.error });
    return;
  }
  try {
    writeResponse(socket, await executeBridgeCommand(validated.request));
  } catch (error) {
    writeResponse(socket, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

async function startServer(): Promise<void> {
  await stopServer();
  const path = pipePath();
  if (process.platform !== "win32" && existsSync(path)) unlinkSync(path);
  server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      socket.removeAllListeners("data");
      handleLine(socket, line).catch((error) => {
        writeResponse(socket, { ok: false, error: error instanceof Error ? error.message : String(error) });
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server?.once("error", reject);
    server?.listen(path, () => {
      server?.off("error", reject);
      resolve();
    });
  });
}

async function stopServer(): Promise<void> {
  const current = server;
  server = undefined;
  if (!current) return;
  await new Promise<void>((resolve) => current.close(() => resolve()));
}

export function activate(context: vscode.ExtensionContext): void {
  chatsProvider = new CodexRodionChatsProvider();
  context.subscriptions.push(vscode.window.registerWebviewViewProvider("codexRodionChats", chatsProvider));
  context.subscriptions.push(vscode.commands.registerCommand("codexRodionBridge.refreshChats", () => chatsProvider?.refresh()));
  startServer()
    .then(() => vscode.window.showInformationMessage("codex.rodion.pro VS Code bridge is ready."))
    .catch((error) => vscode.window.showWarningMessage(`codex.rodion.pro bridge failed: ${error instanceof Error ? error.message : String(error)}`));
  context.subscriptions.push(vscode.commands.registerCommand("codexRodionBridge.restart", () => {
    startServer()
      .then(() => vscode.window.showInformationMessage("codex.rodion.pro VS Code bridge restarted."))
      .catch((error) => vscode.window.showWarningMessage(`codex.rodion.pro bridge failed: ${error instanceof Error ? error.message : String(error)}`));
  }));
  context.subscriptions.push({ dispose: () => { void stopServer(); } });
}

export function deactivate(): PromiseLike<void> {
  return stopServer();
}
