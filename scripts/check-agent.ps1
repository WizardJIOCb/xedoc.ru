$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

if (-not (Test-Path "data")) {
  New-Item -ItemType Directory -Path "data" | Out-Null
}

function Get-AgentProcesses {
  @(Get-CimInstance Win32_Process | Where-Object {
    $_.ProcessId -ne $PID -and (
      (
        $_.Name -eq "node.exe" -and
        $_.CommandLine -like "*apps/agent-windows/dist/index.js*" -and
        $_.CommandLine -like "*apps/agent-windows/agent.config.json*"
      ) -or (
        $_.Name -in @("powershell.exe", "cmd.exe") -and
        $_.CommandLine -like "*scripts\run-agent.ps1*"
      )
    )
  })
}

function Stop-AgentProcesses([object[]]$Processes) {
  if (-not $Processes -or $Processes.Count -eq 0) {
    return
  }

  foreach ($Process in $Processes) {
    try {
      Write-Host "Stopping Codex agent PID: $($Process.ProcessId)"
      Stop-Process -Id $Process.ProcessId -Force -ErrorAction Stop
    } catch {
      throw "Could not stop Codex agent PID $($Process.ProcessId): $($_.Exception.Message)"
    }
  }
  Start-Sleep -Seconds 1
}

function Start-CodexAgent {
  $UserAgentToken = [Environment]::GetEnvironmentVariable("CMC_AGENT_TOKEN", "User")
  if ($UserAgentToken) {
    $env:CMC_AGENT_TOKEN = $UserAgentToken
  }

  if (-not $env:CMC_AGENT_TOKEN) {
    throw "CMC_AGENT_TOKEN is not set. Put it in the CMC_AGENT_TOKEN user environment variable."
  }

  Write-Host "Preparing VS Code bridge..."
  & (Join-Path $Root "scripts\prepare-vscode-bridge.ps1") -SkipBuild

  $Out = Join-Path $Root "data\prod-agent.log"
  $Err = Join-Path $Root "data\prod-agent.err.log"
  $Script = Join-Path $Root "scripts\run-agent.ps1"
  $Process = Start-Process `
    -FilePath "powershell.exe" `
    -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $Script) `
    -WorkingDirectory $Root `
    -WindowStyle Hidden `
    -RedirectStandardOutput $Out `
    -RedirectStandardError $Err `
    -PassThru

  $Process.Id | Set-Content -Path (Join-Path $Root "data\prod-agent-launcher.pid") -Encoding ASCII
  Write-Host "Codex agent started. Launcher PID: $($Process.Id)"
  Write-Host "Logs: $Out"
}

$Running = @(Get-AgentProcesses)
if ($Running.Count -gt 0) {
  Write-Host "Codex agent is running. Restarting..."
  Stop-AgentProcesses $Running
} else {
  Write-Host "Codex agent is not running. Starting..."
}

Start-CodexAgent

Start-Sleep -Seconds 2
$AfterStart = @(Get-AgentProcesses | Where-Object { $_.Name -eq "node.exe" })
if ($AfterStart.Count -eq 0) {
  Write-Host "Codex agent did not start. Check data\prod-agent.err.log."
  exit 1
}

Write-Host "Codex agent is running. PID: $($AfterStart.ProcessId -join ', ')"
