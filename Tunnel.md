# Server Agent Tunnel

This document describes the current safe tunnel setup for running the Linux
`agent-linux` on the Ubuntu server while using ChatGPT/Codex Pro auth from the
home Windows PC.

The goal is:

- keep `agent-windows` as-is;
- run projects on the Ubuntu server through `agent-linux`;
- avoid a full VPN on the server, so SSH access is not at risk;
- avoid OpenAI API-key billing when we want to use the ChatGPT Pro subscription;
- route only the server Codex process through the home PC/VPN path.

## Topology

```text
codex.rodion.pro web
  |
  | WebSocket /api/agent/ws
  v
Ubuntu server: agent-linux + Codex CLI
  |
  | HTTPS_PROXY=http://127.0.0.1:10809
  v
Ubuntu server: local HTTP CONNECT proxy
  |
  | forwards to SOCKS
  v
Ubuntu server: 127.0.0.1:10808
  ^
  | reverse SSH dynamic SOCKS: ssh -R 127.0.0.1:10808
  |
Windows home PC with VPN
  |
  v
auth.openai.com / chatgpt.com
```

Important safety property: the Ubuntu server default route, firewall, SSH daemon,
WireGuard/OpenVPN and system network settings are not changed. Only localhost
ports are used on the server:

- `127.0.0.1:10808`: reverse SOCKS endpoint created by Windows `ssh.exe`.
- `127.0.0.1:10809`: local HTTP CONNECT proxy used by Codex CLI.

If the tunnel breaks, the server remains reachable by SSH. Only server-side Codex
jobs lose access to ChatGPT/OpenAI until the tunnel is restored.

## Files

Repo files:

- `scripts/socks-http-proxy.mjs`
- `scripts/codex-socks-http-proxy.service`

Installed server files:

- `/root/codex-agent/socks-http-proxy.mjs`
- `/etc/systemd/system/codex-socks-http-proxy.service`
- `/root/codex-agent/agent.env`
- `/root/codex-agent/start-agent-linux.sh`

Windows helper files:

- `C:\Users\Rodion\codex-agent\scripts\start-server-openai-tunnel.ps1`
- `C:\Users\Rodion\codex-agent\scripts\start-server-openai-tunnel-hidden.vbs`
- `C:\Users\Rodion\codex-agent\logs\server-openai-tunnel.log`

Windows Scheduled Task:

- `Codex Server OpenAI Tunnel`

## One-Click Start

For day-to-day use:

1. Start the VPN on the Windows PC.
2. Run:

```bat
start-server-tunnel.bat
```

The batch file calls `scripts\ensure-server-openai-tunnel.ps1`. It will:

- create or update the hidden tunnel runner under `%USERPROFILE%\codex-agent`;
- create or update the `Codex Server OpenAI Tunnel` scheduled task;
- restart stale `ssh.exe` tunnel processes;
- start `ssh -R 127.0.0.1:10808 myserver`;
- check that the server sees ports `10808` and `10809`;
- check `auth.openai.com` and `chatgpt.com/backend-api/codex/responses`;
- check that Codex is logged in using ChatGPT and that `agent-linux` is active.

For scripts or CI-like usage without `pause`:

```bat
start-server-tunnel.bat /nopause
```

When it prints `Tunnel check completed successfully`, Server Ubuntu projects on
`https://codex.rodion.pro` are ready to use.

## Server Setup

Run from Windows PowerShell in this repo:

```powershell
$scp = 'C:\Windows\System32\OpenSSH\scp.exe'
$ssh = 'C:\Windows\System32\OpenSSH\ssh.exe'

& $scp .\scripts\socks-http-proxy.mjs myserver:/root/codex-agent/socks-http-proxy.mjs
& $scp .\scripts\codex-socks-http-proxy.service myserver:/etc/systemd/system/codex-socks-http-proxy.service

& $ssh myserver @'
set -e
chmod 0755 /root/codex-agent/socks-http-proxy.mjs
systemctl daemon-reload
systemctl enable --now codex-socks-http-proxy.service
systemctl is-active codex-socks-http-proxy.service
'@
```

