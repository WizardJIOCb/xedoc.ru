import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  CheckCircle2,
  ChevronDown,
  CircleOff,
  Download,
  ExternalLink,
  Folder,
  Gauge,
  KeyRound,
  LoaderCircle,
  MonitorCog,
  Play,
  RefreshCw,
  Save,
  Server,
  Square,
  TerminalSquare,
  Wifi,
  WifiOff
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import "./styles.css";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

type AgentStatus = {
  configured: boolean;
  running: boolean;
  tokenConfigured: boolean;
  serverUrl: string;
  agentId: string;
  agentRoot: string;
  configPath: string;
  hostname: string;
  platform: string;
  lastError?: string;
  logs: string[];
};

type SettingsPayload = {
  serverUrl: string;
  agentId: string;
  agentRoot: string;
  token?: string;
};

type LiveAgentState = {
  title: string;
  detail: string;
  percent: number;
  tone: "idle" | "active" | "good" | "bad";
  spinning: boolean;
};

const DEFAULT_STATUS: AgentStatus = {
  configured: false,
  running: false,
  tokenConfigured: false,
  serverUrl: "wss://codex.rodion.pro/api/agent/ws",
  agentId: "home-windows",
  agentRoot: "",
  configPath: "",
  hostname: "",
  platform: "",
  logs: []
};

function isTauri() {
  return Boolean(window.__TAURI_INTERNALS__);
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    if (command === "get_status") return DEFAULT_STATUS as T;
    return undefined as T;
  }
  return invoke<T>(command, args);
}

function statusLabel(status: AgentStatus) {
  if (status.running) return "Online";
  if (status.configured) return "Ready";
  return "Setup needed";
}

function statusTone(status: AgentStatus) {
  if (status.running) return "good";
  if (status.configured) return "warn";
  return "bad";
}

function cleanAgentLogLine(line: string) {
  return line.replace(/^agent(?::error)?:\s*/, "").trim();
}

function inferLiveState(status: AgentStatus): LiveAgentState {
  if (!status.running) {
    return {
      title: status.lastError ? "Stopped with attention needed" : "Agent stopped",
      detail: status.lastError ?? "Start the agent to receive jobs and sync chats.",
      percent: status.lastError ? 100 : 0,
      tone: status.lastError ? "bad" : "idle",
      spinning: false
    };
  }

  const latest = [...status.logs].reverse().map(cleanAgentLogLine);
  const connectedLine = latest.find((line) => line.startsWith("Connected to "));

  for (const line of latest) {
    if (line.startsWith("Job failed:") || line.includes(" failed:")) {
      return {
        title: "Needs attention",
        detail: line,
        percent: 100,
        tone: "bad",
        spinning: false
      };
    }
    if (line.startsWith("Job finished:")) {
      return {
        title: "Job completed",
        detail: line,
        percent: 100,
        tone: "good",
        spinning: false
      };
    }
    if (line.includes("[progress]")) {
      const detail = line.replace(/^\[progress\]\s*/, "");
      return {
        title: liveTitle(detail),
        detail,
        percent: livePercent(detail),
        tone: "active",
        spinning: true
      };
    }
    if (line.startsWith("Incoming ")) {
      return {
        title: "Message received",
        detail: line,
        percent: 12,
        tone: "active",
        spinning: true
      };
    }
  }
  return {
    title: "Connected",
    detail: connectedLine ?? "Waiting for jobs and chat sync requests.",
    percent: 100,
    tone: "good",
    spinning: false
  };
}

function liveTitle(detail: string) {
  if (detail.startsWith("sync:") || detail.includes(" sync")) return "Syncing chats";
  if (detail.includes(" thinking")) return "Codex is thinking";
  if (detail.includes(" command:")) return "Running command";
  if (detail.includes(" finalizing:")) return "Finalizing";
  if (detail.startsWith("git:") || detail.includes(" git:")) return "Syncing git";
  if (detail.startsWith("deploy:") || detail.includes(" deploy:")) return "Deploying";
  if (detail.startsWith("scan:") || detail.includes(" scan:")) return "Scanning projects";
  return "Processing";
}

function livePercent(detail: string) {
  if (detail.includes("completed") || detail.includes("finished")) return 100;
  if (detail.includes("finalizing")) return 88;
  if (detail.includes("command")) return 62;
  if (detail.includes("thinking") || detail.includes("working")) return 42;
  if (detail.includes("started") || detail.includes("Starting")) return 18;
  if (detail.includes("sync")) return 55;
  return 28;
}

