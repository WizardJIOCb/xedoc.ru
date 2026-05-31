param(
  [string]$SshHost = "myserver",
  [string]$TaskName = "Codex Server OpenAI Tunnel",
  [string]$RemoteSocksBind = "127.0.0.1:10808",
  [string]$ServerHttpProxy = "127.0.0.1:10809",
  [switch]$NoRestart
)

$ErrorActionPreference = "Stop"

function Write-Step([string]$Message) {
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Ok([string]$Message) {
  Write-Host "OK  $Message" -ForegroundColor Green
}

function Write-Warn([string]$Message) {
  Write-Host "WARN $Message" -ForegroundColor Yellow
}

function Write-Fail([string]$Message) {
  Write-Host "FAIL $Message" -ForegroundColor Red
}

function Get-TunnelSshProcesses {
  Get-CimInstance Win32_Process -Filter "name = 'ssh.exe'" |
    Where-Object {
      $_.CommandLine -like "*$RemoteSocksBind*" -and
      $_.CommandLine -like "*$SshHost*"
    }
}

function Get-TunnelRunnerProcesses {
  Get-CimInstance Win32_Process -Filter "name = 'powershell.exe'" |
    Where-Object {
      $_.CommandLine -like "*start-server-openai-tunnel.ps1*" -and
      $_.CommandLine -notlike "*ensure-server-openai-tunnel.ps1*"
    }
}

$ssh = "C:\Windows\System32\OpenSSH\ssh.exe"
if (!(Test-Path -LiteralPath $ssh)) {
  throw "OpenSSH client was not found at $ssh"
}

$root = Join-Path $env:USERPROFILE "codex-agent"
$scriptsDir = Join-Path $root "scripts"
$logsDir = Join-Path $root "logs"
$runnerPath = Join-Path $scriptsDir "start-server-openai-tunnel.ps1"
$hiddenLauncherPath = Join-Path $scriptsDir "start-server-openai-tunnel-hidden.vbs"
$logFile = Join-Path $logsDir "server-openai-tunnel.log"

New-Item -ItemType Directory -Force -Path $scriptsDir, $logsDir | Out-Null

Write-Step "Writing tunnel runner"
$runner = @"
`$ErrorActionPreference = 'Continue'
`$ssh = '$ssh'
`$sshHost = '$SshHost'
`$remoteSocksBind = '$RemoteSocksBind'
`$logDir = '$($logsDir.Replace("'", "''"))'
New-Item -ItemType Directory -Force -Path `$logDir | Out-Null
`$logFile = Join-Path `$logDir 'server-openai-tunnel.log'

while (`$true) {
  `$stamp = Get-Date -Format o
  Add-Content -Path `$logFile -Value "[`$stamp] starting reverse SOCKS tunnel `$remoteSocksBind -> `$sshHost"
  & `$ssh -N ``
    -E `$logFile ``
    -o ExitOnForwardFailure=yes ``
    -o ServerAliveInterval=30 ``
    -o ServerAliveCountMax=3 ``
    -R `$remoteSocksBind ``
    `$sshHost
  `$code = `$LASTEXITCODE
  `$stamp = Get-Date -Format o
  Add-Content -Path `$logFile -Value "[`$stamp] tunnel exited with code `$code; restarting in 5s"
  Start-Sleep -Seconds 5
}
"@
Set-Content -LiteralPath $runnerPath -Value $runner -Encoding UTF8

Write-Step "Writing hidden launcher"
$hiddenLauncher = @"
Set shell = CreateObject("WScript.Shell")
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""$runnerPath""", 0, True
"@
Set-Content -LiteralPath $hiddenLauncherPath -Value $hiddenLauncher -Encoding ASCII

Write-Step "Registering scheduled task"
$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$hiddenLauncherPath`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description "Keeps the reverse SOCKS tunnel for xedoc.ru Linux agent alive." `
  -Force | Out-Null

if ($NoRestart) {
  Write-Step "Starting scheduled task if needed"
} else {
  Write-Step "Restarting tunnel processes"
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1

  Get-TunnelSshProcesses | ForEach-Object {
    Write-Warn "Stopping stale ssh.exe PID $($_.ProcessId)"
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Get-TunnelRunnerProcesses | ForEach-Object {
    Write-Warn "Stopping stale runner PowerShell PID $($_.ProcessId)"
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

Start-ScheduledTask -TaskName $TaskName

Write-Step "Checking Windows tunnel process"
for ($attempt = 1; $attempt -le 25; $attempt++) {
  $sshProcesses = @(Get-TunnelSshProcesses)
  if ($sshProcesses.Length) { break }
  Start-Sleep -Seconds 1
}

if (!$sshProcesses.Length) {
  Write-Fail "No ssh.exe tunnel process is running."
  Write-Host "Log: $logFile"
  exit 1
}

$sshProcesses | ForEach-Object {
  Write-Ok "ssh.exe tunnel PID $($_.ProcessId)"
}

Write-Step "Checking server tunnel route"
$remoteCheck = @'
set -a
. /root/codex-agent/agent.env
set +a

echo "== ports =="
ss -ltnp '( sport = :10808 or sport = :10809 )' || true

echo "== auth =="
curl -sS -o /tmp/codex-auth-check.out -w 'auth %{http_code} %{remote_ip} %{time_total}\n' https://auth.openai.com/api/accounts/deviceauth/usercode

echo "== codex endpoint =="
curl -sS -o /tmp/codex-endpoint-check.out -w 'codex-get %{http_code} %{remote_ip} %{time_total}\n' https://chatgpt.com/backend-api/codex/responses
head -c 120 /tmp/codex-endpoint-check.out 2>/dev/null
echo

echo "== codex login =="
codex login status || true

echo "== linux agent =="
systemctl is-active codex-agent-linux.service || true
'@

$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
$remoteOutput = & $ssh $SshHost $remoteCheck 2>&1
$remoteExit = $LASTEXITCODE
$ErrorActionPreference = $previousErrorActionPreference
$remoteOutput | ForEach-Object { Write-Host $_ }

if ($remoteExit -ne 0) {
  Write-Fail "SSH/server health check failed with exit code $remoteExit."
  exit 1
}

$remoteText = $remoteOutput -join "`n"
$ok = $true

if ($remoteText -notmatch "127\.0\.0\.1:10808") {
  Write-Fail "Server is not listening on 127.0.0.1:10808."
  $ok = $false
}
if ($remoteText -notmatch "127\.0\.0\.1:10809") {
  Write-Fail "Server is not listening on 127.0.0.1:10809."
  $ok = $false
}
if ($remoteText -notmatch "auth 405 ") {
  Write-Fail "auth.openai.com did not return the expected 405 health response."
  $ok = $false
}
if ($remoteText -notmatch "codex-get 405 ") {
  Write-Fail "chatgpt.com Codex endpoint did not return the expected 405 health response."
  $ok = $false
}
if ($remoteText -notmatch "Logged in using ChatGPT") {
  Write-Warn "Codex is not logged in using ChatGPT. Run device auth on the server if jobs fail."
}
if ($remoteText -notmatch "== linux agent ==\s*active") {
  Write-Warn "codex-agent-linux.service is not active according to the health check."
}

if (!$ok) {
  Write-Host ""
  Write-Host "Open the log if needed:" -ForegroundColor Yellow
  Write-Host "  $logFile"
  exit 1
}

Write-Host ""
Write-Ok "Tunnel is ready. You can use Server Ubuntu projects on https://xedoc.ru"
Write-Host "Log: $logFile"