Configure the Linux agent environment:

```powershell
$ssh = 'C:\Windows\System32\OpenSSH\ssh.exe'

& $ssh myserver @'
set -e
if [ -f /root/codex-agent/agent.env ]; then
  cp /root/codex-agent/agent.env "/root/codex-agent/agent.env.bak.$(date +%Y%m%d%H%M%S)"
fi

sed -i '/^\(ALL_PROXY\|HTTPS_PROXY\|HTTP_PROXY\|NO_PROXY\|all_proxy\|https_proxy\|http_proxy\|no_proxy\)=/d' /root/codex-agent/agent.env

cat >> /root/codex-agent/agent.env <<'ENV'
ALL_PROXY=http://127.0.0.1:10809
HTTPS_PROXY=http://127.0.0.1:10809
HTTP_PROXY=http://127.0.0.1:10809
NO_PROXY=127.0.0.1,localhost,codex.rodion.pro,82.146.42.213
ENV

systemctl restart codex-agent-linux.service
systemctl is-active codex-agent-linux.service
'@
```

`NO_PROXY` is important. It keeps `codex.rodion.pro` and local server traffic
direct, while Codex/OpenAI traffic goes through the proxy.

## Windows Tunnel

One-off visible-free tunnel:

```powershell
$ssh = 'C:\Windows\System32\OpenSSH\ssh.exe'
$logDir = 'C:\Users\Rodion\codex-agent\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

Start-Process -FilePath $ssh -ArgumentList @(
  '-N',
  '-E', "$logDir\server-openai-tunnel.log",
  '-o', 'ExitOnForwardFailure=yes',
  '-o', 'ServerAliveInterval=30',
  '-o', 'ServerAliveCountMax=3',
  '-R', '127.0.0.1:10808',
  'myserver'
) -WindowStyle Hidden
```

This creates `127.0.0.1:10808` on the server. The port is bound to server
localhost only.

## Windows Autostart

Create a self-restarting tunnel script:

```powershell
$root = 'C:\Users\Rodion\codex-agent'
$scripts = Join-Path $root 'scripts'
$logs = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $scripts, $logs | Out-Null

$psScriptPath = Join-Path $scripts 'start-server-openai-tunnel.ps1'
@'
$ErrorActionPreference = 'Stop'
$ssh = 'C:\Windows\System32\OpenSSH\ssh.exe'
$logDir = 'C:\Users\Rodion\codex-agent\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir 'server-openai-tunnel.log'

while ($true) {
  $stamp = Get-Date -Format o
  Add-Content -Path $logFile -Value "[$stamp] starting reverse SOCKS tunnel"
  & $ssh -N `
    -E $logFile `
    -o ExitOnForwardFailure=yes `
    -o ServerAliveInterval=30 `
    -o ServerAliveCountMax=3 `
    -R 127.0.0.1:10808 `
    myserver
  $code = $LASTEXITCODE
  $stamp = Get-Date -Format o
  Add-Content -Path $logFile -Value "[$stamp] tunnel exited with code $code; restarting in 5s"
  Start-Sleep -Seconds 5
}
'@ | Set-Content -LiteralPath $psScriptPath -Encoding UTF8
```

Create a hidden launcher:

```powershell
$vbsPath = 'C:\Users\Rodion\codex-agent\scripts\start-server-openai-tunnel-hidden.vbs'
@'
Set shell = CreateObject("WScript.Shell")
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""C:\Users\Rodion\codex-agent\scripts\start-server-openai-tunnel.ps1""", 0, False
'@ | Set-Content -LiteralPath $vbsPath -Encoding ASCII
```

Register the Scheduled Task:

