import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentJobDone, AgentJobLog, AgentJobProgress } from "./types.js";
import type { AgentConfig, RepoConfig } from "./config.js";
import { minimalEnv, needsShell, runCapture } from "./process-utils.js";

type RunContext = {
  config: AgentConfig;
  job: {
    id: string;
    repoId: string;
    codexThreadId?: string;
    prompt: string;
    sandbox: "read-only" | "workspace-write" | "danger-full-access";
    branchMode: "current" | "create-per-job";
    kind: "codex" | "grok" | "gemini-cli" | "gemini" | "test";
    testCommandId?: string;
    model?: string;
    reasoningEffort?: "low" | "medium" | "high" | "xhigh";
    speed?: "standard" | "fast";
    attachments?: Array<{
      name: string;
      mimeType: string;
      size: number;
      dataBase64: string;
    }>;
  };
  sendLog: (log: AgentJobLog) => void;
  sendProgress: (progress: AgentJobProgress) => void;
};

type JsonLineHandlerResult = { handled: boolean; threadId?: string; messageText?: string };
type JsonLineHandler = (context: RunContext, line: string) => JsonLineHandlerResult;
type SpawnCollectOptions = {
  toolName?: string;
  handleJsonLine?: JsonLineHandler;
};

export class Runner {
  private child: ChildProcessWithoutNullStreams | null = null;
  private cancelled = false;
  private stopCurrent: (() => void) | null = null;

  cancel() {
    this.cancelled = true;
    if (this.stopCurrent) {
      this.stopCurrent();
      return;
    }
    void killProcessTree(this.child);
  }

  async run(context: RunContext): Promise<AgentJobDone> {
    const repo = context.config.repos.find((item) => item.id === context.job.repoId);
    if (!repo) throw new Error(`Repo not allowed: ${context.job.repoId}`);
    if (!repo.allowedSandboxes.includes(context.job.sandbox)) throw new Error(`Sandbox not allowed: ${context.job.sandbox}`);
    if (context.config.fakeRunner || process.env.CMC_FAKE_RUNNER === "1") return this.runFake(context, repo);
    if (context.job.kind === "test") return this.runTest(context, repo);
    if (context.job.kind === "grok") return this.runGrok(context, repo);
    if (context.job.kind === "gemini-cli") return this.runGeminiCli(context, repo);
    if (context.job.kind === "gemini") return this.runGeminiApi(context, repo);
    return this.runCodex(context, repo);
  }

