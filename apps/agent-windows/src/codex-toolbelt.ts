import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { minimalEnv, needsShell } from "./process-utils.js";

type Capture = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
};

const cwd = process.cwd();
const [, , command = "help", ...args] = process.argv;

async function main() {
  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "doctor") {
    await doctor();
    return;
  }
  if (command === "npm") {
    await npmCommand(args[0] === "--" ? args.slice(1) : args);
    return;
  }
  if (command === "build") {
    await build();
    return;
  }
  if (command === "smoke") {
    await smoke(args);
    return;
  }
  if (command === "screenshot") {
    await screenshot(args);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

function printHelp() {
  console.log([
    "codex-toolbelt: helpers for xedoc.ru Windows agent jobs",
    "",
    "Commands:",
    "  doctor                         Print local tool availability and project hints.",
    "  npm -- <args>                   Run npm.cmd with Windows-safe shell handling.",
    "  build                          Run the project build script via the detected package manager.",
    "  smoke [url|dir] [--path /]      Finite HTTP smoke test. A directory is served temporarily.",
    "  screenshot <url> <out.png>      Best-effort headless Chrome/Edge screenshot.",
    "",
    "Examples:",
    "  node codex-toolbelt.js doctor",
    "  node codex-toolbelt.js npm -- run build",
    "  node codex-toolbelt.js smoke dist",
    "  node codex-toolbelt.js smoke http://127.0.0.1:5173/",
    "  node codex-toolbelt.js screenshot http://127.0.0.1:5173/ dist/smoke.png"
  ].join("\n"));
}

async function doctor() {
  const pkg = readPackageJson();
  const hints = environmentHints();
  const checks: Array<[string, string[]]> = [
    ["node", ["--version"]],
    [npmExecutable(), ["--version"]],
    ["git", ["--version"]]
  ];
  console.log(`cwd: ${cwd}`);
  console.log(`platform: ${process.platform} ${process.arch}`);
  console.log(`package: ${pkg?.name ?? "not found"}`);
  console.log(`scripts: ${Object.keys(pkg?.scripts ?? {}).join(", ") || "none"}`);
  for (const [bin, binArgs] of checks) {
    const result = await run(bin, binArgs, 15000);
    console.log(`${bin}: ${result.exitCode === 0 ? firstLine(result.stdout || result.stderr) : `unavailable (${firstLine(result.stderr || result.stdout)})`}`);
  }
  console.log(`browser: ${findBrowser()?.path ?? "not found"}`);
  if (hints.length) {
    console.log("");
    console.log("hints:");
    for (const hint of hints) console.log(`- ${hint}`);
  }
}

async function npmCommand(commandArgs: string[]) {
  if (!commandArgs.length) throw new Error("Usage: codex-toolbelt npm -- <args>");
  const result = await run(npmExecutable(), commandArgs, 10 * 60 * 1000);
  writeResult(result);
  printFailureHints(result);
  process.exitCode = result.exitCode ?? 1;
}

async function build() {
  const pkg = readPackageJson();
  if (!pkg?.scripts?.build) throw new Error("package.json has no build script.");
  const manager = packageManagerCommand();
  console.log(`$ ${manager.command} ${manager.args.join(" ")} run build`);
  const result = await run(manager.command, [...manager.args, "run", "build"], 10 * 60 * 1000);
  writeResult(result);
  printFailureHints(result);
  process.exitCode = result.exitCode ?? 1;
}

async function smoke(commandArgs: string[]) {
  const target = commandArgs.find((arg) => !arg.startsWith("--")) ?? "dist";
  const pathIndex = commandArgs.indexOf("--path");
  const smokePath = pathIndex >= 0 ? commandArgs[pathIndex + 1] ?? "/" : "/";
  if (/^https?:\/\//i.test(target)) {
    await smokeUrl(new URL(target));
    return;
  }
  const root = resolve(cwd, target);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`Smoke directory not found: ${root}`);
  const server = createServer((request, response) => {
    const requestPath = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
    const relative = requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");
    const file = resolve(root, relative);
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found");
      return;
    }
    response.writeHead(200, { "content-type": contentType(file), "cache-control": "no-store" });
    response.end(readFileSync(file));
  });
  await new Promise<void>((resolveReady) => server.listen(0, "127.0.0.1", resolveReady));
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await smokeUrl(new URL(smokePath, `http://127.0.0.1:${port}/`));
  } finally {
    server.close();
  }
}

async function smokeUrl(url: URL) {
  const response = await fetch(url);
  const text = await response.text();
  const title = text.match(/<title[^>]*>(.*?)<\/title>/is)?.[1]?.replace(/\s+/g, " ").trim();
  console.log(`GET ${url.href}`);
  console.log(`status: ${response.status} ${response.statusText}`);
  if (title) console.log(`title: ${title}`);
  console.log(`bytes: ${text.length}`);
  if (!response.ok) process.exitCode = 1;
}