```powershell
$taskName = 'Codex Server OpenAI Tunnel'
$vbsPath = 'C:\Users\Rodion\codex-agent\scripts\start-server-openai-tunnel-hidden.vbs'

$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbsPath`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description 'Keeps the reverse SOCKS tunnel for codex.rodion.pro Linux agent alive.' `
  -Force

Start-ScheduledTask -TaskName $taskName
```

Note: the scheduled task can show `Ready` even when the tunnel is alive. That is
normal when `wscript.exe` starts hidden PowerShell and exits. Check the actual
`ssh.exe` process or server port instead.

## ChatGPT Pro Login

Do not use `codex login --with-api-key` if the goal is to avoid separate OpenAI
API billing.

On the server:

```bash
set -a; . /root/codex-agent/agent.env; set +a
codex logout
codex login --device-auth
```

Open the printed URL on the Windows PC and enter the one-time code. Wait until
the server terminal says:

```text
Successfully logged in
```

Then:

```bash
codex login status
systemctl restart codex-agent-linux.service
```

Expected:

```text
Logged in using ChatGPT
```

## Health Checks

Windows process:

```powershell
Get-CimInstance Win32_Process -Filter "name = 'ssh.exe'" |
  Where-Object {
    $_.CommandLine -like '*127.0.0.1:10808*' -and
    $_.CommandLine -like '*myserver*'
  } |
  Select-Object ProcessId, ParentProcessId, CommandLine
```

Windows scheduled task:

```powershell
Get-ScheduledTask -TaskName 'Codex Server OpenAI Tunnel'
Get-ScheduledTaskInfo -TaskName 'Codex Server OpenAI Tunnel'
```

Server ports:

```bash
ssh myserver "ss -ltnp '( sport = :10808 or sport = :10809 )' || true"
```

Expected:

```text
127.0.0.1:10808
127.0.0.1:10809
```

Server route checks:

```bash
ssh myserver "set -a; . /root/codex-agent/agent.env; set +a; \
  printf 'auth '; curl -sS -o /tmp/auth-check.out -w '%{http_code} %{remote_ip} %{time_total}\n' https://auth.openai.com/api/accounts/deviceauth/usercode; \
  printf 'codex-get '; curl -sS -o /tmp/codex-get.out -w '%{http_code} %{remote_ip} %{time_total}\n' https://chatgpt.com/backend-api/codex/responses; \
  head -c 100 /tmp/codex-get.out; echo"
```

Expected:

```text
auth 405 127.0.0.1 ...
codex-get 405 127.0.0.1 ...
{"detail":"Method Not Allowed"}
```

`405` is good here. It means the endpoint is reachable and rejected only because
the health check uses GET instead of the real Codex WebSocket request.

Codex auth:

```bash
ssh myserver "set -a; . /root/codex-agent/agent.env; set +a; codex login status"
```

Expected:

```text
Logged in using ChatGPT
```

Short Codex smoke test:

```bash
ssh myserver "cd /srv/codex-agent/repos/chat && \
  set -a; . /root/codex-agent/agent.env; set +a; \
  printf '%s\n' 'Reply exactly: OK' | timeout 90s codex exec --sandbox read-only --color never -"
```

Expected final output:

```text
OK
```

## After Windows Reboot

1. Log into Windows.
2. Make sure the VPN route that works for ChatGPT/Codex is connected.
3. The scheduled task should start the tunnel automatically.
4. Check:

```powershell
Get-CimInstance Win32_Process -Filter "name = 'ssh.exe'" |
  Where-Object { $_.CommandLine -like '*127.0.0.1:10808*' -and $_.CommandLine -like '*myserver*' }
```

5. Check from server:

```powershell
ssh myserver "ss -ltnp '( sport = :10808 or sport = :10809 )' || true"
```

If `codex login status` still says `Logged in using ChatGPT`, no new login is
needed.

If it says `Not logged in`, repeat device auth.

## Troubleshooting