  private async runFake(context: RunContext, repo: RepoConfig): Promise<AgentJobDone> {
    const lines = [
      `Connected to ${repo.name}.`,
      `Sandbox: ${context.job.sandbox}.`,
      "Reading prompt and preparing a safe Codex task.",
      "Streaming fake output for mobile/WebSocket verification.",
      "Done. Switch fakeRunner off to run real codex exec."
    ];
    for (const line of lines) {
      if (this.cancelled) break;
      context.sendProgress(progress(context.job.id, "fake", line, { filesChanged: 0, added: 0, deleted: 0, files: [] }));
      context.sendLog(log(context.job.id, "stdout", line));
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    const gitStatus = await runCapture("git", ["-C", repo.path, "status", "--short"]);
    const gitDiffStat = await runCapture("git", ["-C", repo.path, "diff", "--stat"]);
    const gitDiff = await runCapture("git", ["-C", repo.path, "diff", "--", "."], undefined, 30000);
    return {
      type: "job.done",
      jobId: context.job.id,
      status: this.cancelled ? "cancelled" : "completed",
      exitCode: this.cancelled ? null : 0,
      finalMessage: this.cancelled ? "Job cancelled." : "Fake runner completed successfully.",
      gitStatus: gitStatus.stdout,
      gitDiffStat: gitDiffStat.stdout,
      gitDiff: truncate(gitDiff.stdout, 120000)
    };
  }

  private async runTest(context: RunContext, repo: RepoConfig): Promise<AgentJobDone> {
    const command = repo.testCommands.find((item) => item.id === context.job.testCommandId);
    if (!command) throw new Error(`Test command not allowed: ${context.job.testCommandId}`);
    return this.spawnAndCollect(context, repo, command.command, command.args, command.timeoutMs);
  }

  private async runCodex(context: RunContext, repo: RepoConfig): Promise<AgentJobDone> {
    const result = await this.runCodexOnce(context, repo);
    if (context.job.codexThreadId && shouldRetryCodexWithoutThread(result)) {
      context.sendLog(log(context.job.id, "system", `Codex thread ${context.job.codexThreadId} is not available on this agent; starting a new thread with chat context.`));
      return this.runCodexOnce({
        ...context,
        job: {
          ...context.job,
          codexThreadId: undefined
        }
      }, repo);
    }
    return result;
  }

  private async runCodexOnce(context: RunContext, repo: RepoConfig): Promise<AgentJobDone> {
    const codexCommand = codexExecutable();
    const attachments = prepareAttachments(context, repo);
    const userPrompt = attachments.length
      ? [
        context.job.prompt,
        "",
        "Attached files saved locally for this task:",
        ...attachments.map((attachment) => `- ${attachment.name} (${attachment.mimeType}, ${attachment.size} bytes): ${attachment.path}`),
        "",
        "Use these file paths as the attached user-provided context."
      ].join("\n")
      : context.job.prompt;
    const prompt = context.job.codexThreadId
      ? userPrompt
      : [environmentPrompt(context.config, repo), userPrompt].join("\n\n");
    const modelArgs = context.job.model ? ["-m", context.job.model] : [];
    const reasoningArgs = context.job.reasoningEffort ? ["-c", `model_reasoning_effort="${context.job.reasoningEffort}"`] : [];
    const args = context.job.codexThreadId
      ? [
        ...codexCommand.prefixArgs,
        "exec",
        "resume",
        ...modelArgs,
        "--all",
        "--json",
        "-c",
        `sandbox_mode="${context.job.sandbox}"`,
        "-c",
        "approval_policy=\"never\"",
        ...reasoningArgs,
        context.job.codexThreadId,
        "-"
      ]
      : [
        ...codexCommand.prefixArgs,
        "exec",
        ...modelArgs,
        "-C",
        repo.path,
        "--sandbox",
        context.job.sandbox,
        "--json",
        "-c",
        "approval_policy=\"never\"",
        ...reasoningArgs,
        "-"
      ];
    return this.spawnAndCollect(context, repo, codexCommand.command, args, context.config.maxJobDurationMs, prompt);
  }

  private async runGrok(context: RunContext, repo: RepoConfig): Promise<AgentJobDone> {
    const attachments = prepareAttachments(context, repo);
    const promptPathMapper = grokPathMapper();
    const repoPath = promptPathMapper(repo.path);
    const userPrompt = attachments.length
      ? [
        context.job.prompt,
        "",
        "Attached files saved locally for this task:",
        ...attachments.map((attachment) => `- ${attachment.name} (${attachment.mimeType}, ${attachment.size} bytes): ${promptPathMapper(attachment.path)}`),
        "",
        "Use these file paths as the attached user-provided context."
      ].join("\n")
      : context.job.prompt;
    const prompt = context.job.codexThreadId
      ? userPrompt
      : [grokEnvironmentPrompt(repo, repoPath), userPrompt].join("\n\n");
    const promptFilePath = writePromptFile(repo, context.job.id, prompt);
    const grokArgs = [
      ...(context.job.model ? ["-m", context.job.model] : []),
      ...(context.job.reasoningEffort ? ["--effort", context.job.reasoningEffort] : []),
      "--cwd",
      repoPath,
      "--sandbox",
      grokSandboxProfile(context.job.sandbox),
      "--always-approve",
      "--output-format",
      "streaming-json",
      ...(context.job.codexThreadId ? ["--resume", context.job.codexThreadId] : []),
      "--prompt-file",
      promptPathMapper(promptFilePath)
    ];
    const grokCommand = grokExecutable(grokArgs);
    return this.spawnAndCollect(context, repo, grokCommand.command, grokCommand.args, context.config.maxJobDurationMs, undefined, {
      toolName: "Grok",
      handleJsonLine: createGrokJsonLineHandler()
    });
  }

  private async runGeminiCli(context: RunContext, repo: RepoConfig): Promise<AgentJobDone> {
    const attachments = prepareAttachments(context, repo);
    const userPrompt = attachments.length
      ? [
        context.job.prompt,
        "",
        "Attached files saved locally for this task:",
        ...attachments.map((attachment) => `- ${attachment.name} (${attachment.mimeType}, ${attachment.size} bytes): ${attachment.path}`),
        "",
        "Use these file paths as the attached user-provided context."
      ].join("\n")
      : context.job.prompt;
    const prompt = [
      geminiCliEnvironmentPrompt(repo),
      userPrompt
    ].join("\n\n");
    const geminiCommand = geminiExecutable();
    const approvalMode = await geminiApprovalMode(geminiCommand);
    const args = [
      ...geminiCommand.prefixArgs,
      ...(context.job.model ? ["--model", context.job.model] : []),
      "--output-format",
      "stream-json",
      "--approval-mode",
      context.job.sandbox === "danger-full-access" ? "yolo" : approvalMode,
      "--include-directories",
      repo.path,
      "-p",
      "Read the full stdin content above and complete the user's requested task now. Do not wait for another command."
    ];
    return this.spawnAndCollect(context, repo, geminiCommand.command, args, context.config.maxJobDurationMs, prompt, {
      toolName: "Gemini",
      handleJsonLine: createGeminiCliJsonLineHandler()
    });
  }

  private async runGeminiApi(context: RunContext, repo: RepoConfig): Promise<AgentJobDone> {
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY is not set. Create a Gemini API key in Google AI Studio and add it to the agent environment.");
    const attachments = prepareAttachments(context, repo);
    const userPrompt = attachments.length
      ? [
        context.job.prompt,
        "",
        "Attached files were saved locally for this web task, but Gemini API cannot read local paths directly:",
        ...attachments.map((attachment) => `- ${attachment.name} (${attachment.mimeType}, ${attachment.size} bytes): ${attachment.path}`),
        "",
        "If you need exact attachment contents, ask the user to paste text or use Codex/Grok for local file access."
      ].join("\n")
      : context.job.prompt;
    const prompt = [
      geminiEnvironmentPrompt(repo),
      userPrompt
    ].join("\n\n");
    const model = context.job.model || "gemini-3.1-pro-preview";
    const payloadPath = writeGeminiPayloadFile(repo, context.job.id, prompt, model, context.job.reasoningEffort);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
    const curlConfig = [
      `url = ${curlConfigQuote(url)}`,
      `header = ${curlConfigQuote(`x-goog-api-key: ${apiKey}`)}`,
      `header = ${curlConfigQuote("Content-Type: application/json")}`,
      "request = POST",
      "silent",
      "show-error",
      "location",
      "fail",
      "no-buffer",
      `data-binary = ${curlConfigQuote(`@${payloadPath.replace(/\\/g, "/")}`)}`
    ].join("\n");
    return this.spawnAndCollect(context, repo, curlExecutable(), ["--config", "-"], context.config.maxJobDurationMs, `${curlConfig}\n`, {
      toolName: "Gemini",
      handleJsonLine: createGeminiSseLineHandler()
    });
  }

  private spawnAndCollect(
    context: RunContext,
    repo: RepoConfig,
    command: string,
    args: string[],
    timeoutMs: number,
    stdinInput?: string,
    options: SpawnCollectOptions = {}
  ): Promise<AgentJobDone> {
    return new Promise((resolve) => {
      const toolName = options.toolName ?? "Codex";
      context.sendLog(log(context.job.id, "system", `Starting ${command} ${args.slice(0, 4).join(" ")} ...`));
      context.sendProgress(progress(context.job.id, "starting", `Starting ${command}.`));
      this.child = spawn(command, args, {
        cwd: repo.path,
        shell: needsShell(command),
        windowsHide: true,
        env: minimalEnv()
      });
      this.child.stdin.end(stdinInput);
      let finalMessage = "";
      let rawOutputTail = "";
      let codexThreadId: string | undefined;
      let codexNetworkFailureMessage = "";
      let progressBusy = false;
      let settled = false;
      let forceFinishTimer: NodeJS.Timeout | undefined;
      let progressTimer: NodeJS.Timeout | undefined;
      const cleanup = () => {
        clearTimeout(timer);
        if (forceFinishTimer) clearTimeout(forceFinishTimer);
        if (progressTimer) clearInterval(progressTimer);
        this.stopCurrent = null;
        this.child = null;
      };
      const finish = async (exitCode: number | null, failureMessage?: string) => {
        if (settled) return;
        settled = true;
        cleanup();
        const status = failureMessage
          ? "failed"
          : this.cancelled
            ? "cancelled"
            : exitCode === 0
              ? "completed"
              : "failed";
        const resultMessage = failureMessage
          ?? (codexNetworkFailureMessage || (this.cancelled ? "Job cancelled." : exitCode === 0 ? `${toolName} finished.` : `${toolName} process failed.`));
        context.sendProgress(progress(
          context.job.id,
          "finalizing",
          "Collecting git diff and saving the result.",
          await diffProgress(repo.path)
        ));
        const gitStatus = await runCapture("git", ["-C", repo.path, "status", "--short"]);
        const gitDiffStat = await runCapture("git", ["-C", repo.path, "diff", "--stat"]);
        const gitDiff = await runCapture("git", ["-C", repo.path, "diff", "--", "."], undefined, 30000);
        context.sendProgress(progress(
          context.job.id,
          status,
          resultMessage,
          await diffProgress(repo.path)
        ));
        resolve({
          type: "job.done",
          jobId: context.job.id,
          status,
          exitCode,
          finalMessage: failureMessage
            ?? (codexNetworkFailureMessage || (this.cancelled ? "Job cancelled." : finalMessage || rawOutputTail.trim() || (exitCode === 0 ? "Completed." : "Process failed."))),
          gitStatus: gitStatus.stdout,
          gitDiffStat: gitDiffStat.stdout,
          gitDiff: truncate(gitDiff.stdout, 120000),
          codexThreadId
        });
      };
      const requestStop = () => {
        if (settled) return;
        this.cancelled = true;
        void killProcessTree(this.child);
        forceFinishTimer ??= setTimeout(() => {
          void finish(null);
        }, 1500);
      };
      this.stopCurrent = requestStop;
      const timer = setTimeout(requestStop, timeoutMs);
      progressTimer = setInterval(async () => {
        if (progressBusy) return;
        progressBusy = true;
        try {
          const stats = await diffProgress(repo.path);
          if (hasDiffChanges(stats)) {
            context.sendProgress(progress(context.job.id, "working", "Checking current git diff.", stats));
          }
        } finally {
          progressBusy = false;
        }
      }, 4000);
      const streamBuffers: Record<"stdout" | "stderr", string> = { stdout: "", stderr: "" };
      const emitLine = (stream: "stdout" | "stderr", line: string) => {
        if (!line) return;
        if (stream === "stdout") {
          const handled = options.handleJsonLine
            ? options.handleJsonLine(context, line)
            : handleCodexJsonLine(context, line);
          if (handled.handled) {
            if (handled.threadId) codexThreadId = handled.threadId;
            if (handled.messageText) finalMessage = handled.messageText.slice(-4000);
            return;
          }
        }
        if (stream === "stderr" && (toolName === "Grok" ? isIgnorableGrokWarning(line) : isIgnorableCodexWarning(line))) return;
        const normalizedFailure = toolName === "Codex" ? normalizeCodexNetworkFailure(line, codexNetworkFailureMessage) : null;
        if (normalizedFailure) {
          rawOutputTail = normalizedFailure;
          if (!codexNetworkFailureMessage) {
            codexNetworkFailureMessage = normalizedFailure;
            context.sendLog(log(context.job.id, "stderr", normalizedFailure));
            context.sendProgress(progress(context.job.id, "message", normalizedFailure));
          }
          return;
        }
        rawOutputTail = `${rawOutputTail}\n${line}`.slice(-4000);
        context.sendLog(log(context.job.id, stream, line));
        if (stream === "stderr") context.sendProgress(progress(context.job.id, "message", line.slice(0, 500)));
      };
      const flushStream = (stream: "stdout" | "stderr") => {
        const line = streamBuffers[stream].trim();
        streamBuffers[stream] = "";
        if (line) emitLine(stream, line);
      };
      const emit = (stream: "stdout" | "stderr", chunk: Buffer) => {
        streamBuffers[stream] += chunk.toString();
        const lines = streamBuffers[stream].split(/\r?\n/);
        streamBuffers[stream] = lines.pop() ?? "";
        for (const line of lines) emitLine(stream, line);
      };
      this.child.stdout.on("data", (chunk: Buffer) => emit("stdout", chunk));
      this.child.stderr.on("data", (chunk: Buffer) => emit("stderr", chunk));
      this.child.on("error", (error) => {
        void finish(127, error.message);
      });
      this.child.on("close", async (exitCode) => {
        flushStream("stdout");
        flushStream("stderr");
        await finish(exitCode);
      });
    });
  }
}

async function killProcessTree(child: ChildProcessWithoutNullStreams | null): Promise<void> {
  if (!child) return;
  const pid = child.pid;
  try {
    child.kill();
  } catch {
    // Best-effort cleanup; cancellation still settles the job through the fallback timer.
  }
  if (process.platform !== "win32" || !pid) return;
  await runCapture("taskkill", ["/PID", String(pid), "/T", "/F"], undefined, 10000);
}

function prepareAttachments(context: RunContext, repo: RepoConfig): Array<{ name: string; mimeType: string; size: number; path: string }> {
  const attachments = context.job.attachments ?? [];
  if (!attachments.length) return [];
  const root = join(repo.path, ".codex-web-attachments", safePathSegment(context.job.id));
  mkdirSync(root, { recursive: true });
  ensureGitExclude(repo.path);
  return attachments.map((attachment, index) => {
    const name = safeFilename(attachment.name, index);
    const path = join(root, name);
    const bytes = Buffer.from(attachment.dataBase64, "base64");
    if (bytes.length !== attachment.size) throw new Error(`Attachment size mismatch: ${attachment.name}`);
    writeFileSync(path, bytes);
    return { name, mimeType: attachment.mimeType, size: attachment.size, path };
  });
}

function ensureGitExclude(repoPath: string): void {
  const excludePath = join(repoPath, ".git", "info", "exclude");
  if (!existsSync(excludePath)) return;
  const current = readFileSync(excludePath, "utf8");
  if (current.includes(".codex-web-attachments/")) return;
  appendFileSync(excludePath, `${current.endsWith("\n") ? "" : "\n"}.codex-web-attachments/\n`, "utf8");
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-z0-9_-]/gi, "_").slice(0, 80) || "job";
}