async function screenshot(commandArgs: string[]) {
  const [url, outArg] = commandArgs;
  if (!url || !outArg) throw new Error("Usage: codex-toolbelt screenshot <url> <out.png>");
  const browser = findBrowser();
  if (!browser) throw new Error("Chrome or Edge was not found.");
  const output = resolve(cwd, outArg);
  mkdirSync(dirname(output), { recursive: true });
  const profile = join(tmpdir(), `cmc-browser-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(profile, { recursive: true });
  const result = await run(browser.path, [
    "--headless=new",
    "--disable-gpu",
    "--disable-crash-reporter",
    "--disable-features=Crashpad",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${profile}`,
    `--screenshot=${output}`,
    "--window-size=1280,800",
    url
  ], 60000);
  writeResult(result);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // Temporary browser profiles are best-effort cleanup.
  }
  if (result.exitCode !== 0 || !existsSync(output)) {
    console.error("Browser screenshot failed. In the Codex CLI sandbox this is usually a Windows Mojo/Crashpad access limitation; use `smoke` for HTTP verification.");
    process.exitCode = result.exitCode || 1;
    return;
  }
  console.log(`screenshot: ${output}`);
}

function readPackageJson(): { name?: string; scripts?: Record<string, string> } | null {
  const path = join(cwd, "package.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as { name?: string; scripts?: Record<string, string> };
}

function packageManagerCommand(): { command: string; args: string[] } {
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return { command: "corepack", args: ["pnpm"] };
  if (existsSync(join(cwd, "yarn.lock"))) return { command: "corepack", args: ["yarn"] };
  return { command: npmExecutable(), args: [] };
}

function npmExecutable(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function environmentHints(): string[] {
  const hints = [
    "Use `npm.cmd` or `node codex-toolbelt.js npm -- ...` on Windows. Do not invoke npm.ps1.",
    "Prefer finite verification commands. Avoid WMI, detached Start-Process servers, and long-lived dev servers inside Codex tool calls.",
    "Use `smoke dist` after static builds or `smoke http://127.0.0.1:<port>/` for HTTP checks.",
    "The in-app Browser/node_repl tools are not available inside codex exec jobs unless the host explicitly provides them.",
    "Headless Chrome/Edge can be blocked by Windows sandbox permissions; `screenshot` is best-effort, `smoke` is the reliable fallback."
  ];
  if (existsSync(join(cwd, "vite.config.ts")) || existsSync(join(cwd, "vite.config.mjs"))) {
    hints.push("If Vite/esbuild reports spawn EPERM, it is an environment limitation, not necessarily a source-code bug. Try `--configLoader native` once, then avoid looping.");
  }
  return hints;
}

function findBrowser(): { name: string; path: string } | null {
  const localAppData = process.env.LOCALAPPDATA ?? "";
  const candidates: Array<[string, string]> = [
    ["Chrome", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"],
    ["Chrome", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"],
    ["Chrome", join(localAppData, "Google\\Chrome\\Application\\chrome.exe")],
    ["Edge", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"],
    ["Edge", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"]
  ];
  for (const [name, path] of candidates) {
    if (path && existsSync(path)) return { name, path };
  }
  return null;
}

function run(command: string, args: string[], timeoutMs: number): Promise<Capture> {
  return new Promise((resolveRun) => {
    const child: ChildProcessWithoutNullStreams = spawn(command, args, {
      cwd,
      shell: needsShell(command),
      windowsHide: true,
      env: {
        ...minimalEnv(),
        npm_config_script_shell: process.platform === "win32" ? "cmd.exe" : undefined
      }
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolveRun({ exitCode: 127, stdout, stderr: `${stderr}${error.message}`, timedOut });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolveRun({ exitCode, stdout, stderr, timedOut });
    });
  });
}

function writeResult(result: Capture) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.timedOut) console.error("Command timed out.");
}

function printFailureHints(result: Capture) {
  if (result.exitCode === 0) return;
  const text = `${result.stdout}\n${result.stderr}`;
  const hints: string[] = [];
  if (/npm\.ps1|running scripts is disabled|ExecutionPolicy/i.test(text)) {
    hints.push("PowerShell blocked npm.ps1. Use `npm.cmd` or `node <toolbelt> npm -- ...`.");
  }
  if (/spawn EPERM|Access is denied|0x5|Отказано в доступе/i.test(text)) {
    hints.push("A native subprocess was blocked by Windows policy/sandbox. Prefer finite toolbelt commands and avoid repeating equivalent native launches.");
  }
  if (/crashpad|mojo|headless/i.test(text)) {
    hints.push("Headless browser launch failed in this environment. Use `smoke` for HTTP verification.");
  }
  if (!hints.length) return;
  console.error("");
  console.error("toolbelt hints:");
  for (const hint of hints) console.error(`- ${hint}`);
}

function contentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".svg": return "image/svg+xml";
    case ".webp": return "image/webp";
    default: return "application/octet-stream";
  }
}

function firstLine(value: string): string {
  return value.trim().split(/\r?\n/)[0] ?? "";
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
