import { spawn } from "node:child_process";

export type SpawnResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

export function runCapture(command: string, args: string[], cwd?: string, timeoutMs = 30000, input?: string): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      shell: needsShell(command),
      windowsHide: true,
      env: minimalEnv()
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    if (input !== undefined) {
      child.stdin.write(input);
      child.stdin.end();
    }
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ exitCode: 127, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr });
    });
  });
}

export function needsShell(command: string): boolean {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
}

export function minimalEnv(): NodeJS.ProcessEnv {
  const allowed = [
    "PATH",
    "Path",
    "PATHEXT",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_RUNTIME_DIR",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "USERNAME",
    "USERDOMAIN",
    "APPDATA",
    "LOCALAPPDATA",
    "TEMP",
    "TMP",
    "SYSTEMROOT",
    "SystemRoot",
    "SystemDrive",
    "WINDIR",
    "windir",
    "COMSPEC",
    "ComSpec",
    "ProgramData",
    "OPENAI_API_KEY",
    "OPENAI_ADMIN_KEY",
    "OPENAI_PROJECT_ID",
    "OPENAI_RATE_LIMIT_MODEL",
    "XAI_API_KEY",
    "CODEX_HOME",
    "GROK_HOME",
    "GROK_SANDBOX",
    "CMC_GROK_BIN",
    "CMC_GROK_WSL_BIN",
    "CMC_WSL_BASH_BIN",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GH_CONFIG_DIR",
    "GH_PROMPT_DISABLED"
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.GH_PROMPT_DISABLED ??= "1";
  return env;
}