function safeFilename(value: string, index: number): string {
  const cleaned = value.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").replace(/^\.+/g, "").trim();
  return `${String(index + 1).padStart(2, "0")}-${(cleaned || "attachment").slice(0, 120)}`;
}

function shouldRetryCodexWithoutThread(result: AgentJobDone): boolean {
  if (result.status !== "failed") return false;
  return /thread\/resume|no rollout found/i.test(result.finalMessage ?? "");
}

function codexExecutable(): { command: string; prefixArgs: string[] } {
  if (process.env.CMC_CODEX_NODE && process.env.CMC_CODEX_JS) {
    return { command: process.env.CMC_CODEX_NODE, prefixArgs: [process.env.CMC_CODEX_JS] };
  }
  return { command: process.env.CMC_CODEX_BIN || "codex", prefixArgs: [] };
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

function geminiExecutable(): { command: string; prefixArgs: string[] } {
  if (process.env.CMC_GEMINI_NODE && process.env.CMC_GEMINI_JS) {
    return { command: process.env.CMC_GEMINI_NODE, prefixArgs: [process.env.CMC_GEMINI_JS] };
  }
  if (process.env.CMC_GEMINI_BIN) {
    if (process.platform === "win32" && /\.cmd$/i.test(process.env.CMC_GEMINI_BIN)) {
      const geminiJs = join(dirname(process.env.CMC_GEMINI_BIN), "node_modules", "@google", "gemini-cli", "dist", "index.js");
      if (existsSync(geminiJs)) return { command: process.env.CMC_GEMINI_NODE || "node", prefixArgs: [geminiJs] };
    }
    return { command: process.env.CMC_GEMINI_BIN, prefixArgs: [] };
  }
  return { command: process.platform === "win32" ? "gemini.cmd" : "gemini", prefixArgs: [] };
}

async function geminiApprovalMode(command: { command: string; prefixArgs: string[] }): Promise<string> {
  const result = await runCapture(command.command, [...command.prefixArgs, "--help"], undefined, 15000);
  return /\bautoedit\b/.test(result.stdout) ? "autoedit" : "auto_edit";
}

function curlExecutable(): string {
  return process.platform === "win32" ? "curl.exe" : "curl";
}

function curlConfigQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\r?\n/g, " ")}"`;
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

