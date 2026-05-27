param(
  [string]$Config = "apps/agent-windows/agent.config.json"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$UserAgentToken = [Environment]::GetEnvironmentVariable("CMC_AGENT_TOKEN", "User")
if ($UserAgentToken) {
  $env:CMC_AGENT_TOKEN = $UserAgentToken
}

foreach ($Name in @(
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_ADMIN_KEY",
  "OPENAI_PROJECT_ID",
  "OPENAI_RATE_LIMIT_MODEL",
  "XAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENAI_USE_GCA",
  "GEMINI_CLI_TRUST_WORKSPACE",
  "CMC_GEMINI_BIN",
  "CMC_GROK_BIN",
  "CMC_GROK_WSL_BIN",
  "CMC_WSL_BASH_BIN",
  "CMC_AGENT_TRANSPORT_PROXY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy"
)) {
  if (-not (Get-Item -Path "Env:$Name" -ErrorAction SilentlyContinue)) {
    $UserValue = [Environment]::GetEnvironmentVariable($Name, "User")
    if ($UserValue) {
      Set-Item -Path "Env:$Name" -Value $UserValue
    }
  }
}

$TransportProxy = $env:CMC_AGENT_TRANSPORT_PROXY
if ($TransportProxy) {
  foreach ($Name in @("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy")) {
    Set-Item -Path "Env:$Name" -Value $TransportProxy
  }

  $NoProxyDefaults = @("127.0.0.1", "localhost", "::1", "codex.rodion.pro", "82.146.42.213", "100.64.0.0/10", "100.87.116.56")
  $ExistingNoProxy = @($env:NO_PROXY, $env:no_proxy) |
    Where-Object { $_ } |
    ForEach-Object { $_ -split "," } |
    ForEach-Object { $_.Trim() } |
    Where-Object { $_ }
  $NoProxy = @($ExistingNoProxy + $NoProxyDefaults) | Select-Object -Unique
  $env:NO_PROXY = $NoProxy -join ","
  $env:no_proxy = $env:NO_PROXY
}

if (-not $env:CMC_AGENT_TOKEN) {
  throw "CMC_AGENT_TOKEN is not set. Put it in the CMC_AGENT_TOKEN user environment variable."
}

$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
$MachinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
$NpmPath = Join-Path $env:APPDATA "npm"
$NodePath = Split-Path -Parent (Get-Command node.exe -ErrorAction Stop).Source
$PathParts = @($NpmPath, $NodePath, $UserPath, $MachinePath) | Where-Object { $_ }
$env:Path = ($PathParts -join ";")

if (-not $env:CMC_CODEX_BIN) {
  $CodexCmd = Get-Command codex.cmd -ErrorAction SilentlyContinue
  if ($CodexCmd) {
    $env:CMC_CODEX_BIN = $CodexCmd.Source
    $env:CMC_CODEX_JS = Join-Path (Split-Path -Parent $CodexCmd.Source) "node_modules\@openai\codex\bin\codex.js"
    $env:CMC_CODEX_NODE = (Get-Command node.exe -ErrorAction Stop).Source
  }
}

if (-not $env:CMC_CODEX_BIN -and -not ($env:CMC_CODEX_NODE -and $env:CMC_CODEX_JS)) {
  throw "codex.cmd is not available in PATH. Install or expose Codex CLI for the Windows agent."
}

if (-not $env:CMC_GROK_BIN) {
  $GrokCmd = Get-Command grok.cmd -ErrorAction SilentlyContinue
  if ($GrokCmd) {
    $env:CMC_GROK_BIN = $GrokCmd.Source
  }
}

if (-not $env:CMC_GROK_BIN -and -not $env:CMC_GROK_WSL_BIN) {
  $BashCmd = Get-Command bash.exe -ErrorAction SilentlyContinue
  if ($BashCmd) {
    $Probe = & $BashCmd.Source -lc "test -x ~/.grok/bin/grok" 2>$null
    if ($LASTEXITCODE -eq 0) {
      $env:CMC_WSL_BASH_BIN = $BashCmd.Source
    }
  }
}

if (-not $env:CMC_GEMINI_BIN) {
  $GeminiCmd = Get-Command gemini.cmd -ErrorAction SilentlyContinue
  if ($GeminiCmd) {
    $env:CMC_GEMINI_BIN = $GeminiCmd.Source
  }
}

node apps/agent-windows/dist/index.js --config $Config
