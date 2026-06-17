<img width="1675" height="1398" alt="Снимок экрана 2026-06-17 153456" src="https://github.com/user-attachments/assets/096443d3-7026-4d62-9798-0a496c4e0371" />
<img width="1671" height="1398" alt="Снимок экрана 2026-06-17 153412" src="https://github.com/user-attachments/assets/97032f6e-c50f-4b71-b40e-ecb4c0a2c474" />
<img width="1675" height="1401" alt="Снимок экрана 2026-06-17 153307" src="https://github.com/user-attachments/assets/b39adf74-d0e1-4209-9922-bf1e6d95bcf6" />


# xedoc.ru

`xedoc.ru` is a private web workbench for running Codex-driven development from a browser. The production site, GitHub repository, local workspace, and server folder now all use the `xedoc.ru` name.

## Canonical Project

- Production site: `https://xedoc.ru`
- GitHub repository: `https://github.com/WizardJIOCb/xedoc.ru`
- Local workspace on Windows: `C:\Projects\xedoc.ru`
- Production server alias: `myserver`
- Production server folder: `/var/www/xedoc.ru`
- Production service: `codex-controller.service`
- Production database: `/var/www/xedoc.ru/data/cmc.db`
- Nginx site: `/etc/nginx/sites-available/xedoc.ru`
- Primary Git remote: `origin -> https://github.com/WizardJIOCb/xedoc.ru.git`
- Legacy Git remote kept for history: `codex-origin -> https://github.com/WizardJIOCb/codex.rodion.pro`

Do new work from `C:\Projects\xedoc.ru`. Do not use old `codex.rodion.pro` folders for active development.

## What This App Does

- Shows a browser/PWA interface for projects, chats, jobs, live logs, files, diffs, profile, sync, and admin controls.
- Runs a Fastify API with SQLite storage on the VPS.
- Serves the built React/Vite frontend from the same server app.
- Accepts UI WebSocket connections at `/api/ui/ws`.
- Accepts agent WebSocket connections at `/api/agent/ws`.
- Lets configured agents run Codex CLI tasks only inside allowlisted project folders.
- Syncs local Codex and VS Code chats into the server database.
- Can package and install a compact Windows agent from the web UI.
- Supports OAuth providers, public project/profile pages, and public chat share links.

## Architecture

```text
Browser / PWA
  |
  | HTTPS + REST + /api/ui/ws
  v
VPS: nginx -> Fastify server -> SQLite
  ^
  | outbound WSS /api/agent/ws
  |
Windows or Linux agent
  |-- allowlisted project folders
  |-- Codex CLI jobs
  |-- Git / build / deploy helper commands
  |-- local Codex chat sync
  `-- VS Code bridge integration
```

The Windows agent does not need inbound ports. It connects outward to `https://xedoc.ru`.

## Repository Layout

```text
apps/
  agent-windows/   Node agent for Windows and compact agent package
  desktop-agent/   Tauri tray/manager app
  server/          Fastify API, auth, SQLite, WebSockets, static web serving
  vscode-bridge/   Local VS Code companion extension
  web/             React/Vite frontend
packages/
  protocol/        Zod schemas and shared protocol types
scripts/
  *.ps1            Windows helper scripts for agent, bridge, and tunnel setup
infra/
  docker-compose.yml
  Caddyfile
```

## Requirements

- Node.js LTS with `node` available in PATH
- Corepack
- pnpm through Corepack
- Git
- Codex CLI on machines that actually run Codex jobs
- Rust/Cargo only when building the native Tauri desktop agent

## Root Commands

Run these from `C:\Projects\xedoc.ru`.

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm build
corepack pnpm server:dev
corepack pnpm web:dev
corepack pnpm agent:dev
corepack pnpm server:seed
corepack pnpm server:agent
```

`pnpm build` builds `packages/protocol` and all apps. On the production server, use a larger Node heap:

```bash
NODE_OPTIONS=--max-old-space-size=4096 corepack pnpm build
```

## Environment

Example production-like `.env`:

```dotenv
NODE_ENV=production
PORT=3000
PUBLIC_BASE_URL=https://xedoc.ru
DATABASE_URL=file:/app/data/cmc.db
SESSION_SECRET=change_me_64_random_chars
COOKIE_DOMAIN=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
VK_CLIENT_ID=
VK_CLIENT_SECRET=
MAILRU_CLIENT_ID=
MAILRU_CLIENT_SECRET=
```

Current production uses:

```dotenv
NODE_ENV=production
PORT=3020
PUBLIC_BASE_URL=https://xedoc.ru
DATABASE_URL=file:/var/www/xedoc.ru/data/cmc.db
COOKIE_DOMAIN=
```

Keep real secrets only in `.env`. Do not commit `.env`, agent tokens, OAuth secrets, or database files.

## Local Development

Install dependencies:

```powershell
cd C:\Projects\xedoc.ru
corepack enable
corepack pnpm install --frozen-lockfile
```

Start the API server:

```powershell
$env:NODE_ENV="development"
$env:PORT="3000"
$env:PUBLIC_BASE_URL="http://localhost:3000"
$env:DATABASE_URL="file:C:\Projects\xedoc.ru\data\cmc.db"
$env:SESSION_SECRET="dev_secret_64_chars_minimum_change_me_please_123456"
corepack pnpm server:dev
```

Start the web app in another terminal:

```powershell
cd C:\Projects\xedoc.ru
corepack pnpm web:dev -- --port 5173
```

The Vite dev server proxies `/api` and WebSocket traffic to `http://localhost:3000`.