function grokPathMapper(): (value: string) => string {
  if (process.env.CMC_GROK_BIN || process.platform !== "win32") return (value) => value;
  return windowsPathToWslPath;
}

function grokSandboxProfile(sandbox: "read-only" | "workspace-write" | "danger-full-access"): string {
  if (sandbox === "read-only") return "read-only";
  if (sandbox === "danger-full-access") return "off";
  return "workspace";
}

function windowsPathToWslPath(value: string): string {
  const driveMatch = value.match(/^([A-Za-z]):[\\/](.*)$/);
  if (!driveMatch) return value.replace(/\\/g, "/");
  const [, driveLetter, pathRest] = driveMatch;
  if (!driveLetter || pathRest === undefined) return value.replace(/\\/g, "/");
  const drive = driveLetter.toLowerCase();
  const rest = pathRest.replace(/\\/g, "/");
  return `/mnt/${drive}/${rest}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function writePromptFile(repo: RepoConfig, jobId: string, prompt: string): string {
  const root = join(repo.path, ".codex-web-attachments", safePathSegment(jobId));
  mkdirSync(root, { recursive: true });
  ensureGitExclude(repo.path);
  const path = join(root, "grok-prompt.md");
  writeFileSync(path, prompt, "utf8");
  return path;
}

function writeGeminiPayloadFile(repo: RepoConfig, jobId: string, prompt: string, model: string, reasoningEffort?: "low" | "medium" | "high" | "xhigh"): string {
  const root = join(repo.path, ".codex-web-attachments", safePathSegment(jobId));
  mkdirSync(root, { recursive: true });
  ensureGitExclude(repo.path);
  const path = join(root, "gemini-payload.json");
  const payload: Record<string, unknown> = {
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }]
      }
    ]
  };
  if (model.startsWith("gemini-3")) {
    payload.generationConfig = {
      thinkingConfig: {
        thinkingLevel: geminiThinkingLevel(reasoningEffort)
      }
    };
  }
  writeFileSync(path, JSON.stringify(payload), "utf8");
  return path;
}

function geminiThinkingLevel(reasoningEffort?: "low" | "medium" | "high" | "xhigh"): "low" | "high" {
  return reasoningEffort === "low" || reasoningEffort === "medium" ? "low" : "high";
}

function geminiEnvironmentPrompt(repo: RepoConfig): string {
  return [
    "Gemini API web agent environment:",
    `- Project: ${repo.name} at ${repo.path}.`,
    "- You are answering through xedoc.ru's Gemini API integration.",
    "- You do not have direct local tool access in this runner: you cannot execute shell commands, inspect files, or modify the working tree yourself.",
    "- Help with architecture, debugging, code review, planning, and patch suggestions. If the task requires actual file edits or commands, say that Codex or Grok should run it locally.",
    "- Keep answers practical and concise unless the user asks for depth."
  ].join("\n");
}

function geminiCliEnvironmentPrompt(repo: RepoConfig): string {
  return [
    "Gemini CLI web agent environment:",
    `- Project: ${repo.name} at ${repo.path}.`,
    "- You are running through xedoc.ru's local Windows/Linux agent using Gemini CLI authenticated with the user's Google account.",
    "- You may inspect and edit files in the working directory when the user asks for code work.",
    "- Prefer finite commands and avoid long-lived dev servers unless the user explicitly asks for them.",
    "- Respect the requested sandbox mode in spirit: avoid destructive operations unless the user clearly asks for them.",
    "- Report environment limitations clearly when a required dependency or quota is unavailable."
  ].join("\n");
}

function grokEnvironmentPrompt(repo: RepoConfig, grokRepoPath: string): string {
  return [
    "Grok Build web agent environment:",
    `- Project: ${repo.name}.`,
    `- Windows path: ${repo.path}.`,
    `- Grok working directory: ${grokRepoPath}.`,
    "- You are running through xedoc.ru's Windows agent via Grok Build CLI.",
    "- Prefer finite commands and avoid long-lived dev servers unless the user explicitly asks for them.",
    "- The project is on the Windows filesystem. If a Linux tool is unavailable in WSL, use Windows interop commands such as cmd.exe /c or powershell.exe after one direct attempt.",
    "- Report environment limitations clearly when a required local dependency is not installed."
  ].join("\n");
}

function environmentPrompt(config: AgentConfig, repo: RepoConfig): string {
  const toolbelt = JSON.stringify(join(dirname(fileURLToPath(import.meta.url)), "codex-toolbelt.js"));
  const platform = config.platform ?? (process.platform === "win32" ? "windows" : "linux");
  const common = [
    "Codex web agent environment:",
    `- Project: ${repo.name} at ${repo.path}.`,
    `- You are running through xedoc.ru's ${platform === "windows" ? "Windows" : "Linux server"} agent, not inside an interactive VS Code session.`,
    "- The in-app Browser/node_repl tools are not available inside this codex exec process unless they are explicitly listed in the current toolset.",
    "- Prefer finite commands and avoid long-lived dev servers that only end by timeout.",
    platform === "windows"
      ? "- On Windows, use npm.cmd or the toolbelt npm wrapper; do not invoke npm.ps1 from PowerShell."
      : "- On Linux, use regular shell commands such as npm/corepack/git; avoid Windows-only commands like npm.cmd, PowerShell, WMI, or Start-Process.",
    "- Use the local helper for environment-sensitive tasks:",
    `  - node ${toolbelt} doctor`,
    `  - node ${toolbelt} npm -- run build`,
    `  - node ${toolbelt} build`,
    `  - node ${toolbelt} smoke dist`,
    `  - node ${toolbelt} smoke http://127.0.0.1:<port>/`,
    `  - node ${toolbelt} screenshot http://127.0.0.1:<port>/ dist/smoke.png`
  ];
  if (platform === "windows") {
    common.push("- If native esbuild/headless browser launch is blocked by Windows policy or sandbox permissions, treat it as an environment limitation after one workaround attempt; use `smoke` for HTTP/static verification and report the limitation clearly.");
  }
  return common.join("\n");
}