function App() {
  const [status, setStatus] = useState<AgentStatus>(DEFAULT_STATUS);
  const [serverUrl, setServerUrl] = useState(DEFAULT_STATUS.serverUrl);
  const [agentId, setAgentId] = useState(DEFAULT_STATUS.agentId);
  const [agentRoot, setAgentRoot] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [connectionOpen, setConnectionOpen] = useState(false);

  const tone = statusTone(status);
  const canStart = status.configured && !status.running;

  const recentLogs = useMemo(() => status.logs.slice(-18).reverse(), [status.logs]);
  const liveState = useMemo(() => inferLiveState(status), [status]);

  async function refresh() {
    const next = await call<AgentStatus>("get_status");
    setStatus(next);
    setServerUrl(next.serverUrl || DEFAULT_STATUS.serverUrl);
    setAgentId(next.agentId || DEFAULT_STATUS.agentId);
    setAgentRoot(next.agentRoot || "");
  }

  async function runAction(label: string, action: () => Promise<void>) {
    setBusy(true);
    setMessage("");
    try {
      await action();
      await refresh();
      setMessage(label);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <main className="shell">
      <section className="topbar">
        <div>
          <p className="eyebrow">codex.rodion.pro</p>
          <h1>Codex Agent</h1>
        </div>
        <div className={`pill ${tone}`}>
          {status.running ? <Wifi size={16} /> : <WifiOff size={16} />}
          {statusLabel(status)}
        </div>
      </section>

      <section className="status-grid">
        <article className="metric">
          <Server size={18} />
          <span>Server</span>
          <strong>{status.serverUrl || "Not configured"}</strong>
        </article>
        <article className="metric">
          <MonitorCog size={18} />
          <span>Machine</span>
          <strong>{status.hostname || "Local computer"}</strong>
        </article>
        <article className="metric">
          <KeyRound size={18} />
          <span>Token</span>
          <strong>{status.tokenConfigured ? "Available" : "Not saved"}</strong>
        </article>
      </section>

      <section className={`panel connection-panel ${connectionOpen ? "open" : "collapsed"}`}>
        <div className="panel-title">
          <h2>Connection</h2>
          <div className="panel-actions">
            <button className="icon-button" type="button" disabled={busy} onClick={() => void refresh()} title="Refresh">
              <RefreshCw size={17} />
            </button>
            <button
              className="icon-button"
              type="button"
              onClick={() => setConnectionOpen((value) => !value)}
              title={connectionOpen ? "Collapse connection settings" : "Expand connection settings"}
              aria-expanded={connectionOpen}
            >
              <ChevronDown className="collapse-icon" size={18} />
            </button>
          </div>
        </div>

        {connectionOpen ? (
          <div className="connection-body">
            <label>
              <span>Server WebSocket URL</span>
              <input value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} />
            </label>
            <label>
              <span>Agent ID</span>
              <input value={agentId} onChange={(event) => setAgentId(event.target.value)} />
            </label>
            <label>
              <span>Installed agent folder</span>
              <div className="input-with-icon">
                <Folder size={17} />
                <input
                  value={agentRoot}
                  onChange={(event) => setAgentRoot(event.target.value)}
                  placeholder="%USERPROFILE%\\codex-agent"
                />
              </div>
            </label>
            <label>
              <span>Agent token</span>
              <input
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder={status.tokenConfigured ? "Stored token is already configured" : "Paste setup token once"}
                type="password"
              />
            </label>

            <div className="actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => void runAction("Existing setup imported", () => call<void>("import_existing_setup"))}
              >
                <Download size={17} />
                Import existing setup
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void runAction("Settings saved", () =>
                    call<void>("save_settings", {
                      settings: { serverUrl, agentId, agentRoot, token: token || undefined } satisfies SettingsPayload
                    })
                  )
                }
              >
                <Save size={17} />
                Save
              </button>
              <button
                type="button"
                disabled={busy || !canStart}
                onClick={() => void runAction("Agent started", () => call<void>("start_agent"))}
              >
                <Play size={17} />
                Start
              </button>
              <button
                type="button"
                disabled={busy || !status.running}
                onClick={() => void runAction("Agent stopped", () => call<void>("stop_agent"))}
              >
                <Square size={17} />
                Stop
              </button>
              <button type="button" disabled={busy} onClick={() => void runAction("Web opened", () => call<void>("open_web"))}>
                <ExternalLink size={17} />
                Open web
              </button>
            </div>

            {message ? <p className="message">{message}</p> : null}
            {status.lastError ? <p className="error">{status.lastError}</p> : null}
          </div>
        ) : null}
      </section>

      <section className="panel logs-panel">
        <div className="panel-title">
          <h2>Agent log</h2>
          {status.running ? <CheckCircle2 className="ok" size={18} /> : <CircleOff className="muted" size={18} />}
        </div>
        <div className={`live-card ${liveState.tone}`}>
          <div className="live-icon">
            {liveState.spinning ? <LoaderCircle size={18} /> : <Gauge size={18} />}
          </div>
          <div className="live-copy">
            <strong>{liveState.title}</strong>
            <span>{liveState.detail}</span>
          </div>
          <div className="live-percent">{liveState.percent}%</div>
          <div className="live-track" aria-hidden="true">
            <div style={{ width: `${liveState.percent}%` }} />
          </div>
        </div>
        <div className="log-box">
          {recentLogs.length ? (
            recentLogs.map((line, index) => <pre key={`${line}-${index}`}>{line}</pre>)
          ) : (
            <div className="empty-log">
              <TerminalSquare size={20} />
              Agent output will appear here after start.
            </div>
          )}
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
