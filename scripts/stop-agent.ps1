$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$ConfigPath = Join-Path $Root "apps\agent-windows\agent.config.json"
$ServerHost = ""
if (Test-Path $ConfigPath) {
  try {
    $Config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
    $ServerHost = ([Uri]$Config.serverUrl).Host
  } catch {
    Write-Warning "Could not read agent server URL from config: $($_.Exception.Message)"
  }
}

$Processes = @(Get-CimInstance Win32_Process)
$TargetPids = New-Object "System.Collections.Generic.HashSet[int]"

foreach ($Process in $Processes) {
  if (
    $Process.Name -eq "node.exe" -and
    $Process.CommandLine -like "*apps/agent-windows/dist/index.js*"
  ) {
    [void]$TargetPids.Add([int]$Process.ProcessId)
  }
}

if ($ServerHost) {
  try {
    $Addresses = @(
      Resolve-DnsName $ServerHost -ErrorAction Stop |
        Where-Object IPAddress |
        ForEach-Object IPAddress
    )
    $SocketPids = @(
      Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue |
        Where-Object { $_.RemoteAddress -in $Addresses -and $_.RemotePort -in @(80, 443) } |
        ForEach-Object OwningProcess |
        Sort-Object -Unique
    )
    foreach ($Process in $Processes) {
      if ($Process.Name -eq "node.exe" -and $Process.ProcessId -in $SocketPids) {
        [void]$TargetPids.Add([int]$Process.ProcessId)
      }
    }
  } catch {
    Write-Warning "Could not inspect active agent sockets: $($_.Exception.Message)"
  }
}

foreach ($Process in $Processes) {
  if (
    $Process.ProcessId -ne $PID -and
    $Process.Name -in @("powershell.exe", "cmd.exe") -and
    (
      $Process.CommandLine -like "*scripts\run-agent.ps1*" -or
      $Process.CommandLine -like "*start-agent.bat*"
    )
  ) {
    [void]$TargetPids.Add([int]$Process.ProcessId)
  }
}

if ($TargetPids.Count -eq 0) {
  Write-Host "Codex agent is not running."
  exit 0
}

$Failed = @()
foreach ($TargetPid in ($TargetPids | Sort-Object)) {
  try {
    $Process = Get-Process -Id $TargetPid -ErrorAction Stop
    Write-Host "Stopping PID: $TargetPid $($Process.ProcessName)"
    Stop-Process -Id $TargetPid -Force -ErrorAction Stop
  } catch {
    $Failed += $TargetPid
    Write-Host "Could not stop PID ${TargetPid}: $($_.Exception.Message)"
  }
}

if ($Failed.Count -gt 0) {
  Write-Host ""
  Write-Host "Some agent processes require elevated rights."
  Write-Host "Run this file as Administrator to stop PID(s): $($Failed -join ', ')"
  exit 1
}

Write-Host "Codex agent stopped."