function isIgnorableCodexWarning(line: string): boolean {
  return /ERROR\s+codex_core::session:\s+failed to record rollout items:\s+thread .* not found/i.test(line);
}

function isIgnorableGrokWarning(line: string): boolean {
  return /BatchSpanProcessor\.ExportError|git_cli: Command::output\(\) FAILED/i.test(line);
}

function normalizeCodexNetworkFailure(line: string, activeFailure: string): string | null {
  const text = line.trim();
  const chatGptBlocked = [
    /wss:\/\/chatgpt\.com\/backend-api\/codex\/responses/i,
    /HTTP error:\s*403 Forbidden/i,
    /Unable to load site/i,
    /If you are using a VPN, try turning it off/i,
    /cdn-cgi\/challenge-platform/i,
    /window\._cf_chl_opt/i,
    /codexapi::endpoint::responses_websocket/i
  ].some((pattern) => pattern.test(text));

  if (chatGptBlocked) {
    return [
      "Codex could not connect to ChatGPT Codex websocket.",
      "chatgpt.com returned HTTP 403, usually because the current VPN/proxy route is blocked by ChatGPT/Cloudflare.",
      "Use another supported-region proxy/VPN route or switch this server agent to OpenAI API-key auth."
    ].join(" ");
  }

  if (!activeFailure) return null;

  const isHtmlContinuation = [
    /^<\/?[a-z][\s>]/i,
    /^\\?["')]?<\/?[a-z][\s>]/i,
    /<\/html>|<\/body>|<\/script>|<\/svg>/i,
    /stroke-linejoin|viewBox|fill-rule|clip-rule/i,
    /Ray ID|Just a moment|challenge-platform|Cloudflare/i,
    /document\.createElement|addEventListener|DOMContentLoaded/i,
    /^["')]?\s*$/
  ].some((pattern) => pattern.test(text));

  return isHtmlContinuation ? activeFailure : null;
}

function log(jobId: string, stream: "stdout" | "stderr" | "system", message: string): AgentJobLog {
  return { type: "job.log", jobId, stream, message, at: new Date().toISOString() };
}

function progress(
  jobId: string,
  phase: string,
  message: string,
  stats?: Partial<DiffProgress> & { codexThreadId?: string }
): AgentJobProgress {
  return { type: "job.progress", jobId, phase, message, at: new Date().toISOString(), ...stats };
}

type DiffProgress = {
  filesChanged: number;
  added: number;
  deleted: number;
  files: Array<{ path: string; added: number; deleted: number }>;
};

async function diffProgress(repoPath: string): Promise<DiffProgress> {
  const result = await runCapture("git", ["-C", repoPath, "diff", "--numstat"], undefined, 15000);
  let filesChanged = 0;
  let added = 0;
  let deleted = 0;
  const files: DiffProgress["files"] = [];
  const seen = new Set<string>();
  for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
    const [add, del, ...pathParts] = line.split(/\s+/);
    const path = pathParts.join(" ").slice(0, 500) || "unknown";
    seen.add(normalizeRepoPath(path));
    filesChanged += 1;
    const addedNumber = Number(add);
    const deletedNumber = Number(del);
    if (Number.isFinite(addedNumber)) added += addedNumber;
    if (Number.isFinite(deletedNumber)) deleted += deletedNumber;
    files.push({
      path,
      added: Number.isFinite(addedNumber) ? addedNumber : 0,
      deleted: Number.isFinite(deletedNumber) ? deletedNumber : 0
    });
  }
  const untracked = await runCapture("git", ["-C", repoPath, "ls-files", "--others", "--exclude-standard"], undefined, 15000);
  for (const rawPath of untracked.stdout.split(/\r?\n/).filter(Boolean)) {
    const path = rawPath.trim();
    const normalized = normalizeRepoPath(path);
    if (!path || seen.has(normalized) || shouldIgnoreUntrackedPath(normalized)) continue;
    const addedLines = countAddedLines(repoPath, path);
    seen.add(normalized);
    filesChanged += 1;
    added += addedLines;
    files.push({ path: path.slice(0, 500), added: addedLines, deleted: 0 });
  }
  return { filesChanged, added, deleted, files: files.slice(0, 50) };
}

function hasDiffChanges(stats: DiffProgress): boolean {
  return stats.filesChanged > 0 || stats.added > 0 || stats.deleted > 0 || stats.files.length > 0;
}

function normalizeRepoPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function shouldIgnoreUntrackedPath(path: string): boolean {
  return path === ".git"
    || path.startsWith(".git/")
    || path === "node_modules"
    || path.startsWith("node_modules/")
    || path === "dist"
    || path.startsWith("dist/")
    || path === ".codex-web-attachments"
    || path.startsWith(".codex-web-attachments/");
}

function countAddedLines(repoPath: string, relativePath: string): number {
  try {
    const fullPath = join(repoPath, relativePath);
    const stat = statSync(fullPath);
    if (!stat.isFile() || stat.size > 200_000) return 0;
    const bytes = readFileSync(fullPath);
    if (bytes.includes(0)) return 0;
    const text = bytes.toString("utf8");
    if (!text) return 0;
    return text.split(/\r?\n/).length;
  } catch {
    return 0;
  }
}

function handleCodexJsonLine(context: RunContext, line: string): { handled: boolean; threadId?: string; messageText?: string } {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return { handled: false };
  }
  if (!event || typeof event !== "object") return { handled: false };
  const item = "item" in event && event.item && typeof event.item === "object" ? event.item as Record<string, unknown> : undefined;
  const type = "type" in event ? String(event.type) : "";

  if (type === "thread.started") {
    const threadId = "thread_id" in event && typeof event.thread_id === "string" ? event.thread_id : undefined;
    context.sendProgress(progress(context.job.id, "started", "Codex thread started.", threadId ? { codexThreadId: threadId } : undefined));
    return { handled: true, threadId };
  }
  if (type === "turn.started") {
    context.sendProgress(progress(context.job.id, "thinking", "Codex is thinking."));
    return { handled: true };
  }
  if (type === "item.started" && item?.type === "command_execution") {
    const command = typeof item.command === "string" ? item.command : "command";
    const summary = summarizeCommand(command);
    context.sendProgress(progress(context.job.id, "command", `Running: ${summary}`));
    context.sendLog(log(context.job.id, "system", `Running: ${summary}`));
    return { handled: true };
  }
  if (type === "item.completed" && item?.type === "agent_message") {
    const text = typeof item.text === "string" ? item.text.trim() : "";
    if (text) {
      context.sendProgress(progress(context.job.id, "message", text.slice(0, 500)));
      context.sendLog(log(context.job.id, "stdout", text));
    }
    return { handled: true, messageText: text };
  }
  if (type === "item.completed" && item?.type === "command_execution") {
    const status = typeof item.status === "string" ? item.status : "completed";
    const command = typeof item.command === "string" ? summarizeCommand(item.command) : "command";
    const output = typeof item.aggregated_output === "string" ? item.aggregated_output.trim() : "";
    context.sendProgress(progress(context.job.id, "command", `${command}: ${status}.`));
    context.sendLog(log(context.job.id, status === "failed" ? "stderr" : "system", `${command}: ${status}.`));
    if (output) context.sendLog(log(context.job.id, status === "failed" ? "stderr" : "stdout", output.slice(0, 4000)));
    return { handled: true };
  }

  return { handled: true };
}