Health check:

```powershell
Invoke-WebRequest http://localhost:3000/api/health -UseBasicParsing
```

Create a local user:

```powershell
corepack pnpm --filter @cmc/server seed:user --email you@example.com --password "change-me"
```

Create or rotate an agent token:

```powershell
corepack pnpm --filter @cmc/server agents:create --id home-windows --name "Home Windows"
corepack pnpm --filter @cmc/server agents:rotate-token --id home-windows
```

## Production

Current production folder:

```text
/var/www/xedoc.ru
```

Current systemd unit shape:

```ini
[Service]
WorkingDirectory=/var/www/xedoc.ru
EnvironmentFile=/var/www/xedoc.ru/.env
ExecStart=/usr/bin/node --no-warnings=ExperimentalWarning apps/server/dist/index.js
Restart=always
```

Nginx serves `xedoc.ru` and `www.xedoc.ru`, terminates TLS, and proxies to the Node server:

```text
https://xedoc.ru -> 127.0.0.1:3020
```

Deploy production from the local machine:

```powershell
git push origin master
ssh myserver "set -e; cd /var/www/xedoc.ru; git pull --ff-only; corepack pnpm install --frozen-lockfile; NODE_OPTIONS=--max-old-space-size=4096 corepack pnpm build; systemctl restart codex-controller.service; systemctl is-active codex-controller.service"
```

Smoke checks:

```powershell
Invoke-WebRequest https://xedoc.ru/api/health -UseBasicParsing
Invoke-WebRequest https://xedoc.ru -UseBasicParsing
```

Useful server commands:

```bash
cd /var/www/xedoc.ru
git status --short --branch
systemctl status codex-controller.service --no-pager
journalctl -u codex-controller.service -n 100 --no-pager
nginx -t
systemctl reload nginx
```

Before manual database edits on production, make a backup:

```bash
cd /var/www/xedoc.ru
sqlite3 data/cmc.db 'PRAGMA wal_checkpoint(TRUNCATE);'
cp data/cmc.db "data/cmc.db.bak-$(date +%Y%m%d-%H%M%S)"
```

## Codex Project Settings

The `Codex` project inside the web UI should point to the current canonical locations:

```text
Name: Codex
Local folder: C:\Projects\xedoc.ru
GitHub repository: https://github.com/WizardJIOCb/xedoc.ru
Server project folder: /var/www/xedoc.ru
Domain: xedoc.ru
Data location: Server
Data folder: /var/www/xedoc.ru/data
```

For the controller itself, production deploy is the manual server deploy command above. The generic UI Deploy action is mainly for ordinary static/full-stack projects with a configured build output folder.

## Windows Agent

Example config:

```text
apps/agent-windows/agent.config.example.json
```

Important fields:

- `agentId`: server-side agent id, for example `home-windows`.
- `serverUrl`: `wss://xedoc.ru/api/agent/ws` in production.
- `tokenEnv`: environment variable that contains the agent token, usually `CMC_AGENT_TOKEN`.
- `fakeRunner`: test mode without real Codex CLI execution.
- `repos`: allowlist of project folders the agent can work with.
- `defaultSandbox` and `allowedSandboxes`: sandbox choices exposed to the UI.
- `testCommands`: visible project check commands.
- `redactPatterns`: secret masks for logs.

Local dev run:

```powershell
Copy-Item apps/agent-windows/agent.config.example.json apps/agent-windows/agent.config.json
$env:CMC_AGENT_TOKEN="token_from_agents_create"
corepack pnpm --filter @cmc/agent-windows dev -- --config apps/agent-windows/agent.config.json
```

Doctor and repo scan:

```powershell
corepack pnpm --filter @cmc/agent-windows doctor -- --config apps/agent-windows/agent.config.json
corepack pnpm --filter @cmc/agent-windows scan-repos -- --config apps/agent-windows/agent.config.json
```

Installed compact agent location on Windows:

```text
%USERPROFILE%\codex-agent
```

Start and stop installed agent:

```powershell
%USERPROFILE%\codex-agent\start-agent.bat
%USERPROFILE%\codex-agent\stop-agent.bat
```

Start and stop the repo-local agent:

```powershell
C:\Projects\xedoc.ru\start-agent.bat
C:\Projects\xedoc.ru\stop-agent.bat
```

Repo-local logs:

```text
C:\Projects\xedoc.ru\data\prod-agent.log
C:\Projects\xedoc.ru\data\prod-agent.err.log
```

## Compact Agent Package

Production exposes the compact agent package here:

```text
GET https://xedoc.ru/api/agent/package.zip
```

The package contains only runtime/build artifacts needed by the agent:

- root `package.json`, lockfile, and workspace file
- `start-agent.bat` and `stop-agent.bat`
- `scripts/run-agent.ps1`
- `scripts/prepare-vscode-bridge.ps1`
- `apps/agent-windows/dist`
- `apps/vscode-bridge/dist`
- `apps/vscode-bridge/resources`
- `packages/protocol/dist`

The Sync page can generate a personal `setup-agent.bat`. It downloads the package, writes `agent.config.json`, saves `CMC_AGENT_TOKEN` to the user environment, and starts the agent.

## VS Code Bridge

The VS Code bridge lives in `apps/vscode-bridge`. It installs a local extension and exposes a named pipe used by the Windows agent.

Install or refresh it:

```powershell
cd C:\Projects\xedoc.ru
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\prepare-vscode-bridge.ps1
```

If VS Code was already open during first install, run:

```text
Developer: Reload Window
```

The bridge can:

- ping the local VS Code extension
- open Codex sidebar or a new Codex panel
- open or reopen a local Codex thread by id
- show the separate Activity Bar panel `xedoc.ru -> Chats`
- export local Codex threads as public share links through the server

## Chats And Sync

Chat sources:

- `web`: chats created in the xedoc.ru UI.
- `codex`: local Codex CLI session files from the Windows profile.
- `vscode`: local VS Code chat/session data.

Sync endpoint:

```text
POST /api/agents/:agentId/sync-local-chats
```

The endpoint responds quickly with `202 Accepted`; the actual sync happens through the agent WebSocket.

Public shares:

- `POST /api/chats/:id/share`
- `GET /api/shared/chats/:token`
- `POST /api/agent/shared-chats`
- `/share/<token>` renders the public page.

## Server API

Main endpoint groups:

- Auth/profile: `/api/login`, `/api/register`, `/api/logout`, `/api/me`, `/api/profile`
- OAuth: `/api/oauth/providers`, `/api/oauth/:provider/start`, `/api/oauth/:provider/callback`
- Agents: `/api/agents`, `/api/agents/:agentId/setup`, `/api/agent/package.zip`
- Projects: `/api/repos`, `/api/projects`, `/api/projects/:agentId/:repoId`
- Project actions: `git-sync`, `build`, `deploy`, `nginx`, `ssl`
- VS Code: `/api/agents/:agentId/vscode-command`
- Chat sync: `/api/agents/:agentId/sync-local-chats`
- Chats/messages: `/api/chats`, `/api/chats/:id`, attachments/details endpoints
- Public shares: `/api/chats/:id/share`, `/api/shared/chats/:token`, `/api/agent/shared-chats`
- Jobs: `/api/jobs`, `/api/jobs/:id`, `/api/jobs/:id/cancel`
- WebSockets: `/api/ui/ws`, `/api/agent/ws`
- Health: `/api/health`

## Native Desktop Agent

The native desktop app lives in `apps/desktop-agent`. It is a Tauri tray/manager shell around the compact Node agent package.

Dev and build commands:

```powershell
.\start-native-agent.bat
.\start-native-agent.bat check
.\start-native-agent.bat dev
.\start-native-agent.bat release
.\build-native-agent.bat
```

Built executable:

```text
dist-native\CodexAgent.exe
```

For everyday start/stop, prefer `start-agent.bat` and `stop-agent.bat`; the native Tauri app is heavier and needs Rust/Cargo.

## Docker And Caddy

The Docker/Caddy setup is secondary. Production currently uses systemd + nginx, not Docker.

`infra/docker-compose.yml` builds `apps/server/Dockerfile`, loads `../.env`, stores SQLite in a Docker volume, and exposes the server on localhost.

`infra/Caddyfile` reverse-proxies `xedoc.ru` to the app.

## Checks Before Commit

```powershell
cd C:\Projects\xedoc.ru
git status --short --branch
git diff --check
corepack pnpm typecheck
corepack pnpm build
```

Focused checks:

```powershell
corepack pnpm --filter @cmc/server typecheck
corepack pnpm --filter @cmc/web typecheck
corepack pnpm --filter @cmc/agent-windows typecheck
corepack pnpm --filter @cmc/vscode-bridge typecheck
```

## Security Notes

- Keep all agent/project execution allowlisted.
- Do not add arbitrary shell execution endpoints.
- Do not log secrets, tokens, cookies, or full environment variables.
- Validate WebSocket payloads with Zod schemas from `packages/protocol`.
- Prefer child process argument arrays and avoid shell string composition.
- Keep Windows agent networking outbound-only.
- Keep `COOKIE_DOMAIN` empty for host-only cookies while user projects live on `*.xedoc.ru`.
- Use HTTPS in production.
- Use long random `SESSION_SECRET` values in production.

## Legacy Names

`codex.rodion.pro` may still appear in compatibility code, historical remotes, old backups, or old browser sessions. New repository, docs, project settings, deploy commands, and production folder should use `xedoc.ru`.