### `CONNECT tunnel failed, response 502`

The server HTTP proxy is alive, but it cannot reach the reverse SOCKS port.
Usually `127.0.0.1:10808` is missing on the server.

Fix:

```powershell
Start-ScheduledTask -TaskName 'Codex Server OpenAI Tunnel'
```

Then recheck `ss -ltnp` on the server.

### `Connection to 82.146.42.213 closed by remote host`

This is an SSH tunnel process exiting. With the self-restarting script it should
start again after a few seconds.

If a blue PowerShell window appears, an old visible task/process is still around.
The intended autostart path is hidden:

```text
wscript.exe -> hidden powershell.exe -> ssh.exe -R 127.0.0.1:10808 myserver
```

### `Logged in using an API key`

This means Codex is using API-key auth, which can incur separate OpenAI API
billing. To go back to ChatGPT Pro auth:

```bash
codex logout
set -a; . /root/codex-agent/agent.env; set +a
codex login --device-auth
systemctl restart codex-agent-linux.service
```

### `Not logged in`

Run device auth again:

```bash
set -a; . /root/codex-agent/agent.env; set +a
codex login --device-auth
systemctl restart codex-agent-linux.service
```

### Job fails with ChatGPT websocket `403`

Check the tunnel first. If `auth` and `codex-get` health checks return `405`,
the route is reachable. If jobs still get `403`, the current VPN/proxy route may
be blocked by ChatGPT/Cloudflare for the WebSocket request. Try a different VPN
server or another supported-region proxy route.

### PuTTY closed

Closing PuTTY should not stop `agent-linux`. The agent is a systemd service:

```bash
systemctl status codex-agent-linux.service
```

If a job stopped at the same time, the likely cause is the Windows reverse tunnel
or VPN dropping, not the PuTTY terminal itself.

## Stop The Tunnel

Temporarily stop autostart:

```powershell
Stop-ScheduledTask -TaskName 'Codex Server OpenAI Tunnel'
```

Kill current tunnel:

```powershell
Get-CimInstance Win32_Process -Filter "name = 'ssh.exe'" |
  Where-Object { $_.CommandLine -like '*127.0.0.1:10808*' -and $_.CommandLine -like '*myserver*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

Disable the task:

```powershell
Disable-ScheduledTask -TaskName 'Codex Server OpenAI Tunnel'
```

Enable it again:

```powershell
Enable-ScheduledTask -TaskName 'Codex Server OpenAI Tunnel'
Start-ScheduledTask -TaskName 'Codex Server OpenAI Tunnel'
```

## GitHub Push From Server Agent

The Ubuntu agent runs without an interactive GitHub credential prompt. HTTPS
remotes like `https://github.com/WizardJIOCb/chat.rodion.pro` can clone/read
public repos, but `git push` fails with:

```text
fatal: could not read Username for 'https://github.com': No such device or address
```

For Server Ubuntu projects, configure a writable SSH key instead:

```bash
ssh-keygen -t ed25519 -f /root/.ssh/codex_agent_github -C "codex-agent-linux@cyka.lol" -N ""
cat >> /root/.ssh/config <<'SSH'

Host github-codex
  HostName github.com
  User git
  IdentityFile ~/.ssh/codex_agent_github
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
SSH
chmod 600 /root/.ssh/config /root/.ssh/codex_agent_github
cat /root/.ssh/codex_agent_github.pub
```

Add that public key to GitHub as an account SSH key, or as a repository deploy
key with **Allow write access** enabled.

Then set this in `/root/codex-agent/agent.env` and restart the Linux agent:

```bash
CMC_GITHUB_SSH_HOST=github-codex
systemctl restart codex-agent-linux.service
```

With `CMC_GITHUB_SSH_HOST` set, the agent keeps normal GitHub URLs in the web UI
but uses `github-codex:owner/repo.git` internally for `git remote set-url` and
`git push`.