function createGrokJsonLineHandler(): JsonLineHandler {
  let messageText = "";
  let thoughtSeen = false;
  return (context, line) => {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return { handled: false };
    }
    if (!event || typeof event !== "object") return { handled: false };
    const record = event as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "";
    const data = typeof record.data === "string" ? record.data : "";
    if (type === "thought") {
      if (!thoughtSeen) {
        thoughtSeen = true;
        context.sendProgress(progress(context.job.id, "thinking", "Grok is thinking."));
      }
      return { handled: true };
    }
    if (type === "text") {
      messageText = `${messageText}${data}`.slice(-4000);
      if (data.includes("\n")) {
        const text = messageText.trim();
        if (text) {
          context.sendProgress(progress(context.job.id, "message", text.slice(-500)));
          context.sendLog(log(context.job.id, "stdout", text));
        }
      }
      return { handled: true, messageText };
    }
    if (type === "end") {
      const sessionId = typeof record.sessionId === "string" ? record.sessionId : undefined;
      const text = messageText.trim();
      if (text) {
        context.sendProgress(progress(context.job.id, "message", text.slice(-500), sessionId ? { codexThreadId: sessionId } : undefined));
        context.sendLog(log(context.job.id, "stdout", text));
      }
      if (sessionId) {
        context.sendProgress(progress(context.job.id, "started", "Grok session updated.", { codexThreadId: sessionId }));
      }
      return { handled: true, threadId: sessionId, messageText: text };
    }
    return { handled: true };
  };
}

function createGeminiCliJsonLineHandler(): JsonLineHandler {
  let messageText = "";
  return (context, line) => {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return { handled: false };
    }
    if (!event || typeof event !== "object") return { handled: false };
    const record = event as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "";

    if (type === "init") {
      const sessionId = typeof record.session_id === "string" ? record.session_id : undefined;
      context.sendProgress(progress(context.job.id, "started", "Gemini session started.", sessionId ? { codexThreadId: sessionId } : undefined));
      return { handled: true, threadId: sessionId };
    }

    if (type === "message") {
      const role = typeof record.role === "string" ? record.role : "";
      const content = typeof record.content === "string" ? record.content : "";
      if (role !== "assistant" || !content) return { handled: true, messageText };
      messageText = record.delta === true ? `${messageText}${content}` : content;
      const text = messageText.trim();
      if (text) {
        context.sendProgress(progress(context.job.id, "message", text.slice(-500)));
        context.sendLog(log(context.job.id, "stdout", text));
      }
      return { handled: true, messageText: text };
    }

    if (type === "result") {
      const status = typeof record.status === "string" ? record.status : "";
      if (status === "error") {
        const error = record.error && typeof record.error === "object" ? record.error as Record<string, unknown> : undefined;
        const errorMessage = typeof error?.message === "string" ? error.message : "Gemini CLI returned an error.";
        messageText = `Gemini CLI error: ${errorMessage}`;
        context.sendProgress(progress(context.job.id, "message", messageText.slice(-500)));
        context.sendLog(log(context.job.id, "stderr", messageText));
        return { handled: true, messageText };
      }
      return { handled: true, messageText: messageText.trim() };
    }

    return { handled: true, messageText };
  };
}

function createGeminiSseLineHandler(): JsonLineHandler {
  let messageText = "";
  return (context, line) => {
    const raw = line.trim();
    if (!raw || raw.startsWith(":")) return { handled: true };
    if (!raw.startsWith("data:")) return { handled: false };
    const data = raw.slice("data:".length).trim();
    if (!data || data === "[DONE]") return { handled: true, messageText };
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      return { handled: false };
    }
    const delta = geminiTextFromResponse(event);
    if (!delta) return { handled: true, messageText };
    messageText = `${messageText}${delta}`.slice(-8000);
    const text = messageText.trim();
    if (text) {
      context.sendProgress(progress(context.job.id, "message", text.slice(-500)));
      context.sendLog(log(context.job.id, "stdout", text));
    }
    return { handled: true, messageText: text };
  };
}

function geminiTextFromResponse(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const candidates = (value as Record<string, unknown>).candidates;
  if (!Array.isArray(candidates)) return "";
  return candidates.map((candidate) => {
    if (!candidate || typeof candidate !== "object") return "";
    const content = (candidate as Record<string, unknown>).content;
    if (!content || typeof content !== "object") return "";
    const parts = (content as Record<string, unknown>).parts;
    if (!Array.isArray(parts)) return "";
    return parts.map((part) => {
      if (!part || typeof part !== "object") return "";
      const text = (part as Record<string, unknown>).text;
      return typeof text === "string" ? text : "";
    }).join("");
  }).join("");
}

function summarizeCommand(command: string): string {
  return command
    .replace(/"C:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe"\s+-Command\s+/i, "")
    .replace(/^powershell(?:\.exe)?\s+-Command\s+/i, "")
    .replace(/\s+/g, " ")
    .slice(0, 180);
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n\n[diff truncated]`;
}
