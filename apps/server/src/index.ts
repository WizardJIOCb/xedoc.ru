import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createHash, createHmac } from "node:crypto";
import { join, resolve } from "node:path";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import bcrypt from "bcryptjs";
import {
  AgentToServerSchema,
  AgentChatSyncSchema,
  ChatMessageSchema,
  CreateAgentSchema,
  CreateChatSchema,
  DeploySchema,
  GitSyncSchema,
  CreateJobSchema,
  CreateProjectSchema,
  CreateUserSchema,
  NginxSchema,
  ProjectFileListQuerySchema,
  PasswordUpdateSchema,
  ProjectFileReadQuerySchema,
  ProjectFileWriteSchema,
  ProfileUpdateSchema,
  RegisterSchema,
  SslSchema,
  UpdateChatSchema,
  UpdateProjectSchema,
  VscodeCommandRequestSchema,
  type AgentToServer,
  type DeployConfig,
  type LocalCodexActivity,
  type ProjectDataConfig,
  type ProjectVisibility,
  type RepoInfo,
  type ServerToAgent,
  type UiEvent
} from "@cmc/protocol";
import { loadConfig } from "./config.js";
import {
  id,
  mapRepo,
  nowIso,
  openDb,
  parseCodexUsage,
  parseLocalActivity,
  type AgentRow,
  type AttachmentRow,
  type ChatAttachmentRow,
  type ChatMessageRow,
  type ChatRow,
  type ChatShareRow,
  type JobRow,
  type LogRow,
  type OAuthConnectionRow,
  type OAuthStateRow,
  type RepoRow,
  type UserRow
} from "./db.js";
import {
  clearSessionCookie,
  createSession,
  getSession,
  hashSecret,
  randomToken,
  requireAuth,
  requireCsrf,
  setSessionCookie,
  verifySecret
} from "./auth.js";

const config = loadConfig();
const db = openDb(config.databasePath);
const AGENT_OFFLINE_GRACE_MS = 8000;
const WEBSOCKET_MAX_PAYLOAD_BYTES = 10 * 1024 * 1024;
const REGISTRATION_GATE_COOKIE = "cmc_registration_gate";
const REGISTRATION_GATE_VALUE = "sure";
const PUBLIC_DOMAIN = "xedoc.ru";
const LEGACY_PUBLIC_DOMAIN = "codex.rodion.pro";
const WEB_ACTIVITY_SOURCES = new Set([PUBLIC_DOMAIN, LEGACY_PUBLIC_DOMAIN]);
const OWNER_ADMIN_EMAIL = process.env.OWNER_ADMIN_EMAIL ?? "rodion89@list.ru";

type AgentConnection = {
  id: string;
  connectionId: string;
  send: (message: ServerToAgent) => void;
  close: () => void;
};

const agents = new Map<string, AgentConnection>();
const dispatchingAgents = new Set<string>();
type AuthUser = Pick<UserRow, "id" | "role">;
type SyncedChat = Extract<AgentToServer, { type: "chat.sync" }>;
type SyncedChatMessage = SyncedChat["messages"][number];
const uiClients = new Set<{ user: AuthUser; send: (event: UiEvent) => void }>();
type OAuthProviderId = "google" | "github" | "vk" | "mailru";
const oauthProviderIds: OAuthProviderId[] = ["google", "vk"];
const CODEX_CONTEXT_TAGS = [
  "environment_context",
  "permissions instructions",
  "collaboration_mode",
  "apps_instructions",
  "skills_instructions",
  "plugins_instructions"
];
type OAuthProfile = {
  provider: OAuthProviderId;
  providerUserId: string;
  email: string;
  displayName?: string;
};

function isWebActivitySource(source: string | undefined | null): boolean {
  return Boolean(source && WEB_ACTIVITY_SOURCES.has(source));
}
type PublicProjectRow = RepoRow & {
  author_id: string;
  author_email: string;
  author_nickname: string | null;
  author_avatar_data_url: string | null;
  author_bio: string | null;
  author_created_at: string;
  chat_count: number;
};
type AdminChatRow = ChatRow & {
  agent_name: string;
  repo_name: string | null;
  message_count: number;
  job_count: number;
};
const projectRequests = new Map<string, {
  resolve: (value: Extract<AgentToServer, { type: "project.result" }>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  agentId: string;
  connectionId: string;
}>();
const gitRequests = new Map<string, {
  resolve: (value: Extract<AgentToServer, { type: "git.result" }>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  agentId: string;
  connectionId: string;
}>();
const deployRequests = new Map<string, {
  resolve: (value: Extract<AgentToServer, { type: "deploy.result" }>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  agentId: string;
  connectionId: string;
}>();
const projectCommandRequests = new Map<string, {
  resolve: (value: Extract<AgentToServer, { type: "project.command.result" }>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  agentId: string;
  connectionId: string;
}>();
const nginxRequests = new Map<string, {
  resolve: (value: Extract<AgentToServer, { type: "nginx.result" }>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  agentId: string;
  connectionId: string;
}>();
const sslRequests = new Map<string, {
  resolve: (value: Extract<AgentToServer, { type: "ssl.result" }>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  agentId: string;
  connectionId: string;
}>();
const vscodeRequests = new Map<string, {
  resolve: (value: Extract<AgentToServer, { type: "vscode.result" }>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  agentId: string;
  connectionId: string;
}>();
const fileRequests = new Map<string, {
  resolve: (value: Extract<AgentToServer, { type: "file.result" }>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  agentId: string;
  connectionId: string;
}>();
const chatSyncRequests = new Map<string, {
  resolve: (value: Extract<AgentToServer, { type: "chat.sync.result" }>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}>();
const STALE_JOB_GRACE_MS = 2 * 60 * 1000;
const AgentChatShareSchema = AgentChatSyncSchema.extend({
  messages: ChatMessageSchema.array().max(1000)
});

db.prepare("UPDATE agents SET status = 'offline', current_job_id = NULL").run();

function isAdmin(user: AuthUser): boolean {
  return user.role === "admin";
}

function agentAccessWhere(user: AuthUser): string {
  return isAdmin(user) ? "" : "WHERE user_id = ?";
}

function agentAccessArgs(user: AuthUser): string[] {
  return isAdmin(user) ? [] : [user.id];
}

function canAccessAgent(user: AuthUser, agentId: string): boolean {
  if (isAdmin(user)) return true;
  const row = db.prepare("SELECT 1 FROM agents WHERE id = ? AND user_id = ?").get(agentId, user.id) as { 1: number } | undefined;
  return Boolean(row);
}

function requireAdminUser(auth: { user: UserRow }, reply: FastifyReply): boolean {
  if (auth.user.role === "admin") return true;
  reply.code(403).send({ error: "admin_required" });
  return false;
}

function isOAuthProvider(value: string): value is OAuthProviderId {
  return oauthProviderIds.includes(value as OAuthProviderId);
}

function publicOrigin(request: { protocol: string; hostname: string }): string {
  if (config.publicBaseUrl) return config.publicBaseUrl.replace(/\/+$/, "");
  return `${request.protocol}://${request.hostname}`;
}

function registrationGateToken(): string {
  return createHmac("sha256", config.sessionSecret)
    .update(`registration:${REGISTRATION_GATE_VALUE}`)
    .digest("base64url");
}

function setRegistrationGateCookie(reply: FastifyReply): void {
  reply.setCookie(REGISTRATION_GATE_COOKIE, registrationGateToken(), {
    httpOnly: true,
    secure: config.nodeEnv === "production",
    sameSite: "lax",
    path: "/",
    domain: config.cookieDomain,
    maxAge: 30 * 60
  });
}

function clearRegistrationGateCookie(reply: FastifyReply): void {
  reply.clearCookie(REGISTRATION_GATE_COOKIE, { path: "/", domain: config.cookieDomain });
}

function hasRegistrationGateCookie(request: { cookies: Record<string, string | undefined> }): boolean {
  return request.cookies[REGISTRATION_GATE_COOKIE] === registrationGateToken();
}

function oauthEnvPrefix(provider: OAuthProviderId): string {
  return provider === "mailru" ? "MAILRU" : provider.toUpperCase();
}

function oauthClient(provider: OAuthProviderId): { clientId: string; clientSecret: string } | null {
  const prefix = oauthEnvPrefix(provider);
  const clientId = process.env[`${prefix}_CLIENT_ID`];
  const clientSecret = process.env[`${prefix}_CLIENT_SECRET`];
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

function oauthRedirectUri(request: { protocol: string; hostname: string }, provider: OAuthProviderId): string {
  return `${publicOrigin(request)}/api/oauth/${provider}/callback`;
}

function pkceVerifier(): string {
  return randomToken("pkce").replace(/^pkce_/, "");
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function oauthAuthorizeUrl(provider: OAuthProviderId, clientId: string, redirectUri: string, state: string, codeChallenge?: string): string {
  const urls: Record<OAuthProviderId, string> = {
    google: "https://accounts.google.com/o/oauth2/v2/auth",
    github: "https://github.com/login/oauth/authorize",
    vk: "https://id.vk.ru/authorize",
    mailru: "https://oauth.mail.ru/login"
  };
  const url = new URL(urls[provider]);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  if (provider === "google") {
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("prompt", "select_account");
  }
  if (provider === "github") url.searchParams.set("scope", "read:user user:email");
  if (provider === "vk") {
    url.searchParams.set("scope", "vkid.personal_info email");
    if (codeChallenge) {
      url.searchParams.set("code_challenge", codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
    }
  }
  if (provider === "mailru") url.searchParams.set("scope", "userinfo");
  return url.toString();
}

function oauthProviders(userId?: string) {
  const rows = userId ? db.prepare("SELECT * FROM oauth_connections WHERE user_id = ?").all(userId) as OAuthConnectionRow[] : [];
  const byProvider = new Map(rows.map((row) => [row.provider, row]));
  return oauthProviderIds.map((provider) => {
    const row = byProvider.get(provider);
    return {
      provider,
      connected: Boolean(row),
      displayName: row?.display_name,
      connectedAt: row?.connected_at,
      configured: Boolean(oauthClient(provider))
    };
  });
}

function serializeUser(user: UserRow) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    nickname: user.nickname,
    bio: user.bio,
    avatarDataUrl: user.avatar_data_url,
    blockedAt: user.blocked_at,
    createdAt: user.created_at,
    updatedAt: user.updated_at
  };
}

function publicProfileSlug(user: Pick<UserRow, "id" | "nickname">) {
  return user.nickname?.trim() || user.id;
}

function publicProfileUrl(request: { protocol: string; hostname: string }, user: Pick<UserRow, "id" | "nickname">): string {
  return `${publicOrigin(request)}/u/${encodeURIComponent(publicProfileSlug(user))}`;
}

function markUserActivity(userId: string): void {
  const stamp = nowIso();
  const day = stamp.slice(0, 10);
  db.prepare(`
    INSERT INTO user_activity_days (user_id,day,last_seen_at)
    VALUES (?,?,?)
    ON CONFLICT(user_id, day) DO UPDATE SET last_seen_at=excluded.last_seen_at
  `).run(userId, day, stamp);
}

function profileStats(user: AuthUser) {
  const agentFilter = isAdmin(user) ? "" : "AND a.user_id = ?";
  const args = isAdmin(user) ? [] : [user.id];
  const chatStats = db.prepare(`
    SELECT COUNT(*) AS chats
    FROM chats c
    JOIN agents a ON a.id = c.agent_id
    WHERE 1=1 ${agentFilter}
  `).get(...args) as { chats: number };
  const jobStats = db.prepare(`
    SELECT
      COUNT(*) AS jobs,
      SUM(CASE WHEN j.status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN j.status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE
        WHEN j.finished_at IS NOT NULL THEN
          MAX(0, CAST(ROUND((julianday(j.finished_at) - julianday(COALESCE(j.started_at, j.created_at))) * 86400) AS INTEGER))
        ELSE 0
      END) AS seconds
    FROM jobs j
    JOIN agents a ON a.id = j.agent_id
    WHERE 1=1 ${agentFilter}
  `).get(...args) as { jobs: number; completed: number | null; failed: number | null; seconds: number | null };
  const repoStats = db.prepare(`
    SELECT COUNT(*) AS projects
    FROM repos r
    JOIN agents a ON a.id = r.agent_id
    WHERE 1=1 ${agentFilter}
  `).get(...args) as { projects: number };
  return {
    chats: chatStats.chats,
    jobs: jobStats.jobs,
    completedJobs: jobStats.completed ?? 0,
    failedJobs: jobStats.failed ?? 0,
    projects: repoStats.projects,
    generationSeconds: jobStats.seconds ?? 0
  };
}

function adminUserStats(userId: string) {
  return profileStats({ id: userId, role: "user" });
}

function serializeAdminUser(user: UserRow) {
  const stats = adminUserStats(user.id);
  const agentStats = db.prepare("SELECT COUNT(*) AS agents FROM agents WHERE user_id = ?").get(user.id) as { agents: number };
  const lastActive = db.prepare("SELECT MAX(last_seen_at) AS lastActiveAt FROM user_activity_days WHERE user_id = ?")
    .get(user.id) as { lastActiveAt: string | null };
  return {
    ...serializeUser(user),
    agents: agentStats.agents,
    stats,
    lastActiveAt: lastActive.lastActiveAt
  };
}

function serializePublicProfile(user: UserRow, request: { protocol: string; hostname: string }) {
  const publicProjects = db.prepare(`
    SELECT COUNT(*) AS count
    FROM repos r
    JOIN agents a ON a.id = r.agent_id
    WHERE a.user_id = ? AND r.visibility = 'public'
  `).get(user.id) as { count: number };
  return {
    id: user.id,
    email: user.email,
    nickname: user.nickname,
    bio: user.bio,
    avatarDataUrl: user.avatar_data_url,
    createdAt: user.created_at,
    updatedAt: user.updated_at,
    profileSlug: publicProfileSlug(user),
    profileUrl: publicProfileUrl(request, user),
    stats: profileStats({ id: user.id, role: "user" }),
    publicProjects: publicProjects.count
  };
}

function publicChatSummaries(agentId: string, repoId: string, limit = 5) {
  const rows = db.prepare(`
    SELECT * FROM chats
    WHERE agent_id = ? AND repo_id = ? AND hidden_at IS NULL
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(agentId, repoId, limit) as ChatRow[];
  return rows.map(serializeChat);
}

function serializePublicProject(row: PublicProjectRow, request: { protocol: string; hostname: string }) {
  const author = {
    id: row.author_id,
    email: row.author_email,
    nickname: row.author_nickname,
    bio: row.author_bio,
    avatarDataUrl: row.author_avatar_data_url,
    createdAt: row.author_created_at,
    profileSlug: row.author_nickname || row.author_id,
    profileUrl: publicProfileUrl(request, { id: row.author_id, nickname: row.author_nickname })
  };
  return {
    id: row.id,
    agentId: row.agent_id,
    name: row.name,
    domain: row.domain,
    githubUrl: row.github_url,
    visibility: row.visibility,
    currentBranch: row.current_branch,
    dirty: row.dirty === 1,
    updatedAt: row.updated_at,
    url: projectUrlFromDomain(row.domain),
    chatCount: row.chat_count,
    author,
    latestChats: publicChatSummaries(row.agent_id, row.id)
  };
}

function adminStatsSeries(days = 30) {
  const safeDays = Math.max(7, Math.min(120, Math.floor(days)));
  const today = new Date(nowIso().slice(0, 10));
  const dayKeys = Array.from({ length: safeDays }, (_, index) => {
    const date = new Date(today);
    date.setUTCDate(today.getUTCDate() - (safeDays - index - 1));
    return date.toISOString().slice(0, 10);
  });
  const activityStart = new Date(dayKeys[0] ?? today.toISOString().slice(0, 10));
  activityStart.setUTCDate(activityStart.getUTCDate() - 30);
  const activityRows = db.prepare("SELECT user_id, day FROM user_activity_days WHERE day >= ?")
    .all(activityStart.toISOString().slice(0, 10)) as Array<{ user_id: string; day: string }>;
  const registrations = db.prepare(`
    SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS count
    FROM users
    WHERE created_at >= ?
    GROUP BY day
  `).all(dayKeys[0] ?? "1970-01-01") as Array<{ day: string; count: number }>;
  const registrationsByDay = new Map(registrations.map((row) => [row.day, row.count]));
  const activeByDay = new Map<string, Set<string>>();
  for (const row of activityRows) {
    const set = activeByDay.get(row.day) ?? new Set<string>();
    set.add(row.user_id);
    activeByDay.set(row.day, set);
  }
  const activeUsersInRange = (endDay: string, length: number) => {
    const end = new Date(endDay);
    const start = new Date(end);
    start.setUTCDate(end.getUTCDate() - (length - 1));
    const users = new Set<string>();
    for (const row of activityRows) {
      if (row.day >= start.toISOString().slice(0, 10) && row.day <= endDay) users.add(row.user_id);
    }
    return users.size;
  };
  return dayKeys.map((day) => ({
    day,
    dau: activeByDay.get(day)?.size ?? 0,
    wau: activeUsersInRange(day, 7),
    mau: activeUsersInRange(day, 30),
    registrations: registrationsByDay.get(day) ?? 0
  }));
}

function visibleAgentIds(user: AuthUser): string[] {
  const rows = isAdmin(user)
    ? db.prepare("SELECT id FROM agents").all() as Array<{ id: string }>
    : db.prepare("SELECT id FROM agents WHERE user_id = ?").all(user.id) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

function canAccessRepo(user: AuthUser, agentId: string, repoId: string): boolean {
  const row = db.prepare(`
    SELECT 1 FROM repos r
    JOIN agents a ON a.id = r.agent_id
    WHERE r.agent_id = ? AND r.id = ? ${isAdmin(user) ? "" : "AND a.user_id = ?"}
  `).get(agentId, repoId, ...(isAdmin(user) ? [] : [user.id])) as { 1: number } | undefined;
  return Boolean(row);
}

function canAccessChat(user: AuthUser, chatId: string): boolean {
  const row = db.prepare(`
    SELECT 1 FROM chats c
    JOIN agents a ON a.id = c.agent_id
    WHERE c.id = ? ${isAdmin(user) ? "" : "AND a.user_id = ?"}
  `).get(chatId, ...(isAdmin(user) ? [] : [user.id])) as { 1: number } | undefined;
  return Boolean(row);
}

function canAccessJob(user: AuthUser, jobId: string): boolean {
  const row = db.prepare(`
    SELECT 1 FROM jobs j
    JOIN agents a ON a.id = j.agent_id
    WHERE j.id = ? ${isAdmin(user) ? "" : "AND a.user_id = ?"}
  `).get(jobId, ...(isAdmin(user) ? [] : [user.id])) as { 1: number } | undefined;
  return Boolean(row);
}

function eventAgentId(event: UiEvent): string | undefined {
  if ("agentId" in event) return event.agentId;
  if ("jobId" in event) {
    const row = db.prepare("SELECT agent_id FROM jobs WHERE id = ?").get(event.jobId) as { agent_id: string } | undefined;
    return row?.agent_id;
  }
  return undefined;
}

function broadcast(event: UiEvent): void {
  const agentId = eventAgentId(event);
  for (const client of uiClients) {
    if (agentId && !canAccessAgent(client.user, agentId)) continue;
    client.send(event);
  }
}

function sendAgent(agentId: string, message: ServerToAgent): boolean {
  const agent = agents.get(agentId);
  if (!agent) return false;
  try {
    agent.send(message);
    return true;
  } catch {
    if (agents.get(agentId)?.connectionId === agent.connectionId) agents.delete(agentId);
    return false;
  }
}

function requestAgentProject(
  agentId: string,
  message: Extract<ServerToAgent, { type: "project.create" | "project.update" | "project.delete" }>
): Promise<Extract<AgentToServer, { type: "project.result" }>> {
  const agent = agents.get(agentId);
  if (!agent) return Promise.reject(new Error("agent_offline"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      projectRequests.delete(message.requestId);
      reject(new Error("agent_timeout"));
    }, 30000);
    projectRequests.set(message.requestId, { resolve, reject, timer, agentId, connectionId: agent.connectionId });
    try {
      agent.send(message);
    } catch (error) {
      clearTimeout(timer);
      projectRequests.delete(message.requestId);
      reject(error instanceof Error ? error : new Error("agent_send_failed"));
    }
  });
}

function requestAgentGit(
  agentId: string,
  message: Extract<ServerToAgent, { type: "git.sync" }>
): Promise<Extract<AgentToServer, { type: "git.result" }>> {
  const agent = agents.get(agentId);
  if (!agent) return Promise.reject(new Error("agent_offline"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      gitRequests.delete(message.requestId);
      reject(new Error("agent_timeout"));
    }, 120000);
    gitRequests.set(message.requestId, { resolve, reject, timer, agentId, connectionId: agent.connectionId });
    try {
      agent.send(message);
    } catch (error) {
      clearTimeout(timer);
      gitRequests.delete(message.requestId);
      reject(error instanceof Error ? error : new Error("agent_send_failed"));
    }
  });
}

function requestAgentDeploy(
  agentId: string,
  message: Extract<ServerToAgent, { type: "project.deploy" }>
): Promise<Extract<AgentToServer, { type: "deploy.result" }>> {
  const agent = agents.get(agentId);
  if (!agent) return Promise.reject(new Error("agent_offline"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      deployRequests.delete(message.requestId);
      reject(new Error("agent_timeout"));
    }, 300000);
    deployRequests.set(message.requestId, { resolve, reject, timer, agentId, connectionId: agent.connectionId });
    try {
      agent.send(message);
    } catch (error) {
      clearTimeout(timer);
      deployRequests.delete(message.requestId);
      reject(error instanceof Error ? error : new Error("agent_send_failed"));
    }
  });
}

function requestAgentProjectCommand(
  agentId: string,
  message: Extract<ServerToAgent, { type: "project.command" }>
): Promise<Extract<AgentToServer, { type: "project.command.result" }>> {
  const agent = agents.get(agentId);
  if (!agent) return Promise.reject(new Error("agent_offline"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      projectCommandRequests.delete(message.requestId);
      reject(new Error("agent_timeout"));
    }, 300000);
    projectCommandRequests.set(message.requestId, { resolve, reject, timer, agentId, connectionId: agent.connectionId });
    try {
      agent.send(message);
    } catch (error) {
      clearTimeout(timer);
      projectCommandRequests.delete(message.requestId);
      reject(error instanceof Error ? error : new Error("agent_send_failed"));
    }
  });
}

function requestAgentNginx(
  agentId: string,
  message: Extract<ServerToAgent, { type: "project.nginx" }>
): Promise<Extract<AgentToServer, { type: "nginx.result" }>> {
  const agent = agents.get(agentId);
  if (!agent) return Promise.reject(new Error("agent_offline"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      nginxRequests.delete(message.requestId);
      reject(new Error("agent_timeout"));
    }, 120000);
    nginxRequests.set(message.requestId, { resolve, reject, timer, agentId, connectionId: agent.connectionId });
    try {
      agent.send(message);
    } catch (error) {
      clearTimeout(timer);
      nginxRequests.delete(message.requestId);
      reject(error instanceof Error ? error : new Error("agent_send_failed"));
    }
  });
}

function requestAgentSsl(
  agentId: string,
  message: Extract<ServerToAgent, { type: "project.ssl" }>
): Promise<Extract<AgentToServer, { type: "ssl.result" }>> {
  const agent = agents.get(agentId);
  if (!agent) return Promise.reject(new Error("agent_offline"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      sslRequests.delete(message.requestId);
      reject(new Error("agent_timeout"));
    }, 300000);
    sslRequests.set(message.requestId, { resolve, reject, timer, agentId, connectionId: agent.connectionId });
    try {
      agent.send(message);
    } catch (error) {
      clearTimeout(timer);
      sslRequests.delete(message.requestId);
      reject(error instanceof Error ? error : new Error("agent_send_failed"));
    }
  });
}

function requestAgentVscode(
  agentId: string,
  message: Extract<ServerToAgent, { type: "vscode.command" }>
): Promise<Extract<AgentToServer, { type: "vscode.result" }>> {
  const agent = agents.get(agentId);
  if (!agent) return Promise.reject(new Error("agent_offline"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      vscodeRequests.delete(message.requestId);
      reject(new Error("agent_timeout"));
    }, 30000);
    vscodeRequests.set(message.requestId, { resolve, reject, timer, agentId, connectionId: agent.connectionId });
    agent.send(message);
  });
}

function requestAgentFile(
  agentId: string,
  message: Extract<ServerToAgent, { type: "file.list" | "file.read" | "file.write" }>
): Promise<Extract<AgentToServer, { type: "file.result" }>> {
  const agent = agents.get(agentId);
  if (!agent) return Promise.reject(new Error("agent_offline"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      fileRequests.delete(message.requestId);
      reject(new Error("agent_timeout"));
    }, 30000);
    fileRequests.set(message.requestId, { resolve, reject, timer, agentId, connectionId: agent.connectionId });
    try {
      agent.send(message);
    } catch (error) {
      clearTimeout(timer);
      fileRequests.delete(message.requestId);
      reject(error instanceof Error ? error : new Error("agent_send_failed"));
    }
  });
}

function rejectAgentRequestMap(
  requests: Map<string, { reject: (error: Error) => void; timer: NodeJS.Timeout; agentId: string; connectionId: string }>,
  agentId: string,
  connectionId: string,
  reason: string
): void {
  for (const [requestId, pending] of requests) {
    if (pending.agentId !== agentId || pending.connectionId !== connectionId) continue;
    clearTimeout(pending.timer);
    requests.delete(requestId);
    pending.reject(new Error(reason));
  }
}

function rejectAgentRequestsForConnection(agentId: string, connectionId: string, reason: string): void {
  rejectAgentRequestMap(projectRequests, agentId, connectionId, reason);
  rejectAgentRequestMap(gitRequests, agentId, connectionId, reason);
  rejectAgentRequestMap(deployRequests, agentId, connectionId, reason);
  rejectAgentRequestMap(projectCommandRequests, agentId, connectionId, reason);
  rejectAgentRequestMap(nginxRequests, agentId, connectionId, reason);
  rejectAgentRequestMap(sslRequests, agentId, connectionId, reason);
  rejectAgentRequestMap(fileRequests, agentId, connectionId, reason);
  for (const [requestId, pending] of vscodeRequests) {
    if (pending.agentId !== agentId || pending.connectionId !== connectionId) continue;
    clearTimeout(pending.timer);
    vscodeRequests.delete(requestId);
    pending.reject(new Error(reason));
  }
}

function startAgentChatSync(
  agentId: string,
  message: Extract<ServerToAgent, { type: "chat.sync.request" }>
): boolean {
  return sendAgent(agentId, message);
}

function markAgentStatus(agentId: string, status: "online" | "offline"): void {
  db.prepare("UPDATE agents SET status = ?, last_seen_at = ? WHERE id = ?").run(status, nowIso(), agentId);
  broadcast({ type: "agent.status", agentId, status });
}

function repoInfosForAgent(agentId: string): RepoInfo[] {
  const rows = db.prepare("SELECT * FROM repos WHERE agent_id = ? ORDER BY name")
    .all(agentId) as RepoRow[];
  return rows.map(mapRepo);
}

function fullProjectPatchFromRepo(row: RepoRow): Extract<ServerToAgent, { type: "project.update" }>["patch"] {
  const repo = mapRepo(row);
  return {
    name: repo.name,
    path: repo.pathMasked,
    githubUrl: repo.githubUrl,
    serverPath: repo.serverPath,
    domain: repo.domain,
    deploy: repo.deploy ?? null,
    data: repo.data ?? null,
    defaultSandbox: repo.defaultSandbox,
    allowedSandboxes: repo.allowedSandboxes
  };
}

async function syncAgentProjectConfig(agentId: string, row: RepoRow): Promise<void> {
  const result = await requestAgentProject(agentId, {
    type: "project.update",
    requestId: id("req"),
    repoId: row.id,
    patch: fullProjectPatchFromRepo(row)
  });
  if (!result.ok) throw new Error(result.error ?? "project_update_failed");
  if (result.repos) upsertRepos(agentId, result.repos);
}

function upsertRepos(agentId: string, repos: RepoInfo[]): void {
  const stamp = nowIso();
  // Deploy/data are controller-owned after first insert, so offline UI edits survive stale agent heartbeats.
  const upsert = db.prepare(`
    INSERT INTO repos (id,agent_id,name,path_masked,github_url,server_path,domain,deploy_json,data_json,current_branch,dirty,default_sandbox,allowed_sandboxes,test_commands,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(agent_id,id) DO UPDATE SET
      name=excluded.name,
      path_masked=excluded.path_masked,
      github_url=excluded.github_url,
      server_path=excluded.server_path,
      domain=excluded.domain,
      current_branch=excluded.current_branch,
      dirty=excluded.dirty,
      default_sandbox=excluded.default_sandbox,
      allowed_sandboxes=excluded.allowed_sandboxes,
      test_commands=excluded.test_commands,
      updated_at=excluded.updated_at
  `);
  const redirected = db.prepare("SELECT target_agent_id FROM repo_agent_redirects WHERE agent_id = ? AND repo_id = ?");
  for (const repo of repos) {
    if (redirected.get(agentId, repo.id)) continue;
    upsert.run(
      repo.id,
      agentId,
      repo.name,
      repo.pathMasked,
      repo.githubUrl ?? null,
      repo.serverPath ?? null,
      repo.domain ?? null,
      repo.deploy ? JSON.stringify(repo.deploy) : null,
      repo.data ? JSON.stringify(repo.data) : null,
      repo.currentBranch ?? null,
      repo.dirty ? 1 : 0,
      repo.defaultSandbox,
      JSON.stringify(repo.allowedSandboxes),
      JSON.stringify(repo.testCommands),
      stamp
    );
  }
  broadcast({ type: "repos.updated", agentId, repos: repoInfosForAgent(agentId) });
}

function nullableText(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function activeProjectJob(agentId: string, repoId: string): JobRow | undefined {
  return db.prepare("SELECT * FROM jobs WHERE agent_id = ? AND repo_id = ? AND status IN ('queued','assigned','running') LIMIT 1")
    .get(agentId, repoId) as JobRow | undefined;
}

function moveProjectRowsToAgent(
  sourceAgentId: string,
  targetAgentId: string,
  repoId: string,
  patch: Extract<ServerToAgent, { type: "project.update" }>["patch"],
  visibility: ProjectVisibility
): void {
  const stamp = nowIso();
  const allowedSandboxes = patch.allowedSandboxes ?? ["read-only", "workspace-write", "danger-full-access"];
  db.exec("BEGIN");
  try {
    db.prepare(`
      INSERT OR IGNORE INTO repos (id,agent_id,name,path_masked,github_url,server_path,domain,visibility,deploy_json,data_json,current_branch,dirty,default_sandbox,allowed_sandboxes,test_commands,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      repoId,
      targetAgentId,
      patch.name ?? repoId,
      patch.path ?? "",
      nullableText(patch.githubUrl),
      nullableText(patch.serverPath),
      nullableText(patch.domain),
      visibility,
      patch.deploy ? JSON.stringify(patch.deploy) : null,
      patch.data ? JSON.stringify(patch.data) : null,
      null,
      0,
      patch.defaultSandbox ?? "danger-full-access",
      JSON.stringify(allowedSandboxes),
      JSON.stringify([]),
      stamp
    );
    db.prepare(`
      UPDATE repos
      SET name = ?,
          path_masked = ?,
          github_url = ?,
          server_path = ?,
          domain = ?,
          visibility = ?,
          deploy_json = ?,
          data_json = ?,
          default_sandbox = ?,
          allowed_sandboxes = ?,
          updated_at = ?
      WHERE agent_id = ? AND id = ?
    `).run(
      patch.name ?? repoId,
      patch.path ?? "",
      nullableText(patch.githubUrl),
      nullableText(patch.serverPath),
      nullableText(patch.domain),
      visibility,
      patch.deploy ? JSON.stringify(patch.deploy) : null,
      patch.data ? JSON.stringify(patch.data) : null,
      patch.defaultSandbox ?? "danger-full-access",
      JSON.stringify(allowedSandboxes),
      stamp,
      targetAgentId,
      repoId
    );
    db.prepare("UPDATE chats SET agent_id = ? WHERE agent_id = ? AND repo_id = ?").run(targetAgentId, sourceAgentId, repoId);
    db.prepare("UPDATE jobs SET agent_id = ? WHERE agent_id = ? AND repo_id = ?").run(targetAgentId, sourceAgentId, repoId);
    db.prepare("UPDATE chat_shares SET agent_id = ? WHERE agent_id = ? AND repo_id = ?").run(targetAgentId, sourceAgentId, repoId);
    db.prepare("UPDATE OR IGNORE deleted_chat_sync SET agent_id = ? WHERE agent_id = ? AND repo_id = ?").run(targetAgentId, sourceAgentId, repoId);
    db.prepare("DELETE FROM deleted_chat_sync WHERE agent_id = ? AND repo_id = ?").run(sourceAgentId, repoId);
    db.prepare("DELETE FROM repos WHERE agent_id = ? AND id = ?").run(sourceAgentId, repoId);
    db.prepare("DELETE FROM repo_agent_redirects WHERE agent_id = ? AND repo_id = ?").run(targetAgentId, repoId);
    db.prepare("INSERT OR REPLACE INTO repo_agent_redirects (agent_id, repo_id, target_agent_id, created_at) VALUES (?,?,?,?)")
      .run(sourceAgentId, repoId, targetAgentId, stamp);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function updateControllerProjectSettings(
  agentId: string,
  repoId: string,
  patch: {
    visibility?: ProjectVisibility;
    deploy?: DeployConfig | null;
    data?: ProjectDataConfig | null;
  },
  fields: { deploy: boolean; data: boolean }
): boolean {
  const assignments: string[] = [];
  const values: Array<string | null> = [];
  if (patch.visibility) {
    assignments.push("visibility = ?");
    values.push(patch.visibility);
  }
  if (fields.deploy) {
    assignments.push("deploy_json = ?");
    values.push(patch.deploy ? JSON.stringify(patch.deploy) : null);
  }
  if (fields.data) {
    assignments.push("data_json = ?");
    values.push(patch.data ? JSON.stringify(patch.data) : null);
  }
  if (!assignments.length) return false;
  assignments.push("updated_at = ?");
  values.push(nowIso(), agentId, repoId);
  db.prepare(`UPDATE repos SET ${assignments.join(", ")} WHERE agent_id = ? AND id = ?`).run(...values);
  return true;
}

function appendLog(log: Omit<LogRow, "id">): void {
  db.prepare("INSERT INTO job_logs (id,job_id,stream,message,at) VALUES (?,?,?,?,?)")
    .run(id("log"), log.job_id, log.stream, log.message.slice(0, 20000), log.at);
  broadcast({ type: "job.log", jobId: log.job_id, stream: log.stream, message: log.message, at: log.at });
}

function latestJobLogText(jobId: string, stream: "stdout" | "stderr"): string | null {
  const row = db.prepare(`
    SELECT message FROM job_logs
    WHERE job_id = ? AND stream = ? AND TRIM(message) != ''
    ORDER BY at DESC
    LIMIT 1
  `).get(jobId, stream) as { message: string } | undefined;
  return row?.message.trim().slice(-4000) || null;
}

function isGenericFinalMessage(message: string): boolean {
  return ["Completed.", "Codex finished.", "Codex process failed.", "Process failed."].includes(message.trim());
}

function finalMessageForCompletedJob(jobId: string, finalMessage: string | undefined): string | null {
  const trimmed = finalMessage?.trim();
  if (trimmed && !isGenericFinalMessage(trimmed)) return trimmed;
  const stdout = latestJobLogText(jobId, "stdout");
  if (stdout) return stdout;
  return trimmed || null;
}

function appendChatMessage(message: Omit<ChatMessageRow, "id"> & { id?: string }): void {
  db.prepare("UPDATE chats SET updated_at=? WHERE id=?").run(message.created_at, message.chat_id);
  db.prepare(`
    INSERT INTO chat_messages (id,chat_id,role,content,source,external_id,metadata_json,created_at)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      role=excluded.role,
      content=excluded.content,
      source=excluded.source,
      external_id=excluded.external_id,
      metadata_json=excluded.metadata_json,
      created_at=excluded.created_at
  `).run(
    message.id ?? id("msg"),
    message.chat_id,
    message.role,
    message.content.slice(0, 200000),
    message.source,
    message.external_id ?? null,
    message.metadata_json ?? null,
    message.created_at
  );
  broadcast({ type: "chats.updated", agentId: chatAgentId(message.chat_id), repoId: chatRepoId(message.chat_id), chatId: message.chat_id });
}

type ProjectOperationKind = "git-sync" | "deploy" | "nginx" | "ssl";
type ProjectOperationStatus = "running" | "completed" | "failed";

function projectOperationChat(user: AuthUser, agentId: string, repoId: string, chatId: string): ChatRow | undefined {
  return db.prepare(`
    SELECT c.* FROM chats c
    JOIN agents a ON a.id = c.agent_id
    WHERE c.id = ? AND c.agent_id = ? AND c.repo_id = ? ${isAdmin(user) ? "" : "AND a.user_id = ?"}
  `).get(chatId, agentId, repoId, ...(isAdmin(user) ? [] : [user.id])) as ChatRow | undefined;
}

function safeInlineCode(value: string): string {
  return value.replace(/`/g, "'").trim();
}

function safeCodeFence(value: string): string {
  const text = value.trim() || "No output.";
  const max = 120000;
  const trimmed = text.length > max
    ? `${text.slice(0, 4000)}\n\n... output truncated ...\n\n${text.slice(-(max - 4000))}`
    : text;
  return trimmed.replace(/```/g, "` ` `");
}

function projectOperationContent(
  label: string,
  status: ProjectOperationStatus,
  repoName: string,
  output?: string,
  details: string[] = []
): string {
  const title = status === "running"
    ? `${label} запущен`
    : status === "completed"
      ? `${label} завершён`
      : `${label} завершился с ошибкой`;
  const lines = [
    `**${title}**`,
    "",
    `Проект: \`${safeInlineCode(repoName)}\`.`,
    ...details.map((detail) => detail.trim()).filter(Boolean)
  ];
  if (status === "running") lines.push("Статус: выполняется.");
  if (output?.trim()) {
    lines.push("", "```text", safeCodeFence(output), "```");
  }
  return lines.join("\n");
}

function appendProjectOperationMessage(options: {
  chat: ChatRow;
  messageId: string;
  requestId: string;
  operation: ProjectOperationKind;
  label: string;
  status: ProjectOperationStatus;
  repoName: string;
  output?: string;
  details?: string[];
}): void {
  const stamp = nowIso();
  appendChatMessage({
    id: options.messageId,
    chat_id: options.chat.id,
    role: "system",
    content: projectOperationContent(options.label, options.status, options.repoName, options.output, options.details ?? []),
    source: "web",
    external_id: `project-operation:${options.operation}:${options.requestId}`,
    metadata_json: JSON.stringify({
      kind: "project-operation",
      operation: options.operation,
      operationLabel: options.label,
      status: options.status,
      requestId: options.requestId
    }),
    created_at: stamp
  });
}

function clearOrphanedAgentJobs(agentId: string, currentJobId: string | undefined, reason = "Agent heartbeat has no active job; marking stale job as disconnected."): void {
  if (currentJobId) return;
  const rows = db.prepare("SELECT id, created_at, started_at FROM jobs WHERE agent_id = ? AND status IN ('assigned','running')")
    .all(agentId) as Array<{ id: string; created_at: string; started_at: string | null }>;
  const cutoff = Date.now() - STALE_JOB_GRACE_MS;
  const staleRows = rows.filter((row) => {
    const timestamp = Date.parse(row.started_at ?? row.created_at);
    return Number.isFinite(timestamp) && timestamp < cutoff;
  });
  if (!staleRows.length) return;
  const stamp = nowIso();
  const update = db.prepare("UPDATE jobs SET status='agent_disconnected', finished_at=? WHERE id=? AND status IN ('assigned','running')");
  for (const row of staleRows) {
    update.run(stamp, row.id);
    appendLog({
      job_id: row.id,
      stream: "system",
      message: reason,
      at: stamp
    });
    broadcast({ type: "job.updated", jobId: row.id, status: "agent_disconnected" });
  }
}

function idleLocalActivity(summary = "No recent local Codex activity."): LocalCodexActivity {
  return { status: "idle", summary, source: "agent heartbeat", detectedAt: nowIso() };
}

function freshLocalActivity(activity: LocalCodexActivity | undefined, _agentId?: string): LocalCodexActivity | undefined {
  if (!activity) return undefined;
  const timestampSource = activity.status === "busy"
    && !isWebActivitySource(activity.source)
    && activity.updatedAt
    ? activity.updatedAt
    : activity.detectedAt;
  const timestamp = Date.parse(timestampSource);
  if (!Number.isFinite(timestamp) || Date.now() - timestamp > 90000) {
    return idleLocalActivity();
  }
  return activity;
}

function broadcastAgentActivity(agentId: string, activity: LocalCodexActivity): void {
  const localActivity = freshLocalActivity(activity, agentId) ?? idleLocalActivity();
  broadcast({ type: "agent.activity", agentId, localActivity });
}

function isAgentLocallyBusy(agentId: string): boolean {
  const row = db.prepare("SELECT local_activity_json FROM agents WHERE id = ?").get(agentId) as Pick<AgentRow, "local_activity_json"> | undefined;
  return freshLocalActivity(parseLocalActivity(row?.local_activity_json ?? null), agentId)?.status === "busy";
}

function chatAgentId(chatId: string): string {
  const row = db.prepare("SELECT agent_id FROM chats WHERE id = ?").get(chatId) as { agent_id: string } | undefined;
  return row?.agent_id ?? "";
}

function chatRepoId(chatId: string): string {
  const row = db.prepare("SELECT repo_id FROM chats WHERE id = ?").get(chatId) as { repo_id: string } | undefined;
  return row?.repo_id ?? "";
}

type SerializeAttachmentOptions = {
  includeData?: boolean;
  includeChatData?: boolean;
  includeChatDataLimitBytes?: number;
  lightMetadata?: boolean;
};

type ChatAttachmentWithMessageTime = ChatAttachmentRow & {
  message_created_at: string;
};

function serializeMessageMetadata(metadataJson: string | null, options: SerializeAttachmentOptions = {}) {
  if (!metadataJson) return undefined;
  const metadata = JSON.parse(metadataJson) as Record<string, unknown>;
  if (!options.lightMetadata) return metadata;
  let omitted = false;
  const light = { ...metadata };
  if (typeof light.gitDiff === "string") {
    delete light.gitDiff;
    light.gitDiffOmitted = true;
    omitted = true;
  }
  if (Array.isArray(light.codexActions)) {
    light.codexActions = light.codexActions.map((item) => {
      if (!item || typeof item !== "object") return item;
      const value = item as Record<string, unknown>;
      if (typeof value.output !== "string") return value;
      omitted = true;
      const rest = { ...value };
      delete rest.output;
      return { ...rest, outputOmitted: true };
    });
  }
  if (omitted) light.metadataOmitted = true;
  return light;
}

function serializeMessage(message: ChatMessageRow, options: SerializeAttachmentOptions = {}) {
  const jobAttachments = db.prepare("SELECT * FROM job_attachments WHERE chat_message_id = ? ORDER BY created_at ASC")
    .all(message.id) as AttachmentRow[];
  const chatAttachments = db.prepare("SELECT * FROM chat_attachments WHERE chat_message_id = ? ORDER BY created_at ASC")
    .all(message.id) as ChatAttachmentRow[];
  return {
    id: message.id,
    chatId: message.chat_id,
    role: message.role,
    content: message.content,
    source: message.source,
    externalId: message.external_id,
    metadata: serializeMessageMetadata(message.metadata_json, options),
    createdAt: message.created_at,
    attachments: [
      ...jobAttachments.map((attachment) => serializeAttachment(attachment, options)),
      ...chatAttachments.map((attachment) => serializeChatAttachment(attachment, options))
    ]
  };
}

function serializeMessagesForChat(chatId: string, messages: ChatMessageRow[], options: SerializeAttachmentOptions = {}) {
  const jobAttachments = db.prepare(`
    SELECT a.*
    FROM job_attachments a
    JOIN chat_messages m ON m.id = a.chat_message_id
    WHERE m.chat_id = ?
    ORDER BY a.created_at ASC
  `).all(chatId) as AttachmentRow[];
  const chatAttachments = db.prepare(`
    SELECT a.*, m.created_at AS message_created_at
    FROM chat_attachments a
    JOIN chat_messages m ON m.id = a.chat_message_id
    WHERE m.chat_id = ?
    ORDER BY a.created_at ASC
  `).all(chatId) as ChatAttachmentWithMessageTime[];
  const jobAttachmentsByMessage = new Map<string, AttachmentRow[]>();
  const chatAttachmentsByMessage = new Map<string, ChatAttachmentWithMessageTime[]>();
  const inlineChatAttachmentIds = new Set<string>();
  if (options.includeChatDataLimitBytes && options.includeChatDataLimitBytes > 0) {
    let remainingBytes = options.includeChatDataLimitBytes;
    [...chatAttachments]
      .filter((attachment) => isPreviewableImageMime(attachment.mime_type))
      .sort((a, b) => {
        const byMessage = Date.parse(b.message_created_at) - Date.parse(a.message_created_at);
        if (byMessage !== 0) return byMessage;
        return Date.parse(b.created_at) - Date.parse(a.created_at);
      })
      .forEach((attachment) => {
        if (attachment.size > remainingBytes) return;
        inlineChatAttachmentIds.add(attachment.id);
        remainingBytes -= attachment.size;
      });
  }
  jobAttachments.forEach((attachment) => {
    if (!attachment.chat_message_id) return;
    const current = jobAttachmentsByMessage.get(attachment.chat_message_id) ?? [];
    current.push(attachment);
    jobAttachmentsByMessage.set(attachment.chat_message_id, current);
  });
  chatAttachments.forEach((attachment) => {
    const current = chatAttachmentsByMessage.get(attachment.chat_message_id) ?? [];
    current.push(attachment);
    chatAttachmentsByMessage.set(attachment.chat_message_id, current);
  });
  return messages.map((message) => ({
    id: message.id,
    chatId: message.chat_id,
    role: message.role,
    content: message.content,
    source: message.source,
    externalId: message.external_id,
    metadata: serializeMessageMetadata(message.metadata_json, options),
    createdAt: message.created_at,
    attachments: [
      ...(jobAttachmentsByMessage.get(message.id) ?? []).map((attachment) => serializeAttachment(attachment, options)),
      ...(chatAttachmentsByMessage.get(message.id) ?? []).map((attachment) => serializeChatAttachment(attachment, {
        ...options,
        includeChatData: options.includeChatData || inlineChatAttachmentIds.has(attachment.id)
      }))
    ]
  }));
}

function serializeAttachment(attachment: AttachmentRow, options: SerializeAttachmentOptions = {}) {
  return {
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mime_type,
    size: attachment.size,
    url: `/api/job-attachments/${encodeURIComponent(attachment.id)}`,
    dataBase64: options.includeData && isPreviewableImageMime(attachment.mime_type) ? attachment.data_base64 : undefined,
    createdAt: attachment.created_at
  };
}

function serializeChatAttachment(attachment: ChatAttachmentRow, options: SerializeAttachmentOptions = {}) {
  return {
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mime_type,
    size: attachment.size,
    url: `/api/chat-attachments/${encodeURIComponent(attachment.id)}`,
    dataBase64: (options.includeData || options.includeChatData) && isPreviewableImageMime(attachment.mime_type) ? attachment.data_base64 : undefined,
    createdAt: attachment.created_at
  };
}

function sendAttachment(reply: FastifyReply, attachment: Pick<AttachmentRow, "name" | "mime_type" | "data_base64">) {
  reply.header("Content-Type", attachment.mime_type);
  reply.header("Cache-Control", "private, max-age=86400");
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Content-Disposition", `inline; filename="${attachment.name.replace(/["\r\n]/g, "_")}"`);
  return reply.send(Buffer.from(attachment.data_base64, "base64"));
}

function isPreviewableImageMime(mimeType: string): boolean {
  return ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp"].includes(mimeType.toLowerCase());
}

function storeJobAttachments(
  jobId: string,
  messageId: string,
  attachments: Array<{ name: string; mimeType: string; size: number; dataBase64: string }>,
  createdAt: string
): void {
  const totalSize = attachments.reduce((sum, attachment) => sum + attachment.size, 0);
  if (totalSize > 12 * 1024 * 1024) throw new Error("attachments_too_large");
  const insert = db.prepare(`
    INSERT INTO job_attachments (id,job_id,chat_message_id,name,mime_type,size,data_base64,created_at)
    VALUES (?,?,?,?,?,?,?,?)
  `);
  for (const attachment of attachments) {
    insert.run(
      id("att"),
      jobId,
      messageId,
      attachment.name,
      attachment.mimeType,
      attachment.size,
      attachment.dataBase64,
      createdAt
    );
  }
}

function stripLeadingCodexContextBlocks(content: string): string {
  let value = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!value) return "";

  for (;;) {
    const before = value;
    value = value
      .replace(/^\s*Codex web agent environment:\s*(?:\n[ \t]*-[^\n]*)+\s*/i, "")
      .replace(/^\s*#?\s*AGENTS\.md instructions for[^\n]*\n+\s*<INSTRUCTIONS>\s*[\s\S]*?<\/INSTRUCTIONS>\s*/i, "")
      .replace(/^\s*<INSTRUCTIONS>\s*[\s\S]*?<\/INSTRUCTIONS>\s*/i, "")
      .trimStart();

    for (const tag of CODEX_CONTEXT_TAGS) {
      const escaped = escapeRegex(tag);
      value = value.replace(new RegExp(`^\\s*<${escaped}>\\s*[\\s\\S]*?<\\/${escaped}>\\s*`, "i"), "").trimStart();
    }

    if (value === before) break;
  }

  if (/^\s*#?\s*AGENTS\.md instructions for\b/i.test(value) && /<INSTRUCTIONS>/i.test(value)) return "";
  if (/^\s*AGENTS\.md\s+Project rules\b/i.test(value)) return "";
  if (/^\s*Codex web agent environment:\s*$/i.test(value)) return "";
  return value.trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanSyncedMessageContent(content: string): string {
  return stripCodexAttachmentHelperBlock(stripLeadingCodexContextBlocks(content))
    .replace(/<image>\s*<\/image>/gi, "")
    .replace(/<image\s*\/>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripCodexAttachmentHelperBlock(content: string): string {
  return content
    .replace(/\n*Attached files saved locally for this task:\s*\n[\s\S]*?\n\s*Use these file paths as the attached user-provided context\.?\s*$/i, "")
    .trim();
}

function titleFromSyncedContent(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  let content = cleanSyncedMessageContent(value);
  const requestMatch = content.match(/My request for Codex:\s*([\s\S]+)/i);
  if (requestMatch?.[1]) content = requestMatch[1];
  content = content
    .replace(/<image>[\s\S]*?<\/image>/gi, "")
    .replace(/<image\s*\/>/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!content || /^# Context from my IDE setup:/i.test(content)) return undefined;
  const normalized = content.toLowerCase();
  if (
    (normalized.includes("https://xedoc.ru") || normalized.includes("https://codex.rodion.pro"))
    && (normalized.includes("sync") || normalized.includes("синхрон"))
  ) {
    return "Синхронизировать новый чат";
  }
  return content.slice(0, 120);
}

function syncedChatTitle(sync: Pick<SyncedChat, "source" | "title">, messages: SyncedChatMessage[]): string {
  return titleFromSyncedContent(sync.title)
    || titleFromSyncedContent(messages.find((message) => message.role === "user")?.content)
    || titleFromSyncedContent(messages[0]?.content)
    || (sync.source === "vscode" ? "VS Code chat" : "Codex chat");
}

function sanitizeSyncedMessages(messages: SyncedChatMessage[]): SyncedChatMessage[] {
  return messages.flatMap((message) => {
    const content = cleanSyncedMessageContent(message.content) || (message.attachments?.length ? "Image attachment" : "");
    if (!content) return [];
    return [{ ...message, content }];
  });
}

function pruneSyncedContextMessages(chatId: string): boolean {
  const rows = db.prepare(`
    SELECT id, role, content
    FROM chat_messages
    WHERE chat_id = ? AND source IN ('codex', 'vscode')
  `).all(chatId) as Array<Pick<ChatMessageRow, "id" | "role" | "content">>;
  let changed = false;
  for (const row of rows) {
    const content = cleanSyncedMessageContent(row.content);
    if (!content) {
      db.prepare("DELETE FROM chat_messages WHERE id = ?").run(row.id);
      changed = true;
    } else {
      const duplicate = db.prepare("SELECT id FROM chat_messages WHERE chat_id = ? AND role = ? AND content = ? AND id != ? LIMIT 1")
        .get(chatId, row.role, content, row.id) as { id: string } | undefined;
      if (duplicate) {
        db.prepare("DELETE FROM chat_messages WHERE id = ?").run(row.id);
        changed = true;
      } else if (content !== row.content) {
        db.prepare("UPDATE chat_messages SET content = ? WHERE id = ?").run(content, row.id);
        changed = true;
      }
    }
  }
  return changed;
}

function mergeChatMessagesIntoTarget(sourceChatId: string, targetChatId: string): boolean {
  if (sourceChatId === targetChatId) return false;
  const sourceMessages = db.prepare("SELECT * FROM chat_messages WHERE chat_id = ? ORDER BY created_at ASC, id ASC")
    .all(sourceChatId) as ChatMessageRow[];
  let changed = false;
  for (const message of sourceMessages) {
    const duplicateByExternalId = message.external_id
      ? db.prepare("SELECT id FROM chat_messages WHERE chat_id = ? AND source = ? AND external_id = ? LIMIT 1")
        .get(targetChatId, message.source, message.external_id) as { id: string } | undefined
      : undefined;
    const duplicateByContent = db.prepare("SELECT id FROM chat_messages WHERE chat_id = ? AND role = ? AND content = ? LIMIT 1")
      .get(targetChatId, message.role, message.content) as { id: string } | undefined;
    if (duplicateByExternalId || duplicateByContent) {
      db.prepare("DELETE FROM chat_messages WHERE id = ?").run(message.id);
      changed = true;
      continue;
    }
    db.prepare("UPDATE chat_messages SET chat_id = ? WHERE id = ?").run(targetChatId, message.id);
    changed = true;
  }
  return changed;
}

function mergeLinkedSyncedChatDuplicates(
  agentId: string,
  repoId: string,
  externalId: string,
  targetChatId: string
): number {
  const duplicates = db.prepare(`
    SELECT * FROM chats
    WHERE agent_id = ?
      AND repo_id = ?
      AND source = 'codex'
      AND external_id = ?
      AND id != ?
    ORDER BY updated_at DESC
  `).all(agentId, repoId, externalId, targetChatId) as ChatRow[];
  let merged = 0;
  for (const duplicate of duplicates) {
    mergeChatMessagesIntoTarget(duplicate.id, targetChatId);
    db.prepare("UPDATE chat_shares SET chat_id = ? WHERE chat_id = ?").run(targetChatId, duplicate.id);
    db.prepare("DELETE FROM chats WHERE id = ?").run(duplicate.id);
    merged += 1;
  }
  return merged;
}

function reconcileLinkedSyncedChatDuplicates(): number {
  const links = db.prepare(`
    SELECT DISTINCT j.agent_id, j.repo_id, j.chat_id, j.codex_thread_id
    FROM jobs j
    JOIN chats c ON c.id = j.chat_id
    JOIN chats duplicate ON duplicate.agent_id = j.agent_id
      AND duplicate.repo_id = j.repo_id
      AND duplicate.source = 'codex'
      AND duplicate.external_id = j.codex_thread_id
      AND duplicate.id != j.chat_id
    WHERE j.chat_id IS NOT NULL
      AND j.codex_thread_id IS NOT NULL
      AND j.codex_thread_id != ''
  `).all() as Array<{ agent_id: string; repo_id: string; chat_id: string | null; codex_thread_id: string }>;
  let merged = 0;
  for (const link of links) {
    if (!link.chat_id) continue;
    merged += mergeLinkedSyncedChatDuplicates(link.agent_id, link.repo_id, link.codex_thread_id, link.chat_id);
  }
  return merged;
}

function replaceChatMessageAttachments(
  messageId: string,
  attachments: Array<{ name: string; mimeType: string; size: number; dataBase64: string }> | undefined,
  createdAt: string
): void {
  db.prepare("DELETE FROM chat_attachments WHERE chat_message_id = ?").run(messageId);
  const safeAttachments = (attachments ?? []).filter((attachment) => isPreviewableImageMime(attachment.mimeType));
  const totalSize = safeAttachments.reduce((sum, attachment) => sum + attachment.size, 0);
  if (!safeAttachments.length || totalSize > 12 * 1024 * 1024) return;
  const insert = db.prepare(`
    INSERT INTO chat_attachments (id,chat_message_id,name,mime_type,size,data_base64,created_at)
    VALUES (?,?,?,?,?,?,?)
  `);
  for (const attachment of safeAttachments) {
    insert.run(
      id("att"),
      messageId,
      attachment.name,
      attachment.mimeType,
      attachment.size,
      attachment.dataBase64,
      createdAt
    );
  }
}

function chatMessageAttachmentsChanged(
  messageId: string,
  attachments: Array<{ name: string; mimeType: string; size: number; dataBase64: string }> | undefined
): boolean {
  if (attachments === undefined) return false;
  const safeAttachments = attachments.filter((attachment) => isPreviewableImageMime(attachment.mimeType));
  const totalSize = safeAttachments.reduce((sum, attachment) => sum + attachment.size, 0);
  const incoming = totalSize > 12 * 1024 * 1024 ? [] : safeAttachments;
  const existing = db.prepare("SELECT name,mime_type,size FROM chat_attachments WHERE chat_message_id = ? ORDER BY created_at ASC")
    .all(messageId) as Array<Pick<AttachmentRow, "name" | "mime_type" | "size">>;
  if (existing.length !== incoming.length) return true;
  return incoming.some((attachment, index) => {
    const current = existing[index];
    return !current
      || current.name !== attachment.name
      || current.mime_type !== attachment.mimeType
      || current.size !== attachment.size;
  });
}

function upsertSyncedChat(agentId: string, sync: Extract<AgentToServer, { type: "chat.sync" }>): void {
  const repo = db.prepare("SELECT * FROM repos WHERE agent_id = ? AND id = ?").get(agentId, sync.repoId) as RepoRow | undefined;
  if (!repo) return;
  const syncedMessages = sanitizeSyncedMessages(sync.messages);
  if (!syncedMessages.length) return;
  const syncTitle = syncedChatTitle(sync, syncedMessages).slice(0, 300);
  const tombstone = db.prepare("SELECT 1 FROM deleted_chat_sync WHERE agent_id = ? AND repo_id = ? AND source = ? AND external_id = ?")
    .get(agentId, sync.repoId, sync.source, sync.externalId) as { 1: number } | undefined;
  if (tombstone) return;
  const stamp = nowIso();
  const linkedChat = sync.source === "codex"
    ? db.prepare(`
      SELECT c.* FROM jobs j
      JOIN chats c ON c.id = j.chat_id
      WHERE j.agent_id = ? AND j.repo_id = ? AND j.codex_thread_id = ?
      ORDER BY COALESCE(j.finished_at, j.started_at, j.created_at) DESC
      LIMIT 1
    `).get(agentId, sync.repoId, sync.externalId) as ChatRow | undefined
    : undefined;
  let chat = db.prepare("SELECT * FROM chats WHERE agent_id = ? AND source = ? AND external_id = ?")
    .get(agentId, sync.source, sync.externalId) as ChatRow | undefined;
  let changed = false;
  if (!linkedChat && chat) changed = pruneSyncedContextMessages(chat.id) || changed;
  const latestSyncedMessage = syncedMessages.at(-1);
  if (!linkedChat && chat && chat.updated_at === sync.updatedAt && latestSyncedMessage?.externalId) {
    const latestExists = db.prepare("SELECT 1 FROM chat_messages WHERE chat_id = ? AND source = ? AND external_id = ?")
      .get(chat.id, latestSyncedMessage.source, latestSyncedMessage.externalId) as { 1: number } | undefined;
    if (latestExists) {
      const nextTitle = chat.title_override ?? syncTitle;
      if (changed || chat.title !== nextTitle) {
        db.prepare("UPDATE chats SET title = ?, updated_at = ? WHERE id = ?").run(nextTitle, sync.updatedAt || stamp, chat.id);
        broadcast({
          type: "chats.updated",
          agentId,
          repoId: sync.repoId,
          chatId: chat.id,
          source: sync.source,
          externalId: sync.externalId
        });
      }
      return;
    }
  }
  if (linkedChat) {
    if (chat && chat.id !== linkedChat.id) {
      db.prepare("DELETE FROM chats WHERE id = ?").run(chat.id);
      changed = true;
    }
    chat = linkedChat;
    changed = pruneSyncedContextMessages(chat.id) || changed;
    const nextCwd = chat.cwd ?? sync.cwd ?? null;
    const nextTitle = chat.title_override ?? syncTitle;
    if (chat.title !== nextTitle || chat.cwd !== nextCwd || chat.updated_at !== sync.updatedAt) {
      db.prepare("UPDATE chats SET title=?, cwd=?, updated_at=? WHERE id=?")
        .run(nextTitle, nextCwd, sync.updatedAt, chat.id);
      changed = true;
    }
  } else if (chat) {
    const nextCwd = sync.cwd ?? null;
    const nextTitle = chat.title_override ?? syncTitle;
    if (chat.repo_id !== sync.repoId || chat.title !== nextTitle || chat.cwd !== nextCwd || chat.updated_at !== sync.updatedAt) {
      db.prepare("UPDATE chats SET repo_id=?, title=?, cwd=?, updated_at=? WHERE id=?")
        .run(sync.repoId, nextTitle, nextCwd, sync.updatedAt, chat.id);
      changed = true;
    }
  } else {
    const chatId = id("chat");
    db.prepare("INSERT INTO chats (id,agent_id,repo_id,title,source,external_id,cwd,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(chatId, agentId, sync.repoId, syncTitle, sync.source, sync.externalId, sync.cwd ?? null, sync.updatedAt, sync.updatedAt);
    chat = db.prepare("SELECT * FROM chats WHERE id = ?").get(chatId) as ChatRow;
    changed = true;
  }
  for (const message of syncedMessages) {
    const content = message.content.slice(0, 200000);
    const metadataJson = message.metadata ? JSON.stringify(message.metadata) : null;
    const existing = message.externalId
      ? db.prepare("SELECT * FROM chat_messages WHERE chat_id = ? AND source = ? AND external_id = ?")
        .get(chat.id, message.source, message.externalId) as ChatMessageRow | undefined
      : undefined;
    if (existing) {
      const duplicate = db.prepare("SELECT id FROM chat_messages WHERE chat_id = ? AND role = ? AND content = ? AND id != ? LIMIT 1")
        .get(chat.id, message.role, content, existing.id) as { id: string } | undefined;
      if (duplicate) {
        db.prepare("DELETE FROM chat_messages WHERE id = ?").run(existing.id);
        changed = true;
        continue;
      }
      const messageChanged = existing.role !== message.role
        || existing.content !== content
        || existing.metadata_json !== metadataJson
        || existing.created_at !== message.createdAt;
      const attachmentsChanged = chatMessageAttachmentsChanged(existing.id, message.attachments);
      if (
        messageChanged
        || attachmentsChanged
      ) {
        if (messageChanged) {
          db.prepare("UPDATE chat_messages SET role=?, content=?, metadata_json=?, created_at=? WHERE id=?")
            .run(message.role, content, metadataJson, message.createdAt, existing.id);
        }
        if (attachmentsChanged) replaceChatMessageAttachments(existing.id, message.attachments, message.createdAt);
        changed = true;
      }
    } else {
      const duplicate = db.prepare("SELECT id FROM chat_messages WHERE chat_id = ? AND role = ? AND content = ? LIMIT 1")
        .get(chat.id, message.role, content) as { id: string } | undefined;
      if (duplicate) {
        continue;
      }
      const messageId = message.id ?? id("msg");
      db.prepare("INSERT INTO chat_messages (id,chat_id,role,content,source,external_id,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(messageId, chat.id, message.role, content, message.source, message.externalId ?? null, metadataJson, message.createdAt);
      replaceChatMessageAttachments(messageId, message.attachments, message.createdAt);
      changed = true;
    }
  }
  const incomingExternalIds = syncedMessages
    .map((message) => message.externalId)
    .filter((externalId): externalId is string => Boolean(externalId));
  const firstSyncedCreatedAt = syncedMessages[0]?.createdAt;
  if (incomingExternalIds.length && firstSyncedCreatedAt) {
    const placeholders = incomingExternalIds.map(() => "?").join(",");
    const staleExternalIdFilter = sync.source === "codex"
      ? "AND external_id LIKE 'rollout-%jsonl:%'"
      : "";
    const result = db.prepare(`
      DELETE FROM chat_messages
      WHERE chat_id = ?
        AND source = ?
        AND external_id IS NOT NULL
        ${staleExternalIdFilter}
        AND created_at >= ?
        AND external_id NOT IN (${placeholders})
    `).run(chat.id, sync.source, firstSyncedCreatedAt, ...incomingExternalIds);
    if (result.changes) changed = true;
  }
  if (changed) {
    db.prepare("UPDATE chats SET updated_at = ? WHERE id = ?").run(sync.updatedAt || stamp, chat.id);
    broadcast({
      type: "chats.updated",
      agentId,
      repoId: sync.repoId,
      chatId: chat.id,
      source: sync.source,
      externalId: sync.externalId
    });
  }
}

function tombstoneDeletedChat(chat: ChatRow, jobRows: Array<{ id: string; codex_thread_id?: string | null }>): void {
  const stamp = nowIso();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO deleted_chat_sync (agent_id, repo_id, source, external_id, deleted_at)
    VALUES (?,?,?,?,?)
  `);
  if (chat.external_id) insert.run(chat.agent_id, chat.repo_id, chat.source, chat.external_id, stamp);
  for (const job of jobRows) {
    if (job.codex_thread_id) insert.run(chat.agent_id, chat.repo_id, "codex", job.codex_thread_id, stamp);
  }
}

function latestThreadIdForChat(chatId: string | null, currentJobId: string, kind: JobRow["kind"]): string | undefined {
  if (!chatId) return undefined;
  if (kind === "test") return undefined;
  if (kind === "codex") {
    const chat = db.prepare("SELECT source, external_id FROM chats WHERE id = ?").get(chatId) as Pick<ChatRow, "source" | "external_id"> | undefined;
    if (chat?.source === "codex" && chat.external_id) return chat.external_id;
  }
  const row = db.prepare(`
    SELECT codex_thread_id FROM jobs
    WHERE chat_id = ? AND id != ? AND kind = ? AND codex_thread_id IS NOT NULL AND codex_thread_id != ''
    ORDER BY COALESCE(finished_at, started_at, created_at) DESC
    LIMIT 1
  `).get(chatId, currentJobId, kind) as { codex_thread_id: string } | undefined;
  return row?.codex_thread_id;
}

function assistantSourceForJob(kind: JobRow["kind"]): string {
  if (kind === "grok") return "grok";
  if (kind === "gemini" || kind === "gemini-cli") return "gemini";
  return "codex";
}

function jobIdFromMessageExternalId(externalId: string | null): string {
  return externalId?.match(/^job:([^:]+):/)?.[1] ?? "";
}

function isRunningJobStatus(status: string): boolean {
  return ["queued", "assigned", "running"].includes(status);
}

function parseMessageMetadata(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function contextLabelForMessage(message: Pick<ChatMessageRow, "role" | "source">): string {
  if (message.role === "user") return "user";
  if (message.role === "system") return "system";
  if (message.source === "grok") return "grok";
  if (message.source === "gemini") return "gemini";
  if (message.source === "vscode") return "vscode";
  if (message.source === "codex") return "codex";
  return message.role;
}

function promptForAgentJob(job: JobRow): string {
  if (!job.chat_id) return job.prompt;
  const rows = db.prepare(`
    SELECT role, content, source, external_id, metadata_json FROM chat_messages
    WHERE chat_id = ? AND external_id != ?
    ORDER BY created_at DESC, id DESC
    LIMIT 32
  `).all(job.chat_id, `job:${job.id}:prompt`) as Array<Pick<ChatMessageRow, "role" | "content" | "source" | "external_id" | "metadata_json">>;
  if (!rows.length) return job.prompt;
  const relatedJobIds = [...new Set(rows.map((message) => jobIdFromMessageExternalId(message.external_id)).filter(Boolean))];
  const relatedJobs = new Map<string, Pick<JobRow, "id" | "status" | "git_diff_stat">>();
  for (const relatedJobId of relatedJobIds) {
    const relatedJob = db.prepare("SELECT id,status,git_diff_stat FROM jobs WHERE id = ?")
      .get(relatedJobId) as Pick<JobRow, "id" | "status" | "git_diff_stat"> | undefined;
    if (relatedJob) relatedJobs.set(relatedJob.id, relatedJob);
  }
  const history = rows
    .reverse()
    .filter((message) => {
      if (!message.content.trim()) return false;
      const relatedJobId = jobIdFromMessageExternalId(message.external_id);
      const relatedJob = relatedJobId ? relatedJobs.get(relatedJobId) : undefined;
      return !(message.role === "user" && relatedJobId !== job.id && relatedJob && isRunningJobStatus(relatedJob.status));
    })
    .map((message) => {
      const label = contextLabelForMessage(message);
      const relatedJobId = jobIdFromMessageExternalId(message.external_id);
      const relatedJob = relatedJobId ? relatedJobs.get(relatedJobId) : undefined;
      const metadata = parseMessageMetadata(message.metadata_json);
      const gitDiffStat = typeof metadata.gitDiffStat === "string"
        ? metadata.gitDiffStat.trim()
        : relatedJob?.git_diff_stat?.trim() ?? "";
      const diffContext = message.role === "assistant" && gitDiffStat ? `\nDiff stat:\n${gitDiffStat.slice(0, 2000)}` : "";
      return `${label}: ${message.content.trim().slice(-6000)}${diffContext}`;
    })
    .join("\n\n");
  if (!history) return job.prompt;
  return [
    "Use this chat and project context when answering. Do not repeat the history unless it is needed.",
    "",
    "Chat context:",
    history,
    "",
    "Current user request:",
    job.prompt
  ].join("\n");
}

function failJobBeforeRun(job: JobRow, finalMessage: string): void {
  const finishedAt = nowIso();
  db.prepare("UPDATE jobs SET status='failed', exit_code=1, final_message=?, finished_at=? WHERE id=?")
    .run(finalMessage, finishedAt, job.id);
  if (job.chat_id) {
    appendChatMessage({
      chat_id: job.chat_id,
      role: "assistant",
      content: finalMessage,
      source: assistantSourceForJob(job.kind),
      external_id: `job:${job.id}:final`,
      metadata_json: JSON.stringify({ jobId: job.id, status: "failed" }),
      created_at: finishedAt
    });
  }
  broadcast({ type: "job.updated", jobId: job.id, status: "failed" });
}

async function dispatchQueue(agentId: string): Promise<void> {
  if (dispatchingAgents.has(agentId)) return;
  dispatchingAgents.add(agentId);
  try {
    while (true) {
      const agent = agents.get(agentId);
      if (!agent) return;
      if (isAgentLocallyBusy(agentId)) return;
      const running = db.prepare("SELECT * FROM jobs WHERE agent_id = ? AND status IN ('assigned','running') LIMIT 1")
        .get(agentId) as JobRow | undefined;
      if (running) return;
      const job = db.prepare("SELECT * FROM jobs WHERE agent_id = ? AND status = 'queued' ORDER BY created_at ASC LIMIT 1")
        .get(agentId) as JobRow | undefined;
      if (!job) return;

      const repo = db.prepare("SELECT * FROM repos WHERE agent_id = ? AND id = ?")
        .get(agentId, job.repo_id) as RepoRow | undefined;
      if (!repo) {
        failJobBeforeRun(job, `Project config not found for ${job.repo_id}.`);
        continue;
      }

      try {
        await syncAgentProjectConfig(agentId, repo);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === "agent_offline" || !agents.has(agentId)) return;
        failJobBeforeRun(job, `Project config sync failed before job start: ${message}`);
        continue;
      }

      const readyAgent = agents.get(agentId);
      if (!readyAgent || isAgentLocallyBusy(agentId)) return;
      const stamp = nowIso();
      db.prepare("UPDATE jobs SET status = 'assigned', started_at = ? WHERE id = ?").run(stamp, job.id);
      db.prepare("UPDATE agents SET current_job_id = ? WHERE id = ?").run(job.id, agentId);
      broadcast({ type: "job.updated", jobId: job.id, status: "assigned" });
      try {
        readyAgent.send({
          type: "job.run",
          job: {
            id: job.id,
            repoId: job.repo_id,
            chatId: job.chat_id ?? undefined,
            codexThreadId: latestThreadIdForChat(job.chat_id, job.id, job.kind),
            prompt: promptForAgentJob(job),
            sandbox: job.sandbox,
            branchMode: job.branch_mode,
            kind: job.kind,
            testCommandId: job.test_command_id ?? undefined,
            model: job.model ?? undefined,
            reasoningEffort: job.reasoning_effort ?? undefined,
            speed: job.speed ?? undefined,
            attachments: (db.prepare("SELECT * FROM job_attachments WHERE job_id = ? ORDER BY created_at ASC").all(job.id) as AttachmentRow[])
              .map((attachment) => ({
                name: attachment.name,
                mimeType: attachment.mime_type,
                size: attachment.size,
                dataBase64: attachment.data_base64
              }))
          }
        });
      } catch (error) {
        if (agents.get(agentId)?.connectionId === readyAgent.connectionId) agents.delete(agentId);
        db.prepare("UPDATE jobs SET status='queued', started_at=NULL WHERE id=?").run(job.id);
        db.prepare("UPDATE agents SET current_job_id = NULL, status = 'offline' WHERE id = ?").run(agentId);
        broadcast({ type: "agent.status", agentId, status: "offline" });
        broadcast({ type: "job.updated", jobId: job.id, status: "queued" });
      }
      return;
    }
  } finally {
    dispatchingAgents.delete(agentId);
  }
}

async function authenticateAgent(token: string | undefined): Promise<AgentRow | null> {
  if (!token) return null;
  const rows = db.prepare("SELECT * FROM agents").all() as AgentRow[];
  for (const row of rows) {
    if (await bcrypt.compare(token, row.token_hash)) return row;
  }
  return null;
}

function serializeJob(job: JobRow, options: { includeDiff?: boolean } = {}) {
  const includeDiff = options.includeDiff ?? true;
  const progress = parseJobProgress(job.progress_json);
  return {
    id: job.id,
    chatId: job.chat_id,
    agentId: job.agent_id,
    repoId: job.repo_id,
    prompt: job.prompt,
    sandbox: job.sandbox,
    branchMode: job.branch_mode,
    model: job.model,
    reasoningEffort: job.reasoning_effort,
    speed: job.speed,
    kind: job.kind,
    testCommandId: job.test_command_id,
    status: job.status,
    exitCode: job.exit_code,
    finalMessage: job.final_message,
    gitStatus: job.git_status,
    gitDiffStat: job.git_diff_stat,
    gitDiff: includeDiff ? job.git_diff : null,
    gitDiffOmitted: !includeDiff && Boolean(job.git_diff),
    progress,
    branchName: job.branch_name,
    codexThreadId: job.codex_thread_id,
    createdAt: job.created_at,
    startedAt: job.started_at,
    finishedAt: job.finished_at
  };
}

function parseJobProgress(value: string | null) {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Extract<AgentToServer, { type: "job.progress" }>;
    return parsed.type === "job.progress" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function serializeChat(chat: ChatRow) {
  return {
    id: chat.id,
    agentId: chat.agent_id,
    repoId: chat.repo_id,
    title: chat.title,
    source: chat.source,
    externalId: chat.external_id,
    cwd: chat.cwd,
    hiddenAt: chat.hidden_at,
    createdAt: chat.created_at,
    updatedAt: chat.updated_at
  };
}

function serializeAdminChat(chat: AdminChatRow) {
  return {
    ...serializeChat(chat),
    agentName: chat.agent_name,
    repoName: chat.repo_name,
    messageCount: chat.message_count,
    jobCount: chat.job_count
  };
}

function publicShareUrl(request: { protocol: string; hostname: string }, token: string): string {
  return `${publicOrigin(request)}/share/${encodeURIComponent(token)}`;
}

function projectUrlFromDomain(domain: string | null | undefined): string | null {
  const normalized = domain?.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/g, "");
  return normalized ? `https://${normalized}` : null;
}

function stripPrivateAttachmentUrls<T extends { attachments?: object[] }>(messages: T[]): T[] {
  return messages.map((message) => ({
    ...message,
    attachments: message.attachments?.map((attachment) => ({ ...attachment, url: undefined })) as T["attachments"]
  }));
}

function latestAssistantContent(messages: Array<{ role: string; content: string }>): string | null {
  return [...messages].reverse().find((message) => {
    if (message.role !== "assistant" || !message.content.trim()) return false;
    const metadata = "metadata" in message && message.metadata && typeof message.metadata === "object"
      ? message.metadata as Record<string, unknown>
      : {};
    return !metadata.status || metadata.status === "completed";
  })?.content.trim() ?? null;
}

function chatShareSnapshot(chat: ChatRow) {
  const jobs = db.prepare("SELECT * FROM jobs WHERE chat_id = ? ORDER BY created_at DESC").all(chat.id) as JobRow[];
  const rows = db.prepare("SELECT * FROM chat_messages WHERE chat_id = ? ORDER BY created_at ASC").all(chat.id) as ChatMessageRow[];
  const messages = stripPrivateAttachmentUrls(serializeMessagesForChat(chat.id, rows, { includeData: true }));
  return {
    exportedAt: nowIso(),
    chat: serializeChat(chat),
    jobs: jobs.map((row) => serializeJob(row, { includeDiff: false })),
    messages,
    finalAnswer: latestAssistantContent(messages)
  };
}

function serializeShare(row: ChatShareRow, request: { protocol: string; hostname: string }) {
  const repo = row.agent_id && row.repo_id
    ? db.prepare("SELECT name, domain FROM repos WHERE agent_id = ? AND id = ?").get(row.agent_id, row.repo_id) as { name: string; domain: string | null } | undefined
    : undefined;
  const projectUrl = projectUrlFromDomain(repo?.domain);
  const liveChat = row.chat_id
    ? db.prepare("SELECT * FROM chats WHERE id = ?").get(row.chat_id) as ChatRow | undefined
    : undefined;
  const snapshot = liveChat
    ? chatShareSnapshot(liveChat)
    : JSON.parse(row.snapshot_json) as { finalAnswer?: unknown };
  const finalContent = typeof snapshot.finalAnswer === "string" && snapshot.finalAnswer.trim()
    ? snapshot.finalAnswer
    : row.final_content;
  return {
    token: row.token,
    url: publicShareUrl(request, row.token),
    chatId: row.chat_id,
    agentId: row.agent_id,
    repoId: row.repo_id,
    project: repo ? {
      name: repo.name,
      domain: repo.domain,
      url: projectUrl
    } : null,
    title: row.title,
    source: row.source,
    externalId: row.external_id,
    finalContent,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    snapshot
  };
}

function upsertChatShareFromChat(chat: ChatRow): ChatShareRow {
  const snapshot = chatShareSnapshot(chat);
  const stamp = nowIso();
  const snapshotJson = JSON.stringify(snapshot);
  const existing = db.prepare("SELECT * FROM chat_shares WHERE chat_id = ?").get(chat.id) as ChatShareRow | undefined;
  if (existing) {
    db.prepare(`
      UPDATE chat_shares
      SET agent_id=?, repo_id=?, title=?, source=?, external_id=?, final_content=?, snapshot_json=?, updated_at=?
      WHERE token=?
    `).run(
      chat.agent_id,
      chat.repo_id,
      chat.title,
      chat.source,
      chat.external_id,
      snapshot.finalAnswer,
      snapshotJson,
      stamp,
      existing.token
    );
    return db.prepare("SELECT * FROM chat_shares WHERE token = ?").get(existing.token) as ChatShareRow;
  }
  const token = randomToken("share");
  db.prepare(`
    INSERT INTO chat_shares (token,chat_id,agent_id,repo_id,title,source,external_id,final_content,snapshot_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    token,
    chat.id,
    chat.agent_id,
    chat.repo_id,
    chat.title,
    chat.source,
    chat.external_id,
    snapshot.finalAnswer,
    snapshotJson,
    stamp,
    stamp
  );
  return db.prepare("SELECT * FROM chat_shares WHERE token = ?").get(token) as ChatShareRow;
}

function upsertChatShareFromLocalSync(agent: AgentRow, sync: Omit<Extract<AgentToServer, { type: "chat.sync" }>, "type">): ChatShareRow {
  const stamp = nowIso();
  const syncedMessages = sanitizeSyncedMessages(sync.messages);
  const syncTitle = syncedChatTitle(sync, syncedMessages).slice(0, 300);
  const messages = stripPrivateAttachmentUrls(syncedMessages.map((message, index) => ({
    id: message.id ?? `local_${sync.source}_${sync.externalId}_${index}`,
    chatId: `local:${sync.externalId}`,
    role: message.role,
    content: message.content,
    source: message.source,
    externalId: message.externalId,
    metadata: message.metadata,
    createdAt: message.createdAt,
    attachments: message.attachments?.map((attachment, attachmentIndex) => ({
      id: `${sync.externalId}:${index}:${attachmentIndex}`,
      name: attachment.name,
      mimeType: attachment.mimeType,
      size: attachment.size,
      dataBase64: isPreviewableImageMime(attachment.mimeType) ? attachment.dataBase64 : undefined,
      createdAt: message.createdAt
    }))
  })));
  const snapshot = {
    exportedAt: stamp,
    chat: {
      id: `local:${sync.externalId}`,
      agentId: agent.id,
      repoId: sync.repoId,
      title: syncTitle,
      source: sync.source,
      externalId: sync.externalId,
      cwd: sync.cwd,
      hiddenAt: null,
      createdAt: messages[0]?.createdAt ?? sync.updatedAt,
      updatedAt: sync.updatedAt
    },
    jobs: [],
    messages,
    finalAnswer: latestAssistantContent(messages)
  };
  const snapshotJson = JSON.stringify(snapshot);
  const existing = db.prepare("SELECT * FROM chat_shares WHERE agent_id = ? AND source = ? AND external_id = ? AND chat_id IS NULL")
    .get(agent.id, sync.source, sync.externalId) as ChatShareRow | undefined;
  if (existing) {
    db.prepare(`
      UPDATE chat_shares
      SET repo_id=?, title=?, final_content=?, snapshot_json=?, updated_at=?
      WHERE token=?
    `).run(sync.repoId, syncTitle, snapshot.finalAnswer, snapshotJson, stamp, existing.token);
    return db.prepare("SELECT * FROM chat_shares WHERE token = ?").get(existing.token) as ChatShareRow;
  }
  const token = randomToken("share");
  db.prepare(`
    INSERT INTO chat_shares (token,chat_id,agent_id,repo_id,title,source,external_id,final_content,snapshot_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(token, null, agent.id, sync.repoId, syncTitle, sync.source, sync.externalId, snapshot.finalAnswer, snapshotJson, stamp, stamp);
  return db.prepare("SELECT * FROM chat_shares WHERE token = ?").get(token) as ChatShareRow;
}

function chatEtag(chat: ChatRow, messages: ChatMessageRow[], jobs: JobRow[]) {
  const lastMessage = messages.at(-1);
  const value = JSON.stringify({
    id: chat.id,
    updatedAt: chat.updated_at,
    messageCount: messages.length,
    messages: messages.map((message) => [
      message.id,
      message.role,
      message.source,
      message.external_id,
      message.created_at,
      message.content.length,
      message.metadata_json?.length ?? 0
    ]),
    lastMessageHash: lastMessage
      ? createHash("sha256").update(lastMessage.content).update(lastMessage.metadata_json ?? "").digest("base64url")
      : "",
    jobCount: jobs.length,
    jobs: jobs.map((job) => [job.id, job.status, job.started_at, job.finished_at, job.git_diff_stat?.length ?? 0, job.git_diff?.length ?? 0, job.progress_json?.length ?? 0])
  });
  return `W/"${createHash("sha256").update(value).digest("base64url")}"`;
}

function projectIdFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 54);
  return slug || id("project");
}

function agentIdFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 54) || id("agent");
}

function uniqueAgentId(preferred: string): string {
  let candidate = preferred;
  let index = 2;
  while (db.prepare("SELECT 1 FROM agents WHERE id = ?").get(candidate)) {
    candidate = `${preferred.slice(0, 48)}-${index}`;
    index += 1;
  }
  return candidate;
}

type ZipEntry = {
  path: string;
  data: Buffer;
};

let crc32Table: Uint32Array | null = null;

function crc32(data: Buffer): number {
  if (!crc32Table) {
    crc32Table = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      crc32Table[index] = value >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ crc32Table[(crc ^ byte) & 0xff]!;
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

function createStoredZip(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  const stamp = dosDateTime();
  for (const entry of entries) {
    const name = Buffer.from(entry.path.replace(/\\/g, "/"), "utf8");
    const checksum = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + entry.data.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

function addFile(entries: ZipEntry[], from: string, to: string): void {
  entries.push({ path: to, data: readFileSync(from) });
}

function addDir(entries: ZipEntry[], fromDir: string, toDir: string): void {
  for (const name of readdirSync(fromDir)) {
    const from = join(fromDir, name);
    const to = `${toDir}/${name}`;
    const stat = statSync(from);
    if (stat.isDirectory()) addDir(entries, from, to);
    if (stat.isFile()) addFile(entries, from, to);
  }
}

function agentPackageZip(): Buffer {
  const root = process.cwd();
  const entries: ZipEntry[] = [];
  addFile(entries, join(root, "package.json"), "package.json");
  addFile(entries, join(root, "pnpm-lock.yaml"), "pnpm-lock.yaml");
  addFile(entries, join(root, "pnpm-workspace.yaml"), "pnpm-workspace.yaml");
  addFile(entries, join(root, "start-agent.bat"), "start-agent.bat");
  addFile(entries, join(root, "stop-agent.bat"), "stop-agent.bat");
  addFile(entries, join(root, "check-agent.bat"), "check-agent.bat");
  addFile(entries, join(root, "scripts", "run-agent.ps1"), "scripts/run-agent.ps1");
  addFile(entries, join(root, "scripts", "stop-agent.ps1"), "scripts/stop-agent.ps1");
  addFile(entries, join(root, "scripts", "check-agent.ps1"), "scripts/check-agent.ps1");
  addFile(entries, join(root, "scripts", "prepare-vscode-bridge.ps1"), "scripts/prepare-vscode-bridge.ps1");
  addFile(entries, join(root, "apps", "agent-windows", "package.json"), "apps/agent-windows/package.json");
  addDir(entries, join(root, "apps", "agent-windows", "dist"), "apps/agent-windows/dist");
  addFile(entries, join(root, "apps", "vscode-bridge", "package.json"), "apps/vscode-bridge/package.json");
  addDir(entries, join(root, "apps", "vscode-bridge", "dist"), "apps/vscode-bridge/dist");
  addDir(entries, join(root, "apps", "vscode-bridge", "resources"), "apps/vscode-bridge/resources");
  addFile(entries, join(root, "packages", "protocol", "package.json"), "packages/protocol/package.json");
  addDir(entries, join(root, "packages", "protocol", "dist"), "packages/protocol/dist");
  return createStoredZip(entries.sort((a, b) => a.path.localeCompare(b.path)));
}

type AgentSetupPlatform = "windows" | "linux";

function setupPlatformFromBody(body: unknown): AgentSetupPlatform {
  return body && typeof body === "object" && "setupPlatform" in body && body.setupPlatform === "linux" ? "linux" : "windows";
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function agentSetupPayload(request: { protocol: string; hostname: string }, agentId: string, token: string, platform: AgentSetupPlatform = "windows") {
  const origin = publicOrigin(request);
  const serverUrl = `${origin.replace(/^https:/, "wss:").replace(/^http:/, "ws:")}/api/agent/ws`;
  const packageUrl = `${origin}/api/agent/package.zip`;
  const configJson = JSON.stringify({
    agentId,
    platform,
    serverUrl,
    tokenEnv: "CMC_AGENT_TOKEN",
    heartbeatIntervalMs: 20000,
    maxJobDurationMs: 3600000,
    cancelGraceMs: 5000,
    maxLogBytesPerJob: 10485760,
    fakeRunner: false,
    repos: [],
    redactPatterns: [
      "sk-[A-Za-z0-9_-]+",
      "ghp_[A-Za-z0-9_]+",
      "OPENAI_API_KEY=\\S+",
      "OPENAI_ADMIN_KEY=\\S+",
      "XAI_API_KEY=\\S+",
      "GEMINI_API_KEY=\\S+",
      "GOOGLE_API_KEY=\\S+",
      "AIza[0-9A-Za-z_-]+",
      "cmc_agent_[A-Za-z0-9_-]+"
    ]
  }, null, 2);
  const encodedConfig = Buffer.from(configJson, "utf8").toString("base64");
  const setupPowerShell = [
    "$ErrorActionPreference = \"Stop\"",
    "$Root = Join-Path $env:USERPROFILE \"codex-agent\"",
    `$PackageUrl = "${packageUrl}"`,
    "if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { throw \"Install Node.js LTS first.\" }",
    "if (-not (Get-Command codex.cmd -ErrorAction SilentlyContinue)) { throw \"Install Codex CLI and run: codex login\" }",
    "New-Item -ItemType Directory -Force -Path $Root | Out-Null",
    "$Zip = Join-Path $Root \"agent-package.zip\"",
    "Invoke-WebRequest -Uri $PackageUrl -OutFile $Zip",
    "Expand-Archive -Path $Zip -DestinationPath $Root -Force",
    "Remove-Item -LiteralPath $Zip -Force",
    "Set-Location $Root",
    "corepack enable",
    "corepack pnpm install --prod --frozen-lockfile",
    `[Environment]::SetEnvironmentVariable("CMC_AGENT_TOKEN", "${token}", "User")`,
    `$config = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${encodedConfig}"))`,
    "$config | Set-Content -Path \"apps/agent-windows/agent.config.json\" -Encoding UTF8",
    ".\\start-agent.bat"
  ].join("\n");
  const setupBatch = [
    "@echo off",
    "setlocal",
    "set \"CODEX_AGENT_ROOT=%USERPROFILE%\\codex-agent\"",
    `set "CODEX_AGENT_PACKAGE_URL=${packageUrl}"`,
    `set "CODEX_AGENT_TOKEN=${token}"`,
    `set "CODEX_AGENT_CONFIG_B64=${encodedConfig}"`,
    "",
    "powershell -NoProfile -ExecutionPolicy Bypass -Command ^",
    "  \"$ErrorActionPreference='Stop'; \" ^",
    "  \"$root=$env:CODEX_AGENT_ROOT; \" ^",
    "  \"$packageUrl=$env:CODEX_AGENT_PACKAGE_URL; \" ^",
    "  \"if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { throw 'Install Node.js LTS first.' }; \" ^",
    "  \"if (-not (Get-Command codex.cmd -ErrorAction SilentlyContinue)) { throw 'Install Codex CLI and run: codex login' }; \" ^",
    "  \"New-Item -ItemType Directory -Force -Path $root | Out-Null; \" ^",
    "  \"$zip=Join-Path $root 'agent-package.zip'; \" ^",
    "  \"Invoke-WebRequest -Uri $packageUrl -OutFile $zip; \" ^",
    "  \"Expand-Archive -Path $zip -DestinationPath $root -Force; \" ^",
    "  \"Remove-Item -LiteralPath $zip -Force; \" ^",
    "  \"Set-Location $root; \" ^",
    "  \"corepack enable; \" ^",
    "  \"corepack pnpm install --prod --frozen-lockfile; \" ^",
    "  \"[Environment]::SetEnvironmentVariable('CMC_AGENT_TOKEN',$env:CODEX_AGENT_TOKEN,'User'); \" ^",
    "  \"$config=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:CODEX_AGENT_CONFIG_B64)); \" ^",
    "  \"$config | Set-Content -Path (Join-Path $root 'apps\\agent-windows\\agent.config.json') -Encoding UTF8; \" ^",
    "  \"& (Join-Path $root 'start-agent.bat')\"",
    "set \"CODEX_AGENT_SETUP_EXIT=%ERRORLEVEL%\"",
    "pause",
    "exit /b %CODEX_AGENT_SETUP_EXIT%"
  ].join("\r\n");
  const setupShell = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "ROOT=\"${CODEX_AGENT_ROOT:-$HOME/codex-agent}\"",
    `PACKAGE_URL=${shellSingleQuote(packageUrl)}`,
    `CMC_TOKEN=${shellSingleQuote(token)}`,
    `CONFIG_B64=${shellSingleQuote(encodedConfig)}`,
    "SERVICE_NAME=\"codex-agent-linux\"",
    "mkdir -p \"$ROOT/data\"",
    "if ! command -v node >/dev/null 2>&1; then echo \"Install Node.js 22 LTS first.\" >&2; exit 1; fi",
    "if ! command -v corepack >/dev/null 2>&1; then echo \"Install Corepack/Node.js 22 LTS first.\" >&2; exit 1; fi",
    "if ! command -v codex >/dev/null 2>&1; then echo \"Codex CLI is not installed yet. Install it and run: codex login\" >&2; fi",
    "ZIP=\"$ROOT/agent-package.zip\"",
    "if command -v curl >/dev/null 2>&1; then curl -fsSL \"$PACKAGE_URL\" -o \"$ZIP\"; elif command -v wget >/dev/null 2>&1; then wget -O \"$ZIP\" \"$PACKAGE_URL\"; else echo \"Install curl or wget first.\" >&2; exit 1; fi",
    "if command -v unzip >/dev/null 2>&1; then unzip -oq \"$ZIP\" -d \"$ROOT\"; elif command -v python3 >/dev/null 2>&1; then python3 -c 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' \"$ZIP\" \"$ROOT\"; else echo \"Install unzip or python3 first.\" >&2; exit 1; fi",
    "rm -f \"$ZIP\"",
    "cd \"$ROOT\"",
    "corepack enable",
    "corepack pnpm install --prod --frozen-lockfile",
    "export CONFIG_B64",
    "node -e \"const fs=require('fs'); fs.mkdirSync('apps/agent-windows',{recursive:true}); fs.writeFileSync('apps/agent-windows/agent.config.json', Buffer.from(process.env.CONFIG_B64,'base64').toString('utf8'));\"",
    "umask 077",
    "cat > agent.env <<ENV",
    "CMC_AGENT_TOKEN=$CMC_TOKEN",
    "GH_PROMPT_DISABLED=1",
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$HOME/.local/bin:$HOME/.npm-global/bin",
    "ENV",
    "chmod 600 agent.env",
    "cat > start-agent-linux.sh <<'SH'",
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "ROOT_DIR=\"$(cd \"$(dirname \"${BASH_SOURCE[0]}\")\" && pwd)\"",
    "cd \"$ROOT_DIR\"",
    "set -a",
    ". \"$ROOT_DIR/agent.env\"",
    "set +a",
    "exec node apps/agent-windows/dist/index.js --config apps/agent-windows/agent.config.json",
    "SH",
    "chmod +x start-agent-linux.sh",
    "cat > stop-agent-linux.sh <<'SH'",
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "systemctl stop codex-agent-linux.service 2>/dev/null || systemctl --user stop codex-agent-linux.service 2>/dev/null || pkill -f 'apps/agent-windows/dist/index.js --config apps/agent-windows/agent.config.json' || true",
    "SH",
    "chmod +x stop-agent-linux.sh",
    "NODE_BIN=\"$(command -v node)\"",
    "SERVICE_USER=\"$(id -un)\"",
    "SERVICE_HOME=\"$HOME\"",
    "SERVICE_FILE=\"$ROOT/$SERVICE_NAME.service\"",
    "cat > \"$SERVICE_FILE\" <<SERVICE",
    "[Unit]",
    "Description=xedoc.ru Linux agent",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    "User=$SERVICE_USER",
    "WorkingDirectory=$ROOT",
    "Environment=HOME=$SERVICE_HOME",
    "Environment=USER=$SERVICE_USER",
    "ExecStart=$ROOT/start-agent-linux.sh",
    "Restart=always",
    "RestartSec=3",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "SERVICE",
    "if [ \"$(id -u)\" -eq 0 ] && command -v systemctl >/dev/null 2>&1; then",
    "  cp \"$SERVICE_FILE\" \"/etc/systemd/system/$SERVICE_NAME.service\"",
    "  systemctl daemon-reload",
    "  systemctl enable --now \"$SERVICE_NAME.service\"",
    "elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null && command -v systemctl >/dev/null 2>&1; then",
    "  sudo cp \"$SERVICE_FILE\" \"/etc/systemd/system/$SERVICE_NAME.service\"",
    "  sudo systemctl daemon-reload",
    "  sudo systemctl enable --now \"$SERVICE_NAME.service\"",
    "else",
    "  USER_SERVICE_DIR=\"$HOME/.config/systemd/user\"",
    "  mkdir -p \"$USER_SERVICE_DIR\"",
    "  sed '/^User=/d; s/WantedBy=multi-user.target/WantedBy=default.target/' \"$SERVICE_FILE\" > \"$USER_SERVICE_DIR/$SERVICE_NAME.service\"",
    "  systemctl --user daemon-reload",
    "  systemctl --user enable --now \"$SERVICE_NAME.service\"",
    "  if command -v loginctl >/dev/null 2>&1 && command -v sudo >/dev/null 2>&1; then sudo loginctl enable-linger \"$SERVICE_USER\" || true; fi",
    "fi",
    "if command -v codex >/dev/null 2>&1; then codex login status || echo \"Run codex login for $SERVICE_USER if Codex is signed out.\"; fi",
    "echo \"Linux agent installed at $ROOT.\"",
    "echo \"Service: $SERVICE_NAME\""
  ].join("\n");
  return {
    agentId,
    platform,
    serverUrl,
    token,
    configJson,
    setupPowerShell,
    setupBatch,
    setupShell: platform === "linux" ? setupShell : undefined,
    setupFileName: platform === "linux" ? "setup-agent-linux.sh" : "setup-agent.bat",
    packageUrl
  };
}

async function tokenRequest(url: string, params: Record<string, string>, headers: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(params)
  });
  const text = await response.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    data = Object.fromEntries(new URLSearchParams(text)) as Record<string, unknown>;
  }
  if (!response.ok) throw new Error(String(data.error_description ?? data.error ?? "oauth_token_failed"));
  return data;
}

async function jsonGet(url: string, headers: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const response = await fetch(url, { headers });
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(data.error_description ?? data.error ?? "oauth_profile_failed"));
  return data;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function jwtPayload(token: unknown): Record<string, unknown> {
  const value = stringValue(token);
  if (!value) return {};
  const [, payload] = value.split(".");
  if (!payload) return {};
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function fetchOAuthProfile(
  provider: OAuthProviderId,
  code: string,
  redirectUri: string,
  client: { clientId: string; clientSecret: string },
  options: { codeVerifier?: string | null; deviceId?: string; state?: string } = {}
): Promise<OAuthProfile> {
  if (provider === "google") {
    const token = await tokenRequest("https://oauth2.googleapis.com/token", {
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri
    });
    const accessToken = stringValue(token.access_token);
    if (!accessToken) throw new Error("oauth_token_missing");
    const profile = await jsonGet("https://www.googleapis.com/oauth2/v3/userinfo", { authorization: `Bearer ${accessToken}` });
    const email = stringValue(profile.email);
    const providerUserId = stringValue(profile.sub);
    if (!email || !providerUserId) throw new Error("oauth_email_missing");
    return { provider, email: email.toLowerCase(), providerUserId, displayName: stringValue(profile.name) ?? email };
  }
  if (provider === "github") {
    const token = await tokenRequest("https://github.com/login/oauth/access_token", {
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code,
      redirect_uri: redirectUri
    }, { accept: "application/json" });
    const accessToken = stringValue(token.access_token);
    if (!accessToken) throw new Error("oauth_token_missing");
    const profile = await jsonGet("https://api.github.com/user", {
      authorization: `Bearer ${accessToken}`,
      accept: "application/vnd.github+json",
      "user-agent": PUBLIC_DOMAIN
    });
    let email = stringValue(profile.email);
    if (!email) {
      const emails = await fetch("https://api.github.com/user/emails", {
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/vnd.github+json",
          "user-agent": PUBLIC_DOMAIN
        }
      }).then((response) => response.json().catch(() => [])) as Array<Record<string, unknown>>;
      email = stringValue(emails.find((item) => item.primary === true && item.verified === true)?.email)
        ?? stringValue(emails.find((item) => item.verified === true)?.email);
    }
    const providerUserId = String(profile.id ?? "");
    if (!email || !providerUserId) throw new Error("oauth_email_missing");
    return { provider, email: email.toLowerCase(), providerUserId, displayName: stringValue(profile.name) ?? stringValue(profile.login) ?? email };
  }
  if (provider === "vk") {
    if (!options.codeVerifier) throw new Error("oauth_pkce_missing");
    const token = await tokenRequest("https://id.vk.ru/oauth2/auth", {
      client_id: client.clientId,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      code_verifier: options.codeVerifier,
      ...(options.deviceId ? { device_id: options.deviceId } : {}),
      ...(options.state ? { state: options.state } : {})
    });
    const accessToken = stringValue(token.access_token);
    const providerUserId = String(token.user_id ?? "");
    if (!accessToken || !providerUserId) throw new Error("oauth_token_missing");
    const idToken = jwtPayload(token.id_token);
    const userInfo = await tokenRequest("https://id.vk.ru/oauth2/user_info", {
      access_token: accessToken,
      client_id: client.clientId
    });
    const user = typeof userInfo.user === "object" && userInfo.user ? userInfo.user as Record<string, unknown> : userInfo;
    const email = stringValue(user.email)
      ?? stringValue(token.email)
      ?? stringValue(idToken.email)
      ?? `vk-${providerUserId}@users.noreply.${PUBLIC_DOMAIN}`;
    const userId = String(user.user_id ?? user.id ?? idToken.sub ?? providerUserId);
    if (!userId) throw new Error("oauth_profile_missing");
    const displayName = [stringValue(user.first_name), stringValue(user.last_name)].filter(Boolean).join(" ")
      || stringValue(user.name)
      || stringValue(idToken.name)
      || email;
    return { provider, email: email.toLowerCase(), providerUserId: userId, displayName };
  }
  const token = await tokenRequest("https://oauth.mail.ru/token", {
    client_id: client.clientId,
    client_secret: client.clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri
  });
  const accessToken = stringValue(token.access_token);
  if (!accessToken) throw new Error("oauth_token_missing");
  const profile = await jsonGet(`https://oauth.mail.ru/userinfo?access_token=${encodeURIComponent(accessToken)}`);
  const email = stringValue(profile.email);
  const providerUserId = String(profile.id ?? profile.uid ?? "");
  if (!email || !providerUserId) throw new Error("oauth_email_missing");
  return { provider, email: email.toLowerCase(), providerUserId, displayName: stringValue(profile.name) ?? stringValue(profile.nickname) ?? email };
}

function safeReturnTo(value: string | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  return value.slice(0, 300);
}

function userCount(): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number };
  return row.count;
}

async function createUserSession(reply: FastifyReply, userId: string) {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as UserRow;
  if (user.blocked_at) throw new Error("user_blocked");
  const session = await createSession(db, user.id);
  setSessionCookie(reply, config, session.id);
  return { user: serializeUser(user), csrfToken: session.csrf_token };
}

async function createOrLoginOAuthUser(profile: OAuthProfile, linkUserId?: string, allowCreate = false): Promise<{ userId: string; created: boolean }> {
  const stamp = nowIso();
  if (linkUserId) {
    const existing = db.prepare("SELECT user_id FROM oauth_connections WHERE provider = ? AND provider_user_id = ? AND user_id != ?")
      .get(profile.provider, profile.providerUserId, linkUserId) as { user_id: string } | undefined;
    if (existing) throw new Error("oauth_account_already_linked");
    db.prepare(`
      INSERT INTO oauth_connections (user_id,provider,provider_user_id,display_name,connected_at)
      VALUES (?,?,?,?,?)
      ON CONFLICT(user_id, provider) DO UPDATE SET
        provider_user_id=excluded.provider_user_id,
        display_name=excluded.display_name,
        connected_at=excluded.connected_at
    `).run(linkUserId, profile.provider, profile.providerUserId, profile.displayName ?? null, stamp);
    return { userId: linkUserId, created: false };
  }
  const connection = db.prepare("SELECT user_id FROM oauth_connections WHERE provider = ? AND provider_user_id = ?")
    .get(profile.provider, profile.providerUserId) as { user_id: string } | undefined;
  if (connection) return { userId: connection.user_id, created: false };
  let user = db.prepare("SELECT * FROM users WHERE email = ?").get(profile.email) as UserRow | undefined;
  let created = false;
  if (!user) {
    if (!allowCreate) throw new Error("registration_closed");
    const userId = id("usr");
    const role = profile.email === OWNER_ADMIN_EMAIL || userCount() === 0 ? "admin" : "user";
    db.prepare("INSERT INTO users (id,email,password_hash,role,nickname,created_at) VALUES (?,?,?,?,?,?)")
      .run(userId, profile.email, await hashSecret(randomToken("oauth_password")), role, null, stamp);
    user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as UserRow;
    created = true;
  }
  db.prepare("INSERT OR IGNORE INTO oauth_connections (user_id,provider,provider_user_id,display_name,connected_at) VALUES (?,?,?,?,?)")
    .run(user.id, profile.provider, profile.providerUserId, profile.displayName ?? null, stamp);
  return { userId: user.id, created };
}

async function createApp(): Promise<FastifyInstance> {
  const reconciledDuplicateChats = reconcileLinkedSyncedChatDuplicates();
  if (reconciledDuplicateChats) {
    console.log(`Merged ${reconciledDuplicateChats} duplicate synced Codex chat(s).`);
  }

  const app = Fastify({ logger: true, trustProxy: true, bodyLimit: 20 * 1024 * 1024 });
  await app.register(fastifyCookie);
  await app.register(fastifyWebsocket, {
    options: {
      maxPayload: WEBSOCKET_MAX_PAYLOAD_BYTES
    }
  });

  app.addHook("onRequest", async (_request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "SAMEORIGIN");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    reply.header("Content-Security-Policy", "default-src 'self'; connect-src 'self' ws: wss: https://mc.yandex.ru https://mc.yandex.com https://yastatic.net; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' https://mc.yandex.ru https://mc.yandex.com https://yastatic.net; img-src 'self' data: https://mc.yandex.ru https://mc.yandex.com https://yastatic.net; frame-src 'self' https:;");
    if (_request.method === "GET") {
      const url = new URL(_request.raw.url ?? "/", `https://${PUBLIC_DOMAIN}`);
      if (url.pathname === "/" && url.searchParams.get("cango") === REGISTRATION_GATE_VALUE) {
        setRegistrationGateCookie(reply);
      }
    }
  });

  app.addHook("preHandler", async (request) => {
    const auth = getSession(db, request);
    if (auth) markUserActivity(auth.user.id);
  });

  app.get("/api/health", async () => ({ ok: true, now: nowIso() }));

  app.get("/api/shared/chats/:token", async (request, reply) => {
    const token = (request.params as { token: string }).token;
    if (!/^share_[A-Za-z0-9_-]{20,120}$/.test(token)) return reply.code(404).send({ error: "not_found" });
    const share = db.prepare("SELECT * FROM chat_shares WHERE token = ?").get(token) as ChatShareRow | undefined;
    if (!share) return reply.code(404).send({ error: "not_found" });
    reply.header("Cache-Control", "public, max-age=60");
    return { share: serializeShare(share, request) };
  });

  app.get("/api/public/profiles/:slug", async (request, reply) => {
    const slug = (request.params as { slug: string }).slug.trim();
    if (!slug || slug.length > 180) return reply.code(404).send({ error: "not_found" });
    const user = db.prepare("SELECT * FROM users WHERE blocked_at IS NULL AND (id = ? OR lower(nickname) = lower(?))")
      .get(slug, slug) as UserRow | undefined;
    if (!user) return reply.code(404).send({ error: "not_found" });
    const rows = db.prepare(`
      SELECT
        r.*,
        u.id AS author_id,
        u.email AS author_email,
        u.nickname AS author_nickname,
        u.avatar_data_url AS author_avatar_data_url,
        u.bio AS author_bio,
        u.created_at AS author_created_at,
        (SELECT COUNT(*) FROM chats c WHERE c.agent_id = r.agent_id AND c.repo_id = r.id AND c.hidden_at IS NULL) AS chat_count
      FROM repos r
      JOIN agents a ON a.id = r.agent_id
      JOIN users u ON u.id = a.user_id
      WHERE a.user_id = ? AND r.visibility = 'public'
      ORDER BY r.updated_at DESC
      LIMIT 30
    `).all(user.id) as PublicProjectRow[];
    return {
      profile: serializePublicProfile(user, request),
      projects: rows.map((row) => serializePublicProject(row, request))
    };
  });

  app.get("/api/public/search", async (request, reply) => {
    const query = request.query as { type?: string; q?: string; limit?: string };
    const type = query.type === "profiles" ? "profiles" : "projects";
    const q = query.q?.trim().slice(0, 120) ?? "";
    const limit = Math.max(1, Math.min(30, Number(query.limit ?? 10) || 10));
    if (type === "profiles") {
      const args: string[] = [];
      const filters = ["blocked_at IS NULL"];
      if (q) {
        const like = `%${q.toLowerCase()}%`;
        filters.push("(lower(email) LIKE ? OR lower(COALESCE(nickname, '')) LIKE ? OR lower(COALESCE(bio, '')) LIKE ?)");
        args.push(like, like, like);
      }
      const rows = db.prepare(`
        SELECT * FROM users
        WHERE ${filters.join(" AND ")}
        ORDER BY created_at DESC
        LIMIT ?
      `).all(...args, limit) as UserRow[];
      return { type, profiles: rows.map((row) => serializePublicProfile(row, request)) };
    }

    const args: string[] = [];
    const filters = ["r.visibility = 'public'", "u.blocked_at IS NULL"];
    if (q) {
      const like = `%${q.toLowerCase()}%`;
      filters.push("(lower(r.name) LIKE ? OR lower(COALESCE(r.domain, '')) LIKE ? OR lower(COALESCE(r.github_url, '')) LIKE ? OR lower(COALESCE(u.nickname, '')) LIKE ? OR lower(u.email) LIKE ?)");
      args.push(like, like, like, like, like);
    }
    const rows = db.prepare(`
      SELECT
        r.*,
        u.id AS author_id,
        u.email AS author_email,
        u.nickname AS author_nickname,
        u.avatar_data_url AS author_avatar_data_url,
        u.bio AS author_bio,
        u.created_at AS author_created_at,
        (SELECT COUNT(*) FROM chats c WHERE c.agent_id = r.agent_id AND c.repo_id = r.id AND c.hidden_at IS NULL) AS chat_count
      FROM repos r
      JOIN agents a ON a.id = r.agent_id
      JOIN users u ON u.id = a.user_id
      WHERE ${filters.join(" AND ")}
      ORDER BY r.updated_at DESC
      LIMIT ?
    `).all(...args, limit) as PublicProjectRow[];
    return { type, projects: rows.map((row) => serializePublicProject(row, request)) };
  });

  app.get("/api/public/projects/:agentId/:repoId/chats", async (request, reply) => {
    const { agentId, repoId } = request.params as { agentId: string; repoId: string };
    const project = db.prepare(`
      SELECT 1
      FROM repos r
      JOIN agents a ON a.id = r.agent_id
      JOIN users u ON u.id = a.user_id
      WHERE r.agent_id = ? AND r.id = ? AND r.visibility = 'public' AND u.blocked_at IS NULL
    `).get(agentId, repoId) as { 1: number } | undefined;
    if (!project) return reply.code(404).send({ error: "not_found" });
    return { chats: publicChatSummaries(agentId, repoId, 100) };
  });

  app.get("/api/public/chats/:id", async (request, reply) => {
    const chatId = (request.params as { id: string }).id;
    const chat = db.prepare(`
      SELECT c.*
      FROM chats c
      JOIN repos r ON r.agent_id = c.agent_id AND r.id = c.repo_id
      JOIN agents a ON a.id = c.agent_id
      JOIN users u ON u.id = a.user_id
      WHERE c.id = ? AND c.hidden_at IS NULL AND r.visibility = 'public' AND u.blocked_at IS NULL
    `).get(chatId) as ChatRow | undefined;
    if (!chat) return reply.code(404).send({ error: "not_found" });
    const jobs = db.prepare("SELECT * FROM jobs WHERE chat_id = ? ORDER BY created_at DESC").all(chatId) as JobRow[];
    const messages = db.prepare("SELECT * FROM chat_messages WHERE chat_id = ? ORDER BY created_at ASC").all(chatId) as ChatMessageRow[];
    return {
      chat: serializeChat(chat),
      jobs: jobs.map((row) => serializeJob(row, { includeDiff: false })),
      messages: serializeMessagesForChat(chatId, messages, { includeChatDataLimitBytes: 1024 * 1024, lightMetadata: true })
    };
  });

  app.post("/api/agent/shared-chats", async (request, reply) => {
    const authHeader = request.headers.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : undefined;
    const agent = await authenticateAgent(token);
    if (!agent) return reply.code(401).send({ error: "invalid_token" });
    const parsed = AgentChatShareSchema.safeParse({ ...(request.body as Record<string, unknown> | null ?? {}), type: "chat.sync" });
    if (!parsed.success) return reply.code(400).send({ error: "invalid_chat_share", details: parsed.error.flatten() });
    const share = upsertChatShareFromLocalSync(agent, parsed.data);
    return reply.code(201).send({ ok: true, share: serializeShare(share, request), url: publicShareUrl(request, share.token) });
  });

  app.get("/api/oauth/providers", async () => ({ providers: oauthProviders() }));

  app.post("/api/oauth/:provider/start", async (request, reply) => {
    const provider = (request.params as { provider: string }).provider;
    if (!isOAuthProvider(provider)) return reply.code(404).send({ error: "provider_not_found" });
    const client = oauthClient(provider);
    if (!client) return reply.code(501).send({ error: "oauth_provider_not_configured", provider });
    const state = randomToken("oauth_state");
    const codeVerifier = provider === "vk" ? pkceVerifier() : null;
    const stamp = nowIso();
    db.prepare("DELETE FROM oauth_states WHERE expires_at < ?").run(stamp);
    db.prepare("INSERT INTO oauth_states (state,provider,user_id,return_to,code_verifier,created_at,expires_at) VALUES (?,?,?,?,?,?,?)")
      .run(state, provider, null, safeReturnTo((request.body as { returnTo?: string } | undefined)?.returnTo), codeVerifier, stamp, new Date(Date.now() + 10 * 60 * 1000).toISOString());
    return { url: oauthAuthorizeUrl(provider, client.clientId, oauthRedirectUri(request, provider), state, codeVerifier ? pkceChallenge(codeVerifier) : undefined) };
  });

  app.get("/api/oauth/:provider/callback", async (request, reply) => {
    const provider = (request.params as { provider: string }).provider;
    if (!isOAuthProvider(provider)) return reply.code(404).send("Provider not found.");
    const query = request.query as { code?: string; state?: string; error?: string; device_id?: string };
    if (query.error) return reply.redirect(`/?oauth_error=${encodeURIComponent(query.error)}`);
    if (!query.code || !query.state) return reply.code(400).send("Missing OAuth code/state.");
    const row = db.prepare("SELECT * FROM oauth_states WHERE state = ? AND provider = ?").get(query.state, provider) as OAuthStateRow | undefined;
    db.prepare("DELETE FROM oauth_states WHERE state = ?").run(query.state);
    if (!row || Date.parse(row.expires_at) < Date.now()) return reply.code(400).send("OAuth state expired.");
    const client = oauthClient(provider);
    if (!client) return reply.code(501).send("OAuth provider is not configured.");
    try {
      const profile = await fetchOAuthProfile(provider, query.code, oauthRedirectUri(request, provider), client, {
        codeVerifier: row.code_verifier,
        deviceId: query.device_id,
        state: query.state
      });
      const { userId, created } = await createOrLoginOAuthUser(profile, row.user_id ?? undefined, hasRegistrationGateCookie(request));
      if (row.user_id) return reply.redirect(safeReturnTo(row.return_to ?? "/profile"));
      await createUserSession(reply, userId);
      if (created) clearRegistrationGateCookie(reply);
      return reply.redirect(safeReturnTo(row.return_to ?? "/"));
    } catch (error) {
      request.log.warn({ provider, error: error instanceof Error ? error.message : String(error) }, "OAuth callback failed");
      return reply.redirect(`/?oauth_error=${encodeURIComponent(error instanceof Error && ["registration_closed", "user_blocked"].includes(error.message) ? error.message : "oauth_failed")}`);
    }
  });

  app.get("/api/me", async (request, reply) => {
    const auth = getSession(db, request);
    if (!auth) return reply.code(401).send({ user: null });
    return { user: serializeUser(auth.user), csrfToken: auth.session.csrf_token };
  });

  app.get("/api/profile", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth) return;
    return {
      user: serializeUser(auth.user),
      stats: profileStats(auth.user),
      oauth: oauthProviders(auth.user.id)
    };
  });

  app.put("/api/profile", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth || !requireCsrf(db, request, reply)) return;
    const parsed = ProfileUpdateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_profile", details: parsed.error.flatten() });
    const nickname = parsed.data.nickname ? parsed.data.nickname.trim().toLowerCase() : null;
    if (nickname) {
      const existing = db.prepare("SELECT id FROM users WHERE nickname = ? AND id != ?").get(nickname, auth.user.id) as { id: string } | undefined;
      if (existing) return reply.code(409).send({ error: "nickname_taken" });
    }
    const stamp = nowIso();
    db.prepare("UPDATE users SET nickname = ?, bio = ?, avatar_data_url = ?, updated_at = ? WHERE id = ?")
      .run(nickname, parsed.data.bio?.trim() || null, parsed.data.avatarDataUrl || null, stamp, auth.user.id);
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(auth.user.id) as UserRow;
    return { user: serializeUser(user), stats: profileStats(user), oauth: oauthProviders(user.id) };
  });

  app.post("/api/profile/password", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth || !requireCsrf(db, request, reply)) return;
    const parsed = PasswordUpdateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_password", details: parsed.error.flatten() });
    if (!(await verifySecret(parsed.data.currentPassword, auth.user.password_hash))) {
      return reply.code(403).send({ error: "invalid_current_password" });
    }
    db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
      .run(await hashSecret(parsed.data.newPassword), nowIso(), auth.user.id);
    return { ok: true };
  });

  app.post("/api/profile/oauth/:provider/start", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth || !requireCsrf(db, request, reply)) return;
    const provider = (request.params as { provider: string }).provider;
    if (!isOAuthProvider(provider)) return reply.code(404).send({ error: "provider_not_found" });
    const client = oauthClient(provider);
    if (!client) return reply.code(501).send({ error: "oauth_provider_not_configured", provider });
    const state = randomToken("oauth_state");
    const codeVerifier = provider === "vk" ? pkceVerifier() : null;
    const stamp = nowIso();
    db.prepare("DELETE FROM oauth_states WHERE expires_at < ?").run(stamp);
    db.prepare("INSERT INTO oauth_states (state,provider,user_id,return_to,code_verifier,created_at,expires_at) VALUES (?,?,?,?,?,?,?)")
      .run(state, provider, auth.user.id, "/profile", codeVerifier, stamp, new Date(Date.now() + 10 * 60 * 1000).toISOString());
    return { url: oauthAuthorizeUrl(provider, client.clientId, oauthRedirectUri(request, provider), state, codeVerifier ? pkceChallenge(codeVerifier) : undefined) };
  });

  app.post("/api/login", async (request, reply) => {
    const body = request.body as { email?: string; password?: string };
    const email = body.email?.trim().toLowerCase();
    if (!email || !body.password) return reply.code(400).send({ error: "email_and_password_required" });
    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email) as UserRow | undefined;
    if (user?.blocked_at) return reply.code(403).send({ error: "user_blocked" });
    if (!user || !(await verifySecret(body.password, user.password_hash))) {
      return reply.code(401).send({ error: "invalid_login" });
    }
    const session = await createSession(db, user.id);
    setSessionCookie(reply, config, session.id);
    return { user: serializeUser(user), csrfToken: session.csrf_token };
  });

  app.post("/api/register", async (request, reply) => {
    if (!hasRegistrationGateCookie(request)) return reply.code(403).send({ error: "registration_closed" });
    const parsed = RegisterSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_registration", details: parsed.error.flatten() });
    const email = parsed.data.email.trim().toLowerCase();
    const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string } | undefined;
    if (existing) return reply.code(409).send({ error: "user_exists" });
    const nickname = parsed.data.nickname ? parsed.data.nickname.trim().toLowerCase() : null;
    if (nickname) {
      const nicknameOwner = db.prepare("SELECT id FROM users WHERE nickname = ?").get(nickname) as { id: string } | undefined;
      if (nicknameOwner) return reply.code(409).send({ error: "nickname_taken" });
    }
    const userId = id("usr");
    const role = email === OWNER_ADMIN_EMAIL || userCount() === 0 ? "admin" : "user";
    db.prepare("INSERT INTO users (id,email,password_hash,role,nickname,created_at) VALUES (?,?,?,?,?,?)")
      .run(userId, email, await hashSecret(parsed.data.password), role, nickname, nowIso());
    const session = await createUserSession(reply, userId);
    clearRegistrationGateCookie(reply);
    return reply.code(201).send(session);
  });

  app.post("/api/logout", async (request, reply) => {
    if (!requireCsrf(db, request, reply)) return;
    const sessionId = request.cookies.cmc_session;
    if (sessionId) db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
    clearSessionCookie(reply, config);
    return { ok: true };
  });

  app.get("/api/users", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth || !requireAdminUser(auth, reply)) return;
    const rows = db.prepare("SELECT * FROM users ORDER BY created_at").all() as UserRow[];
    return { users: rows.map(serializeUser) };
  });

  app.post("/api/users", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth || !requireCsrf(db, request, reply) || !requireAdminUser(auth, reply)) return;
    const parsed = CreateUserSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_user", details: parsed.error.flatten() });
    const email = parsed.data.email.trim().toLowerCase();
    const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string } | undefined;
    if (existing) return reply.code(409).send({ error: "user_exists" });
    const userId = id("usr");
    db.prepare("INSERT INTO users (id,email,password_hash,role,created_at) VALUES (?,?,?,?,?)")
      .run(userId, email, await hashSecret(parsed.data.password), parsed.data.role, nowIso());
    return reply.code(201).send({ user: { id: userId, email, role: parsed.data.role } });
  });

  app.get("/api/admin/users", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth || !requireAdminUser(auth, reply)) return;
    const rows = db.prepare("SELECT * FROM users ORDER BY created_at DESC").all() as UserRow[];
    return { users: rows.map(serializeAdminUser) };
  });

  app.post("/api/admin/users/:id/password", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth || !requireCsrf(db, request, reply) || !requireAdminUser(auth, reply)) return;
    const userId = (request.params as { id: string }).id;
    const body = request.body as { password?: unknown } | undefined;
    const password = typeof body?.password === "string" ? body.password : "";
    if (password.length < 8) return reply.code(400).send({ error: "invalid_password" });
    const target = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as UserRow | undefined;
    if (!target) return reply.code(404).send({ error: "user_not_found" });
    db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
      .run(await hashSecret(password), nowIso(), userId);
    return { ok: true, user: serializeAdminUser(db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as UserRow) };
  });

  app.post("/api/admin/users/:id/block", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth || !requireCsrf(db, request, reply) || !requireAdminUser(auth, reply)) return;
    const userId = (request.params as { id: string }).id;
    if (userId === auth.user.id) return reply.code(400).send({ error: "cannot_block_self" });
    const body = request.body as { blocked?: unknown } | undefined;
    if (typeof body?.blocked !== "boolean") return reply.code(400).send({ error: "invalid_block_state" });
    const target = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as UserRow | undefined;
    if (!target) return reply.code(404).send({ error: "user_not_found" });
    const stamp = nowIso();
    db.prepare("UPDATE users SET blocked_at = ?, updated_at = ? WHERE id = ?")
      .run(body.blocked ? stamp : null, stamp, userId);
    if (body.blocked) db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
    return { ok: true, user: serializeAdminUser(db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as UserRow) };
  });

  app.post("/api/admin/users/:id/impersonate", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth || !requireCsrf(db, request, reply) || !requireAdminUser(auth, reply)) return;
    const userId = (request.params as { id: string }).id;
    const target = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as UserRow | undefined;
    if (!target) return reply.code(404).send({ error: "user_not_found" });
    if (target.blocked_at) return reply.code(403).send({ error: "user_blocked" });
    const session = await createSession(db, target.id);
    setSessionCookie(reply, config, session.id);
    return { user: serializeUser(target), csrfToken: session.csrf_token };
  });

  app.get("/api/admin/users/:id/chats", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth || !requireAdminUser(auth, reply)) return;
    const userId = (request.params as { id: string }).id;
    const target = db.prepare("SELECT id FROM users WHERE id = ?").get(userId) as { id: string } | undefined;
    if (!target) return reply.code(404).send({ error: "user_not_found" });
    const rows = db.prepare(`
      SELECT
        c.*,
        a.name AS agent_name,
        r.name AS repo_name,
        (SELECT COUNT(*) FROM chat_messages m WHERE m.chat_id = c.id) AS message_count,
        (SELECT COUNT(*) FROM jobs j WHERE j.chat_id = c.id) AS job_count
      FROM chats c
      JOIN agents a ON a.id = c.agent_id
      LEFT JOIN repos r ON r.agent_id = c.agent_id AND r.id = c.repo_id
      WHERE a.user_id = ?
      ORDER BY c.updated_at DESC
      LIMIT 300
    `).all(userId) as AdminChatRow[];
    return { chats: rows.map(serializeAdminChat) };
  });

  app.get("/api/admin/stats", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth || !requireAdminUser(auth, reply)) return;
    const query = request.query as { days?: string };
    const days = Number(query.days ?? 30);
    return { series: adminStatsSeries(Number.isFinite(days) ? days : 30) };
  });

  app.get("/api/agent/package.zip", async (_request, reply) => {
    try {
      const zip = agentPackageZip();
      return reply
        .header("content-type", "application/zip")
        .header("content-disposition", "attachment; filename=\"codex-agent-package.zip\"")
        .header("cache-control", "no-store")
        .send(zip);
    } catch (error) {
      return reply.code(500).send({ error: "agent_package_unavailable", message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/agents", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth || !requireCsrf(db, request, reply)) return;
    const parsed = CreateAgentSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_agent", details: parsed.error.flatten() });
    const ownerId = parsed.data.userId && isAdmin(auth.user) ? parsed.data.userId : auth.user.id;
    const owner = db.prepare("SELECT id FROM users WHERE id = ?").get(ownerId) as { id: string } | undefined;
    if (!owner) return reply.code(404).send({ error: "user_not_found" });
    const agentId = uniqueAgentId(parsed.data.id?.trim() || agentIdFromName(parsed.data.name));
    const token = randomToken("cmc_agent");
    db.prepare("INSERT INTO agents (id,user_id,name,token_hash,status,created_at) VALUES (?,?,?,?,?,?)")
      .run(agentId, ownerId, parsed.data.name.trim(), await hashSecret(token), "offline", nowIso());
    const setup = agentSetupPayload({ protocol: request.protocol, hostname: request.hostname }, agentId, token, parsed.data.setupPlatform);
    return reply.code(201).send({ agent: { id: agentId, name: parsed.data.name.trim(), userId: ownerId }, setup });
  });

  app.post("/api/agents/:agentId/setup", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth || !requireCsrf(db, request, reply)) return;
    const agentId = (request.params as { agentId: string }).agentId;
    if (!canAccessAgent(auth.user, agentId)) return reply.code(404).send({ error: "not_found" });
    if (agents.has(agentId)) return reply.code(409).send({ error: "agent_online" });
    const agent = db.prepare("SELECT id FROM agents WHERE id = ?").get(agentId) as { id: string } | undefined;
    if (!agent) return reply.code(404).send({ error: "not_found" });
    const token = randomToken("cmc_agent");
    db.prepare("UPDATE agents SET token_hash = ?, status = 'offline', last_seen_at = ? WHERE id = ?")
      .run(await hashSecret(token), nowIso(), agentId);
    const setup = agentSetupPayload({ protocol: request.protocol, hostname: request.hostname }, agentId, token, setupPlatformFromBody(request.body));
    return { setup };
  });

  app.delete("/api/agents/:agentId", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth || !requireCsrf(db, request, reply)) return;
    const agentId = (request.params as { agentId: string }).agentId;
    if (!canAccessAgent(auth.user, agentId)) return reply.code(404).send({ error: "not_found" });
    if (agents.has(agentId)) return reply.code(409).send({ error: "agent_online" });
    const agent = db.prepare("SELECT id FROM agents WHERE id = ?").get(agentId) as { id: string } | undefined;
    if (!agent) return reply.code(404).send({ error: "not_found" });
    const counts = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM repos WHERE agent_id = ?) AS repos,
        (SELECT COUNT(*) FROM chats WHERE agent_id = ?) AS chats,
        (SELECT COUNT(*) FROM jobs WHERE agent_id = ?) AS jobs
    `).get(agentId, agentId, agentId) as { repos: number; chats: number; jobs: number };
    if (counts.repos || counts.chats || counts.jobs) {
      return reply.code(409).send({ error: "agent_has_data", counts });
    }
    db.prepare("DELETE FROM agents WHERE id = ?").run(agentId);
    return { ok: true };
  });

  app.get("/api/agents", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth) return;
    const rows = db.prepare(`SELECT id,user_id,name,hostname,os,agent_version,codex_version,grok_version,git_version,codex_usage_json,grok_usage_json,local_activity_json,status,current_job_id,last_seen_at,created_at FROM agents ${agentAccessWhere(auth.user)} ORDER BY created_at`)
      .all(...agentAccessArgs(auth.user)) as AgentRow[];
    return {
      agents: rows.map((row) => {
        const online = agents.has(row.id);
        return {
          ...row,
          status: online ? "online" : "offline",
          current_job_id: online ? row.current_job_id : null,
          codexUsage: parseCodexUsage(row.codex_usage_json),
          grokUsage: parseCodexUsage(row.grok_usage_json),
          localActivity: freshLocalActivity(parseLocalActivity(row.local_activity_json), row.id)
        };
      })
    };
  });

  app.get("/api/repos", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth) return;
    const rows = db.prepare(`
      SELECT r.* FROM repos r
      JOIN agents a ON a.id = r.agent_id
      ${isAdmin(auth.user) ? "" : "WHERE a.user_id = ?"}
      ORDER BY r.name
    `).all(...(isAdmin(auth.user) ? [] : [auth.user.id])) as RepoRow[];
    return { repos: rows.map((row) => ({ ...mapRepo(row), agentId: row.agent_id, updatedAt: row.updated_at })) };
  });

  app.post("/api/projects", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth || !requireCsrf(db, request, reply)) return;
    const parsed = CreateProjectSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_project", details: parsed.error.flatten() });
    if (!canAccessAgent(auth.user, parsed.data.agentId)) return reply.code(404).send({ error: "agent_not_found" });
    let repoId = projectIdFromName(parsed.data.name);
    const existing = db.prepare("SELECT * FROM repos WHERE agent_id = ? AND id = ?")
      .get(parsed.data.agentId, repoId) as RepoRow | undefined;
    if (existing) repoId = `${repoId}-${Date.now().toString(36)}`;
    try {
      const result = await requestAgentProject(parsed.data.agentId, {
        type: "project.create",
        requestId: id("req"),
        project: {
          id: repoId,
          name: parsed.data.name,
          path: parsed.data.path,
          githubUrl: parsed.data.githubUrl?.trim() || undefined,
          serverPath: parsed.data.serverPath?.trim() || undefined,
          domain: parsed.data.domain?.trim() || undefined,
          deploy: parsed.data.deploy ?? undefined,
          data: parsed.data.data ?? undefined,
          defaultSandbox: parsed.data.defaultSandbox,
          allowedSandboxes: ["read-only", "workspace-write", "danger-full-access"]
        }
      });
      if (!result.ok) return reply.code(400).send({ error: result.error ?? "project_create_failed" });
      if (result.repos) upsertRepos(parsed.data.agentId, result.repos);
      db.prepare("UPDATE repos SET visibility = ?, updated_at = ? WHERE agent_id = ? AND id = ?")
        .run(parsed.data.visibility, nowIso(), parsed.data.agentId, repoId);
      return reply.code(201).send({ repoId });
    } catch (error) {
      return reply.code(503).send({ error: error instanceof Error ? error.message : "agent_error" });
    }
  });

  app.put("/api/projects/:agentId/:repoId", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth || !requireCsrf(db, request, reply)) return;
    const params = request.params as { agentId: string; repoId: string };
    if (!canAccessRepo(auth.user, params.agentId, params.repoId)) return reply.code(404).send({ error: "repo_not_found" });
    const parsed = UpdateProjectSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_project", details: parsed.error.flatten() });
    const { visibility, deploy, data, targetAgentId, ...agentPatch } = parsed.data;
    const deployProvided = Object.prototype.hasOwnProperty.call(parsed.data, "deploy");
    const dataProvided = Object.prototype.hasOwnProperty.call(parsed.data, "data");
    const agentPatchKeys = Object.keys(agentPatch).filter((key) => (agentPatch as Record<string, unknown>)[key] !== undefined);
    const nextAgentId = targetAgentId?.trim();
    try {
      if (nextAgentId && nextAgentId !== params.agentId) {
        if (!canAccessAgent(auth.user, nextAgentId)) return reply.code(404).send({ error: "target_agent_not_found" });
        const sourceRepo = db.prepare("SELECT * FROM repos WHERE agent_id = ? AND id = ?")
          .get(params.agentId, params.repoId) as RepoRow | undefined;
        if (!sourceRepo) return reply.code(404).send({ error: "repo_not_found" });
        const existingTargetRepo = db.prepare("SELECT 1 FROM repos WHERE agent_id = ? AND id = ?")
          .get(nextAgentId, params.repoId) as { 1: number } | undefined;
        if (existingTargetRepo) return reply.code(409).send({ error: "target_project_exists" });
        if (activeProjectJob(params.agentId, params.repoId)) return reply.code(409).send({ error: "project_has_running_job" });
        const fullPatch = fullProjectPatchFromRepo(sourceRepo);
        const migrationPatch = {
          ...fullPatch,
          ...agentPatch,
          ...(deployProvided ? { deploy } : {}),
          ...(dataProvided ? { data } : {})
        };
        const result = await requestAgentProject(nextAgentId, {
          type: "project.update",
          requestId: id("req"),
          repoId: params.repoId,
          patch: migrationPatch
        });
        if (!result.ok) return reply.code(400).send({ error: result.error ?? "project_update_failed" });
        if (result.repos) upsertRepos(nextAgentId, result.repos);
        moveProjectRowsToAgent(params.agentId, nextAgentId, params.repoId, migrationPatch, visibility ?? sourceRepo.visibility);
        broadcast({ type: "repos.updated", agentId: params.agentId, repos: repoInfosForAgent(params.agentId) });
        broadcast({ type: "repos.updated", agentId: nextAgentId, repos: repoInfosForAgent(nextAgentId) });
        broadcast({ type: "chats.updated", agentId: params.agentId, repoId: params.repoId });
        broadcast({ type: "chats.updated", agentId: nextAgentId, repoId: params.repoId });
        return { ok: true, agentId: nextAgentId, repoId: params.repoId };
      }
      if (agentPatchKeys.length) {
        const result = await requestAgentProject(params.agentId, {
          type: "project.update",
          requestId: id("req"),
          repoId: params.repoId,
          patch: {
            ...agentPatch,
            ...(deployProvided ? { deploy } : {}),
            ...(dataProvided ? { data } : {})
          }
        });
        if (!result.ok) return reply.code(400).send({ error: result.error ?? "project_update_failed" });
        if (result.repos) upsertRepos(params.agentId, result.repos);
      }
      const controllerSettingsUpdated = updateControllerProjectSettings(params.agentId, params.repoId, {
        visibility,
        deploy: deploy ?? null,
        data: data ?? null
      }, { deploy: deployProvided, data: dataProvided });
      if (controllerSettingsUpdated) {
        broadcast({ type: "repos.updated", agentId: params.agentId, repos: repoInfosForAgent(params.agentId) });
      }
      if (!agentPatchKeys.length && controllerSettingsUpdated && (deployProvided || dataProvided) && agents.has(params.agentId)) {
        const repo = db.prepare("SELECT * FROM repos WHERE agent_id = ? AND id = ?")
          .get(params.agentId, params.repoId) as RepoRow | undefined;
        if (repo) {
          void syncAgentProjectConfig(params.agentId, repo).catch((error) => {
            request.log.warn({
              agentId: params.agentId,
              repoId: params.repoId,
              error: error instanceof Error ? error.message : String(error)
            }, "Deferred project config sync failed");
          });
        }
      }
      return { ok: true };
    } catch (error) {
      return reply.code(503).send({ error: error instanceof Error ? error.message : "agent_error" });
    }
  });

  app.delete("/api/projects/:agentId/:repoId", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth || !requireCsrf(db, request, reply)) return;
    const params = request.params as { agentId: string; repoId: string };
    if (!canAccessRepo(auth.user, params.agentId, params.repoId)) return reply.code(404).send({ error: "repo_not_found" });
    const repo = db.prepare("SELECT * FROM repos WHERE agent_id = ? AND id = ?")
      .get(params.agentId, params.repoId) as RepoRow | undefined;
    if (!repo) return reply.code(404).send({ error: "repo_not_found" });
    const active = db.prepare("SELECT id FROM jobs WHERE agent_id = ? AND repo_id = ? AND status IN ('queued','assigned','running') LIMIT 1")
      .get(params.agentId, params.repoId) as { id: string } | undefined;
    if (active) return reply.code(409).send({ error: "project_has_running_job" });
    try {
      const result = await requestAgentProject(params.agentId, {
        type: "project.delete",
        requestId: id("req"),
        repoId: params.repoId
      });
      if (!result.ok) return reply.code(400).send({ error: result.error ?? "project_delete_failed" });
      const chatRows = db.prepare("SELECT id FROM chats WHERE agent_id = ? AND repo_id = ?")
        .all(params.agentId, params.repoId) as Array<{ id: string }>;
      const jobRows = db.prepare("SELECT id FROM jobs WHERE agent_id = ? AND repo_id = ?")
        .all(params.agentId, params.repoId) as Array<{ id: string }>;
      db.exec("BEGIN");
      try {
        for (const job of jobRows) db.prepare("DELETE FROM job_logs WHERE job_id = ?").run(job.id);
        db.prepare("DELETE FROM jobs WHERE agent_id = ? AND repo_id = ?").run(params.agentId, params.repoId);
        for (const chat of chatRows) db.prepare("DELETE FROM chat_messages WHERE chat_id = ?").run(chat.id);
        db.prepare("DELETE FROM chats WHERE agent_id = ? AND repo_id = ?").run(params.agentId, params.repoId);
        db.prepare("DELETE FROM deleted_chat_sync WHERE agent_id = ? AND repo_id = ?").run(params.agentId, params.repoId);
        db.prepare("DELETE FROM repos WHERE agent_id = ? AND id = ?").run(params.agentId, params.repoId);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      if (result.repos) upsertRepos(params.agentId, result.repos);
      broadcast({ type: "repos.updated", agentId: params.agentId, repos: result.repos ?? [] });
      return { ok: true };
    } catch (error) {
      return reply.code(503).send({ error: error instanceof Error ? error.message : "agent_error" });
    }
  });

  app.post("/api/projects/:agentId/:repoId/git-sync", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth || !requireCsrf(db, request, reply)) return;
    const params = request.params as { agentId: string; repoId: string };
    if (!canAccessRepo(auth.user, params.agentId, params.repoId)) return reply.code(404).send({ error: "repo_not_found" });
    const parsed = GitSyncSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_git_sync", details: parsed.error.flatten() });
    const repo = db.prepare("SELECT * FROM repos WHERE agent_id = ? AND id = ?")
      .get(params.agentId, params.repoId) as RepoRow | undefined;
    if (!repo) return reply.code(404).send({ error: "repo_not_found" });
    const operationChat = parsed.data.chatId ? projectOperationChat(auth.user, params.agentId, params.repoId, parsed.data.chatId) : undefined;
    if (parsed.data.chatId && !operationChat) return reply.code(404).send({ error: "chat_not_found" });
    const requestId = id("req");
    const operationMessageId = operationChat ? id("msg") : "";
    const operationDetails = [`Сообщение коммита: \`${safeInlineCode(parsed.data.message)}\`.`];
    if (operationChat) {
      appendProjectOperationMessage({
        chat: operationChat,
        messageId: operationMessageId,
        requestId,
        operation: "git-sync",
        label: "Commit & push",
        status: "running",
        repoName: repo.name,
        details: operationDetails
      });
    }
    try {
      await syncAgentProjectConfig(params.agentId, repo);
      const result = await requestAgentGit(params.agentId, {
        type: "git.sync",
        requestId,
        repoId: params.repoId,
        message: parsed.data.message,
        remoteUrl: parsed.data.remoteUrl?.trim() || undefined,
        createRemote: parsed.data.createRemote,
        remoteVisibility: parsed.data.remoteVisibility
      });
      if (!result.ok) {
        if (operationChat) {
          appendProjectOperationMessage({
            chat: operationChat,
            messageId: operationMessageId,
            requestId,
            operation: "git-sync",
            label: "Commit & push",
            status: "failed",
            repoName: repo.name,
            output: result.output || result.error || "Git sync failed.",
            details: operationDetails
          });
        }
        return reply.code(400).send({ error: result.error ?? "git_sync_failed", output: result.output });
      }
      if (result.repos) upsertRepos(params.agentId, result.repos);
      if (operationChat) {
        appendProjectOperationMessage({
          chat: operationChat,
          messageId: operationMessageId,
          requestId,
          operation: "git-sync",
          label: "Commit & push",
          status: "completed",
          repoName: repo.name,
          output: result.output || result.status || "Git sync completed.",
          details: operationDetails
        });
      }
      return { ok: true, output: result.output, status: result.status, chatMessageId: operationMessageId || undefined };
    } catch (error) {
      if (operationChat) {
        appendProjectOperationMessage({
          chat: operationChat,
          messageId: operationMessageId,
          requestId,
          operation: "git-sync",
          label: "Commit & push",
          status: "failed",
          repoName: repo.name,
          output: error instanceof Error ? error.message : "agent_error",
          details: operationDetails
        });
      }
      return reply.code(503).send({ error: error instanceof Error ? error.message : "agent_error" });
    }
  });

  app.post("/api/projects/:agentId/:repoId/deploy", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth || !requireCsrf(db, request, reply)) return;
    const params = request.params as { agentId: string; repoId: string };
    if (!canAccessRepo(auth.user, params.agentId, params.repoId)) return reply.code(404).send({ error: "repo_not_found" });
    const parsed = DeploySchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_deploy", details: parsed.error.flatten() });
    const repo = db.prepare("SELECT * FROM repos WHERE agent_id = ? AND id = ?")
      .get(params.agentId, params.repoId) as RepoRow | undefined;
    if (!repo) return reply.code(404).send({ error: "repo_not_found" });
    const operationChat = parsed.data.chatId ? projectOperationChat(auth.user, params.agentId, params.repoId, parsed.data.chatId) : undefined;
    if (parsed.data.chatId && !operationChat) return reply.code(404).send({ error: "chat_not_found" });
    const requestId = id("req");
    const operationMessageId = operationChat ? id("msg") : "";
    if (operationChat) {
      appendProjectOperationMessage({
        chat: operationChat,
        messageId: operationMessageId,
        requestId,
        operation: "deploy",
        label: "Deploy",
        status: "running",
        repoName: repo.name
      });
    }
    try {
      await syncAgentProjectConfig(params.agentId, repo);
      const result = await requestAgentDeploy(params.agentId, {
        type: "project.deploy",
        requestId,
        repoId: params.repoId
      });
      if (!result.ok) {
        if (operationChat) {
          appendProjectOperationMessage({
            chat: operationChat,
            messageId: operationMessageId,
            requestId,
            operation: "deploy",
            label: "Deploy",
            status: "failed",
            repoName: repo.name,
            output: result.output || result.error || "Deploy failed."
          });
        }
        return reply.code(400).send({ error: result.error ?? "deploy_failed", output: result.output });
      }
      if (result.repos) upsertRepos(params.agentId, result.repos);
      if (operationChat) {
        appendProjectOperationMessage({
          chat: operationChat,
          messageId: operationMessageId,
          requestId,
          operation: "deploy",
          label: "Deploy",
          status: "completed",
          repoName: repo.name,
          output: result.output || "Deploy completed."
        });
      }
      return { ok: true, output: result.output, chatMessageId: operationMessageId || undefined };
    } catch (error) {
      if (operationChat) {
        appendProjectOperationMessage({
          chat: operationChat,
          messageId: operationMessageId,
          requestId,
          operation: "deploy",
          label: "Deploy",
          status: "failed",
          repoName: repo.name,
          output: error instanceof Error ? error.message : "agent_error"
        });
      }
      return reply.code(503).send({ error: error instanceof Error ? error.message : "agent_error" });
    }
  });

  app.post("/api/projects/:agentId/:repoId/build", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth || !requireCsrf(db, request, reply)) return;
    const params = request.params as { agentId: string; repoId: string };
    if (!canAccessRepo(auth.user, params.agentId, params.repoId)) return reply.code(404).send({ error: "repo_not_found" });
    const repo = db.prepare("SELECT * FROM repos WHERE agent_id = ? AND id = ?")
      .get(params.agentId, params.repoId) as RepoRow | undefined;
    if (!repo) return reply.code(404).send({ error: "repo_not_found" });
    try {
      await syncAgentProjectConfig(params.agentId, repo);
      const result = await requestAgentProjectCommand(params.agentId, {
        type: "project.command",
        requestId: id("req"),
        repoId: params.repoId,
        command: "build"
      });
      if (!result.ok) return reply.code(400).send({ error: result.error ?? "build_failed", output: result.output });
      return { ok: true, output: result.output };
    } catch (error) {
      return reply.code(503).send({ error: error instanceof Error ? error.message : "agent_error" });
    }
  });

  app.post("/api/projects/:agentId/:repoId/nginx", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth || !requireCsrf(db, request, reply)) return;
    const params = request.params as { agentId: string; repoId: string };
    if (!canAccessRepo(auth.user, params.agentId, params.repoId)) return reply.code(404).send({ error: "repo_not_found" });
    const parsed = NginxSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_nginx", details: parsed.error.flatten() });
    const repo = db.prepare("SELECT * FROM repos WHERE agent_id = ? AND id = ?")
      .get(params.agentId, params.repoId) as RepoRow | undefined;
    if (!repo) return reply.code(404).send({ error: "repo_not_found" });
    const operationChat = parsed.data.chatId ? projectOperationChat(auth.user, params.agentId, params.repoId, parsed.data.chatId) : undefined;
    if (parsed.data.chatId && !operationChat) return reply.code(404).send({ error: "chat_not_found" });
    const requestId = id("req");
    const operationMessageId = operationChat ? id("msg") : "";
    if (operationChat) {
      appendProjectOperationMessage({
        chat: operationChat,
        messageId: operationMessageId,
        requestId,
        operation: "nginx",
        label: "Nginx",
        status: "running",
        repoName: repo.name
      });
    }
    try {
      await syncAgentProjectConfig(params.agentId, repo);
      const result = await requestAgentNginx(params.agentId, {
        type: "project.nginx",
        requestId,
        repoId: params.repoId
      });
      if (!result.ok) {
        if (operationChat) {
          appendProjectOperationMessage({
            chat: operationChat,
            messageId: operationMessageId,
            requestId,
            operation: "nginx",
            label: "Nginx",
            status: "failed",
            repoName: repo.name,
            output: result.output || result.error || "Nginx setup failed."
          });
        }
        return reply.code(400).send({ error: result.error ?? "nginx_failed", output: result.output });
      }
      if (result.repos) upsertRepos(params.agentId, result.repos);
      if (operationChat) {
        appendProjectOperationMessage({
          chat: operationChat,
          messageId: operationMessageId,
          requestId,
          operation: "nginx",
          label: "Nginx",
          status: "completed",
          repoName: repo.name,
          output: result.output || "Nginx configured."
        });
      }
      return { ok: true, output: result.output, chatMessageId: operationMessageId || undefined };
    } catch (error) {
      if (operationChat) {
        appendProjectOperationMessage({
          chat: operationChat,
          messageId: operationMessageId,
          requestId,
          operation: "nginx",
          label: "Nginx",
          status: "failed",
          repoName: repo.name,
          output: error instanceof Error ? error.message : "agent_error"
        });
      }
      return reply.code(503).send({ error: error instanceof Error ? error.message : "agent_error" });
    }
  });

  app.post("/api/projects/:agentId/:repoId/ssl", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth || !requireCsrf(db, request, reply)) return;
    const params = request.params as { agentId: string; repoId: string };
    if (!canAccessRepo(auth.user, params.agentId, params.repoId)) return reply.code(404).send({ error: "repo_not_found" });
    const parsed = SslSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_ssl", details: parsed.error.flatten() });
    const repo = db.prepare("SELECT * FROM repos WHERE agent_id = ? AND id = ?")
      .get(params.agentId, params.repoId) as RepoRow | undefined;
    if (!repo) return reply.code(404).send({ error: "repo_not_found" });
    const operationChat = parsed.data.chatId ? projectOperationChat(auth.user, params.agentId, params.repoId, parsed.data.chatId) : undefined;
    if (parsed.data.chatId && !operationChat) return reply.code(404).send({ error: "chat_not_found" });
    const requestId = id("req");
    const operationMessageId = operationChat ? id("msg") : "";
    if (operationChat) {
      appendProjectOperationMessage({
        chat: operationChat,
        messageId: operationMessageId,
        requestId,
        operation: "ssl",
        label: "SSL",
        status: "running",
        repoName: repo.name
      });
    }
    try {
      await syncAgentProjectConfig(params.agentId, repo);
      const result = await requestAgentSsl(params.agentId, {
        type: "project.ssl",
        requestId,
        repoId: params.repoId
      });
      if (!result.ok) {
        if (operationChat) {
          appendProjectOperationMessage({
            chat: operationChat,
            messageId: operationMessageId,
            requestId,
            operation: "ssl",
            label: "SSL",
            status: "failed",
            repoName: repo.name,
            output: result.output || result.error || "SSL setup failed."
          });
        }
        return reply.code(400).send({ error: result.error ?? "ssl_failed", output: result.output });
      }
      if (result.repos) upsertRepos(params.agentId, result.repos);
      if (operationChat) {
        appendProjectOperationMessage({
          chat: operationChat,
          messageId: operationMessageId,
          requestId,
          operation: "ssl",
          label: "SSL",
          status: "completed",
          repoName: repo.name,
          output: result.output || "SSL configured."
        });
      }
      return { ok: true, output: result.output, chatMessageId: operationMessageId || undefined };
    } catch (error) {
      if (operationChat) {
        appendProjectOperationMessage({
          chat: operationChat,
          messageId: operationMessageId,
          requestId,
          operation: "ssl",
          label: "SSL",
          status: "failed",
          repoName: repo.name,
          output: error instanceof Error ? error.message : "agent_error"
        });
      }
      return reply.code(503).send({ error: error instanceof Error ? error.message : "agent_error" });
    }
  });

  app.post("/api/agents/:agentId/vscode-command", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth || !requireCsrf(db, request, reply)) return;
    const { agentId } = request.params as { agentId: string };
    if (!canAccessAgent(auth.user, agentId)) return reply.code(404).send({ error: "agent_not_found" });
    const parsed = VscodeCommandRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_vscode_command", details: parsed.error.flatten() });
    try {
      const result = await requestAgentVscode(agentId, {
        type: "vscode.command",
        requestId: id("req"),
        command: parsed.data.command,
        text: parsed.data.text?.trim() || undefined,
        filePath: parsed.data.filePath?.trim() || undefined,
        threadId: parsed.data.threadId?.trim() || undefined
      });
      if (!result.ok) return reply.code(400).send({ error: result.error ?? "vscode_command_failed", output: result.output });
      return { ok: true, output: result.output };
    } catch (error) {
      return reply.code(503).send({ error: error instanceof Error ? error.message : "agent_error" });
    }
  });

  app.get("/api/projects/:agentId/:repoId/files/list", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth) return;
    const params = request.params as { agentId: string; repoId: string };
    if (!canAccessRepo(auth.user, params.agentId, params.repoId)) return reply.code(404).send({ error: "repo_not_found" });
    const parsed = ProjectFileListQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_path", details: parsed.error.flatten() });
    try {
      const result = await requestAgentFile(params.agentId, {
        type: "file.list",
        requestId: id("req"),
        repoId: params.repoId,
        path: parsed.data.path ?? ""
      });
      if (!result.ok) return reply.code(400).send({ error: result.error || "file_list_failed" });
      return { entries: result.entries ?? [] };
    } catch (error) {
      return reply.code(503).send({ error: error instanceof Error ? error.message : "agent_error" });
    }
  });

  app.get("/api/projects/:agentId/:repoId/files/read", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth) return;
    const params = request.params as { agentId: string; repoId: string };
    if (!canAccessRepo(auth.user, params.agentId, params.repoId)) return reply.code(404).send({ error: "repo_not_found" });
    const parsed = ProjectFileReadQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_file", details: parsed.error.flatten() });
    try {
      const result = await requestAgentFile(params.agentId, {
        type: "file.read",
        requestId: id("req"),
        repoId: params.repoId,
        path: parsed.data.path
      });
      if (!result.ok) return reply.code(400).send({ error: result.error ?? "file_read_failed" });
      return {
        ok: true,
        path: result.path ?? parsed.data.path,
        content: result.content ?? "",
        binary: Boolean(result.binary),
        mimeType: result.mimeType,
        dataBase64: result.dataBase64,
        size: result.size,
        mtimeMs: result.mtimeMs
      };
    } catch (error) {
      return reply.code(503).send({ error: error instanceof Error ? error.message : "agent_error" });
    }
  });

  app.put("/api/projects/:agentId/:repoId/files/write", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth || !requireCsrf(db, request, reply)) return;
    const params = request.params as { agentId: string; repoId: string };
    if (!canAccessRepo(auth.user, params.agentId, params.repoId)) return reply.code(404).send({ error: "repo_not_found" });
    const parsed = ProjectFileWriteSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_file", details: parsed.error.flatten() });
    try {
      const result = await requestAgentFile(params.agentId, {
        type: "file.write",
        requestId: id("req"),
        repoId: params.repoId,
        path: parsed.data.path,
        content: parsed.data.content
      });
      if (!result.ok) return reply.code(400).send({ error: result.error ?? "file_write_failed" });
      return { ok: true, path: result.path ?? parsed.data.path, size: result.size, mtimeMs: result.mtimeMs };
    } catch (error) {
      return reply.code(503).send({ error: error instanceof Error ? error.message : "agent_error" });
    }
  });

  app.post("/api/agents/:agentId/sync-local-chats", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth || !requireCsrf(db, request, reply)) return;
    const { agentId } = request.params as { agentId: string };
    if (!canAccessAgent(auth.user, agentId)) return reply.code(404).send({ error: "agent_not_found" });
    const started = startAgentChatSync(agentId, {
      type: "chat.sync.request",
      requestId: id("req")
    });
    if (!started) return reply.code(503).send({ error: "agent_offline" });
    return reply.code(202).send({ ok: true, accepted: true });
  });

  app.get("/api/chats", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth) return;
    const query = request.query as { agentId?: string; repoId?: string; includeHidden?: string; localOnly?: string };
    if (!query.agentId || !query.repoId) return reply.code(400).send({ error: "agent_and_repo_required" });
    if (!canAccessRepo(auth.user, query.agentId, query.repoId)) return reply.code(404).send({ error: "repo_not_found" });
    const filters = ["agent_id = ?", "repo_id = ?"];
    const args = [query.agentId, query.repoId];
    if (query.includeHidden !== "1") filters.push("hidden_at IS NULL");
    if (query.localOnly === "1") filters.push("source IN ('codex','vscode')");
    const rows = db.prepare(`SELECT * FROM chats WHERE ${filters.join(" AND ")} ORDER BY updated_at DESC`)
      .all(...args) as ChatRow[];
    return { chats: rows.map(serializeChat) };
  });

  app.post("/api/chats", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth || !requireCsrf(db, request, reply)) return;
    const parsed = CreateChatSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_chat", details: parsed.error.flatten() });
    if (!canAccessRepo(auth.user, parsed.data.agentId, parsed.data.repoId)) return reply.code(404).send({ error: "repo_not_found" });
    const repo = db.prepare("SELECT * FROM repos WHERE agent_id = ? AND id = ?")
      .get(parsed.data.agentId, parsed.data.repoId) as RepoRow | undefined;
    if (!repo) return reply.code(404).send({ error: "repo_not_found" });
    const chatId = id("chat");
    const stamp = nowIso();
    db.prepare("INSERT INTO chats (id,agent_id,repo_id,title,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .run(chatId, parsed.data.agentId, parsed.data.repoId, parsed.data.title, stamp, stamp);
    appendChatMessage({
      chat_id: chatId,
      role: "system",
      content: "Chat created on xedoc.ru.",
      source: "web",
      external_id: `chat:${chatId}:created`,
      metadata_json: null,
      created_at: stamp
    });
    broadcast({ type: "chats.updated", agentId: parsed.data.agentId, repoId: parsed.data.repoId });
    return reply.code(201).send({ chatId });
  });

  app.get("/api/chats/:id", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth) return;
    const chatId = (request.params as { id: string }).id;
    if (!canAccessChat(auth.user, chatId)) return reply.code(404).send({ error: "not_found" });
    const chat = db.prepare("SELECT * FROM chats WHERE id = ?").get(chatId) as ChatRow | undefined;
    if (!chat) return reply.code(404).send({ error: "not_found" });
    const rows = db.prepare("SELECT * FROM jobs WHERE chat_id = ? ORDER BY created_at DESC").all(chatId) as JobRow[];
    const messages = db.prepare("SELECT * FROM chat_messages WHERE chat_id = ? ORDER BY created_at ASC").all(chatId) as ChatMessageRow[];
    const etag = chatEtag(chat, messages, rows);
    reply.header("ETag", etag);
    reply.header("Cache-Control", "private, max-age=0, must-revalidate");
    if (request.headers["if-none-match"] === etag) return reply.code(304).send();
    return {
      chat: serializeChat(chat),
      jobs: rows.map((row) => serializeJob(row, { includeDiff: false })),
      messages: serializeMessagesForChat(chatId, messages, { includeChatDataLimitBytes: 1024 * 1024, lightMetadata: true })
    };
  });

  app.post("/api/chats/:id/share", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth || !requireCsrf(db, request, reply)) return;
    const chatId = (request.params as { id: string }).id;
    if (!canAccessChat(auth.user, chatId)) return reply.code(404).send({ error: "not_found" });
    const chat = db.prepare("SELECT * FROM chats WHERE id = ?").get(chatId) as ChatRow | undefined;
    if (!chat) return reply.code(404).send({ error: "not_found" });
    const share = upsertChatShareFromChat(chat);
    return reply.code(201).send({ ok: true, share: serializeShare(share, request), url: publicShareUrl(request, share.token) });
  });

  app.get("/api/chat-messages/:id/details", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth) return;
    const messageId = (request.params as { id: string }).id;
    const message = db.prepare("SELECT * FROM chat_messages WHERE id = ?").get(messageId) as ChatMessageRow | undefined;
    if (!message || !canAccessChat(auth.user, message.chat_id)) return reply.code(404).send({ error: "not_found" });
    return { message: serializeMessage(message, { includeData: true }) };
  });

  app.get("/api/job-attachments/:id", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth) return;
    const attachmentId = (request.params as { id: string }).id;
    const row = db.prepare(`
      SELECT a.*, j.chat_id AS chat_id
      FROM job_attachments a
      JOIN jobs j ON j.id = a.job_id
      WHERE a.id = ?
    `).get(attachmentId) as (AttachmentRow & { chat_id: string | null }) | undefined;
    if (!row) return reply.code(404).send({ error: "not_found" });
    const allowed = row.chat_id ? canAccessChat(auth.user, row.chat_id) : canAccessJob(auth.user, row.job_id);
    if (!allowed) return reply.code(404).send({ error: "not_found" });
    return sendAttachment(reply, row);
  });

  app.get("/api/chat-attachments/:id", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth) return;
    const attachmentId = (request.params as { id: string }).id;
    const row = db.prepare(`
      SELECT a.*, m.chat_id AS chat_id
      FROM chat_attachments a
      JOIN chat_messages m ON m.id = a.chat_message_id
      WHERE a.id = ?
    `).get(attachmentId) as (ChatAttachmentRow & { chat_id: string }) | undefined;
    if (!row || !canAccessChat(auth.user, row.chat_id)) return reply.code(404).send({ error: "not_found" });
    return sendAttachment(reply, row);
  });

  app.put("/api/chats/:id", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth || !requireCsrf(db, request, reply)) return;
    const chatId = (request.params as { id: string }).id;
    if (!canAccessChat(auth.user, chatId)) return reply.code(404).send({ error: "not_found" });
    const parsed = UpdateChatSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_chat", details: parsed.error.flatten() });
    const body = parsed.data;
    const chat = db.prepare("SELECT * FROM chats WHERE id = ?").get(chatId) as ChatRow | undefined;
    if (!chat) return reply.code(404).send({ error: "not_found" });
    const stamp = nowIso();
    if (body.linkedChatId) {
      const linked = db.prepare("SELECT * FROM chats WHERE id = ? AND agent_id = ? AND repo_id = ? AND source IN ('codex','vscode')")
        .get(body.linkedChatId, chat.agent_id, chat.repo_id) as ChatRow | undefined;
      if (!linked) return reply.code(404).send({ error: "linked_chat_not_found" });
      const nextTitle = body.title ?? linked.title;
      db.prepare("UPDATE chats SET title=?, title_override=?, hidden_at=NULL, updated_at=? WHERE id=?")
        .run(nextTitle, body.title ?? linked.title_override, stamp, linked.id);
      if (linked.id !== chatId) {
        const currentMessages = db.prepare("SELECT id FROM chat_messages WHERE chat_id = ? LIMIT 1").get(chatId) as { id: string } | undefined;
        if (!currentMessages) db.prepare("UPDATE chats SET hidden_at = COALESCE(hidden_at, ?), updated_at=? WHERE id=?").run(stamp, stamp, chatId);
      }
    } else {
      const nextTitle = body.title;
      if (!nextTitle) return reply.code(400).send({ error: "title_required" });
      db.prepare("UPDATE chats SET title=?, title_override=?, updated_at=? WHERE id=?")
        .run(nextTitle, nextTitle, stamp, chatId);
    }
    const updated = db.prepare("SELECT * FROM chats WHERE id = ?").get(body.linkedChatId || chatId) as ChatRow;
    broadcast({ type: "chats.updated", agentId: updated.agent_id, repoId: updated.repo_id, chatId: updated.id });
    return { chat: serializeChat(updated) };
  });

  app.post("/api/chats/:id/hide", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth || !requireCsrf(db, request, reply)) return;
    const chatId = (request.params as { id: string }).id;
    if (!canAccessChat(auth.user, chatId)) return reply.code(404).send({ error: "not_found" });
    const running = db.prepare("SELECT id FROM jobs WHERE chat_id = ? AND status IN ('queued','assigned','running') LIMIT 1").get(chatId) as { id: string } | undefined;
    if (running) return reply.code(409).send({ error: "chat_has_running_job" });
    const chat = db.prepare("SELECT * FROM chats WHERE id = ?").get(chatId) as ChatRow | undefined;
    if (!chat) return reply.code(404).send({ error: "not_found" });
    db.prepare("UPDATE chats SET hidden_at = COALESCE(hidden_at, ?), updated_at = ? WHERE id = ?").run(nowIso(), nowIso(), chatId);
    broadcast({ type: "chats.updated", agentId: chat.agent_id, repoId: chat.repo_id });
    return { ok: true };
  });

  app.post("/api/chats/:id/unhide", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth || !requireCsrf(db, request, reply)) return;
    const chatId = (request.params as { id: string }).id;
    if (!canAccessChat(auth.user, chatId)) return reply.code(404).send({ error: "not_found" });
    const chat = db.prepare("SELECT * FROM chats WHERE id = ?").get(chatId) as ChatRow | undefined;
    if (!chat) return reply.code(404).send({ error: "not_found" });
    db.prepare("UPDATE chats SET hidden_at = NULL, updated_at = ? WHERE id = ?").run(nowIso(), chatId);
    broadcast({ type: "chats.updated", agentId: chat.agent_id, repoId: chat.repo_id });
    return { chat: serializeChat({ ...chat, hidden_at: null, updated_at: nowIso() }) };
  });

  app.delete("/api/chats/:id", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth || !requireCsrf(db, request, reply)) return;
    const chatId = (request.params as { id: string }).id;
    if (!canAccessChat(auth.user, chatId)) return reply.code(404).send({ error: "not_found" });
    const chat = db.prepare("SELECT * FROM chats WHERE id = ?").get(chatId) as ChatRow | undefined;
    if (!chat) return reply.code(404).send({ error: "not_found" });
    const active = db.prepare("SELECT id FROM jobs WHERE chat_id = ? AND status IN ('queued','assigned','running') LIMIT 1")
      .get(chatId) as { id: string } | undefined;
    if (active) return reply.code(409).send({ error: "chat_has_running_job" });
    const jobRows = db.prepare("SELECT id, codex_thread_id FROM jobs WHERE chat_id = ?").all(chatId) as Array<{ id: string; codex_thread_id: string | null }>;
    db.exec("BEGIN");
    try {
      tombstoneDeletedChat(chat, jobRows);
      for (const job of jobRows) db.prepare("DELETE FROM job_logs WHERE job_id = ?").run(job.id);
      db.prepare("DELETE FROM jobs WHERE chat_id = ?").run(chatId);
      db.prepare("DELETE FROM chat_messages WHERE chat_id = ?").run(chatId);
      db.prepare("DELETE FROM chats WHERE id = ?").run(chatId);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    broadcast({ type: "chats.updated", agentId: chat.agent_id, repoId: chat.repo_id });
    return { ok: true };
  });

  app.get("/api/jobs", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth) return;
    const query = request.query as { chatId?: string };
    if (query.chatId && !canAccessChat(auth.user, query.chatId)) return reply.code(404).send({ error: "chat_not_found" });
    const rows = query.chatId
      ? db.prepare("SELECT * FROM jobs WHERE chat_id = ? ORDER BY created_at DESC LIMIT 50").all(query.chatId) as JobRow[]
      : db.prepare(`
          SELECT j.* FROM jobs j
          JOIN agents a ON a.id = j.agent_id
          ${isAdmin(auth.user) ? "" : "WHERE a.user_id = ?"}
          ORDER BY j.created_at DESC LIMIT 50
        `).all(...(isAdmin(auth.user) ? [] : [auth.user.id])) as JobRow[];
    return { jobs: rows.map((row) => serializeJob(row)) };
  });

  app.get("/api/jobs/:id", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth) return;
    const jobId = (request.params as { id: string }).id;
    if (!canAccessJob(auth.user, jobId)) return reply.code(404).send({ error: "not_found" });
    const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as JobRow | undefined;
    if (!job) return reply.code(404).send({ error: "not_found" });
    const logs = db.prepare("SELECT * FROM job_logs WHERE job_id = ? ORDER BY at ASC").all(jobId) as LogRow[];
    return { job: serializeJob(job), logs };
  });

  app.post("/api/jobs", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth || !requireCsrf(db, request, reply)) return;
    const parsed = CreateJobSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_job", details: parsed.error.flatten() });
    if (!canAccessRepo(auth.user, parsed.data.agentId, parsed.data.repoId)) return reply.code(404).send({ error: "repo_not_found" });
    const repo = db.prepare("SELECT * FROM repos WHERE agent_id = ? AND id = ?")
      .get(parsed.data.agentId, parsed.data.repoId) as RepoRow | undefined;
    if (!repo) return reply.code(404).send({ error: "repo_not_found" });
    const allowed = JSON.parse(repo.allowed_sandboxes) as string[];
    if (!allowed.includes(parsed.data.sandbox)) return reply.code(400).send({ error: "sandbox_not_allowed" });
    if (isAgentLocallyBusy(parsed.data.agentId)) return reply.code(409).send({ error: "agent_local_busy" });
    const attachmentTotal = parsed.data.attachments.reduce((sum, attachment) => sum + attachment.size, 0);
    if (attachmentTotal > 12 * 1024 * 1024) return reply.code(400).send({ error: "attachments_too_large" });
    let chatId = parsed.data.chatId;
    if (chatId) {
      const chat = db.prepare("SELECT * FROM chats WHERE id = ? AND agent_id = ? AND repo_id = ?")
        .get(chatId, parsed.data.agentId, parsed.data.repoId) as ChatRow | undefined;
      if (!chat) return reply.code(404).send({ error: "chat_not_found" });
    } else {
      chatId = id("chat");
      const stamp = nowIso();
      db.prepare("INSERT INTO chats (id,agent_id,repo_id,title,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
        .run(chatId, parsed.data.agentId, parsed.data.repoId, parsed.data.prompt.slice(0, 80), "web", stamp, stamp);
      broadcast({ type: "chats.updated", agentId: parsed.data.agentId, repoId: parsed.data.repoId });
    }
    const jobId = id("job");
    const createdAt = nowIso();
    const promptMessageId = id("msg");
    const displayPrompt = parsed.data.displayPrompt?.trim() || parsed.data.prompt;
    db.prepare(`
      INSERT INTO jobs (id,chat_id,agent_id,repo_id,prompt,sandbox,branch_mode,model,reasoning_effort,speed,kind,status,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      jobId,
      chatId,
      parsed.data.agentId,
      parsed.data.repoId,
      parsed.data.prompt,
      parsed.data.sandbox,
      parsed.data.branchMode,
      parsed.data.model ?? null,
      parsed.data.reasoningEffort ?? null,
      parsed.data.speed ?? null,
      parsed.data.kind,
      "queued",
      createdAt
    );
    appendChatMessage({
      id: promptMessageId,
      chat_id: chatId,
      role: "user",
      content: displayPrompt,
      source: "web",
      external_id: `job:${jobId}:prompt`,
      metadata_json: JSON.stringify({
        jobId,
        prompt: parsed.data.prompt,
        model: parsed.data.model,
        reasoningEffort: parsed.data.reasoningEffort,
        speed: parsed.data.speed,
        kind: parsed.data.kind
      }),
      created_at: createdAt
    });
    storeJobAttachments(jobId, promptMessageId, parsed.data.attachments, createdAt);
    db.prepare("UPDATE chats SET updated_at = ? WHERE id = ?").run(createdAt, chatId);
    broadcast({ type: "chats.updated", agentId: parsed.data.agentId, repoId: parsed.data.repoId });
    broadcast({ type: "job.created", jobId });
    broadcast({ type: "job.updated", jobId, status: "queued" });
    void dispatchQueue(parsed.data.agentId);
    return reply.code(201).send({ jobId });
  });

  app.post("/api/jobs/:id/cancel", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth || !requireCsrf(db, request, reply)) return;
    const jobId = (request.params as { id: string }).id;
    if (!canAccessJob(auth.user, jobId)) return reply.code(404).send({ error: "not_found" });
    const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as JobRow | undefined;
    if (!job) return reply.code(404).send({ error: "not_found" });
    if (!["queued", "assigned", "running"].includes(job.status)) return { ok: true };
    if (job.status === "queued") {
      db.prepare("UPDATE jobs SET status = 'cancelled', finished_at = ? WHERE id = ?").run(nowIso(), jobId);
      broadcast({ type: "job.updated", jobId, status: "cancelled" });
      return { ok: true };
    }
    sendAgent(job.agent_id, { type: "job.cancel", jobId });
    appendLog({ job_id: jobId, stream: "system", message: "Cancel requested from mobile UI.", at: nowIso() });
    return { ok: true };
  });

  app.get("/api/ui/ws", { websocket: true }, (socket, request) => {
    const auth = getSession(db, request);
    if (!auth) {
      socket.close(1008, "unauthorized");
      return;
    }
    const client = {
      user: { id: auth.user.id, role: auth.user.role },
      send: (event: UiEvent) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
      }
    };
    uiClients.add(client);
    socket.on("close", () => uiClients.delete(client));
  });

  app.get("/api/agent/ws", { websocket: true }, async (socket, request) => {
    const authHeader = request.headers.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : undefined;
    const agent = await authenticateAgent(token);
    if (!agent) {
      socket.close(1008, "invalid token");
      return;
    }
    const connectionId = id("agent_ws");
    const previous = agents.get(agent.id);
    if (previous) {
      rejectAgentRequestsForConnection(agent.id, previous.connectionId, "agent_replaced");
      previous.close();
    }
    const connection: AgentConnection = {
      id: agent.id,
      connectionId,
      send: (message) => {
        if (socket.readyState !== socket.OPEN) throw new Error("agent_socket_closed");
        socket.send(JSON.stringify(message));
      },
      close: () => {
        if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) socket.close(1000, "replaced");
      }
    };
    agents.set(agent.id, connection);
    markAgentStatus(agent.id, "online");
    void dispatchQueue(agent.id);

    socket.on("message", (raw) => {
      let parsed: AgentToServer;
      try {
        parsed = AgentToServerSchema.parse(JSON.parse(raw.toString()));
      } catch (error) {
        request.log.warn({
          error: error instanceof Error ? error.message : String(error),
          bytes: Buffer.byteLength(raw.toString())
        }, "Invalid agent websocket message");
        socket.close(1003, "invalid message");
        return;
      }
      if (parsed.type === "agent.hello") {
        if (parsed.agentId !== agent.id) {
          socket.close(1008, "agent id mismatch");
          return;
        }
        db.prepare(`
          UPDATE agents SET hostname=?, os=?, agent_version=?, codex_version=?, grok_version=?, git_version=?, codex_usage_json=?, grok_usage_json=?, local_activity_json=?, last_seen_at=?, status='online'
          WHERE id=?
        `).run(
          parsed.hostname,
          parsed.os,
          parsed.agentVersion,
          parsed.codexVersion ?? null,
          parsed.grokVersion ?? null,
          parsed.gitVersion ?? null,
          parsed.codexUsage ? JSON.stringify(parsed.codexUsage) : null,
          parsed.grokUsage ? JSON.stringify(parsed.grokUsage) : null,
          parsed.localActivity ? JSON.stringify(parsed.localActivity) : null,
          nowIso(),
          agent.id
        );
        if (parsed.localActivity) broadcastAgentActivity(agent.id, parsed.localActivity);
        upsertRepos(agent.id, parsed.repos);
        void dispatchQueue(agent.id);
      }
      if (parsed.type === "agent.heartbeat") {
        const localActivityJson = parsed.localActivity ? JSON.stringify(parsed.localActivity) : null;
        if (parsed.codexUsage || parsed.grokUsage) {
          db.prepare("UPDATE agents SET last_seen_at=?, current_job_id=?, codex_usage_json=COALESCE(?, codex_usage_json), grok_usage_json=COALESCE(?, grok_usage_json), local_activity_json=COALESCE(?, local_activity_json) WHERE id=?")
            .run(
              nowIso(),
              parsed.currentJobId ?? null,
              parsed.codexUsage ? JSON.stringify(parsed.codexUsage) : null,
              parsed.grokUsage ? JSON.stringify(parsed.grokUsage) : null,
              localActivityJson,
              agent.id
            );
        } else {
          db.prepare("UPDATE agents SET last_seen_at=?, current_job_id=?, local_activity_json=COALESCE(?, local_activity_json) WHERE id=?").run(nowIso(), parsed.currentJobId ?? null, localActivityJson, agent.id);
        }
        if (parsed.localActivity) broadcastAgentActivity(agent.id, parsed.localActivity);
        if (parsed.repos) upsertRepos(agent.id, parsed.repos);
        clearOrphanedAgentJobs(agent.id, parsed.currentJobId);
        void dispatchQueue(agent.id);
      }
      if (parsed.type === "job.log") {
        const previous = db.prepare("SELECT status FROM jobs WHERE id = ?").get(parsed.jobId) as { status: string } | undefined;
        db.prepare("UPDATE jobs SET status='running', started_at=COALESCE(started_at, ?) WHERE id=?").run(nowIso(), parsed.jobId);
        if (previous?.status !== "running") broadcast({ type: "job.updated", jobId: parsed.jobId, status: "running" });
        appendLog({ job_id: parsed.jobId, stream: parsed.stream, message: parsed.message, at: parsed.at });
      }
      if (parsed.type === "job.progress") {
        const progressAt = nowIso();
        db.prepare("UPDATE jobs SET status='running', started_at=COALESCE(started_at, ?), progress_json=?, codex_thread_id=COALESCE(codex_thread_id, ?) WHERE id=?")
          .run(progressAt, JSON.stringify(parsed), parsed.codexThreadId ?? null, parsed.jobId);
        if (parsed.codexThreadId) {
          const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(parsed.jobId) as JobRow | undefined;
          if (job?.chat_id && job.kind === "codex") {
            db.prepare("UPDATE chats SET external_id = COALESCE(external_id, ?), updated_at = ? WHERE id = ?")
              .run(parsed.codexThreadId, progressAt, job.chat_id);
            const mergedDuplicates = mergeLinkedSyncedChatDuplicates(agent.id, job.repo_id, parsed.codexThreadId, job.chat_id);
            if (mergedDuplicates) {
              broadcast({ type: "chats.updated", agentId: agent.id, repoId: job.repo_id, chatId: job.chat_id });
            }
          }
        }
        broadcast(parsed);
      }
      if (parsed.type === "job.done") {
        const finishedAt = nowIso();
        const finalMessage = parsed.status === "completed"
          ? finalMessageForCompletedJob(parsed.jobId, parsed.finalMessage)
          : parsed.finalMessage?.trim() || latestJobLogText(parsed.jobId, "stderr") || null;
        db.prepare(`
          UPDATE jobs SET status=?, exit_code=?, final_message=?, git_status=?, git_diff_stat=?, git_diff=?, branch_name=?, codex_thread_id=?, finished_at=?
          WHERE id=?
        `).run(
          parsed.status,
          parsed.exitCode,
          finalMessage,
          parsed.gitStatus ?? null,
          parsed.gitDiffStat ?? null,
          parsed.gitDiff ?? null,
          parsed.branchName ?? null,
          parsed.codexThreadId ?? null,
          finishedAt,
          parsed.jobId
        );
        const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(parsed.jobId) as JobRow | undefined;
        if (job?.chat_id && job.kind === "codex" && parsed.codexThreadId) {
          db.prepare("UPDATE chats SET external_id = COALESCE(external_id, ?), updated_at = ? WHERE id = ?")
            .run(parsed.codexThreadId, finishedAt, job.chat_id);
        }
        if (job?.chat_id && finalMessage) {
          const startedAt = job.started_at ?? job.created_at;
          const startedAtMs = Date.parse(startedAt);
          const finishedAtMs = Date.parse(finishedAt);
          const durationSeconds = Number.isFinite(startedAtMs) && Number.isFinite(finishedAtMs)
            ? Math.max(0, Math.floor((finishedAtMs - startedAtMs) / 1000))
            : undefined;
          appendChatMessage({
            chat_id: job.chat_id,
            role: "assistant",
            content: finalMessage,
            source: assistantSourceForJob(job.kind),
            external_id: `job:${parsed.jobId}:final`,
            metadata_json: JSON.stringify({
              jobId: parsed.jobId,
              status: parsed.status,
              kind: job.kind,
              codexThreadId: parsed.codexThreadId,
              gitStatus: parsed.gitStatus,
              gitDiffStat: parsed.gitDiffStat,
              model: job.model,
              reasoningEffort: job.reasoning_effort,
              speed: job.speed,
              startedAt,
              finishedAt,
              durationSeconds
            }),
            created_at: finishedAt
          });
        }
        if (job?.chat_id && job.kind === "codex" && parsed.codexThreadId) {
          const mergedDuplicates = mergeLinkedSyncedChatDuplicates(agent.id, job.repo_id, parsed.codexThreadId, job.chat_id);
          if (mergedDuplicates) {
            db.prepare("UPDATE chats SET updated_at = ? WHERE id = ?").run(finishedAt, job.chat_id);
            broadcast({ type: "chats.updated", agentId: agent.id, repoId: job.repo_id, chatId: job.chat_id });
          }
        }
        db.prepare("UPDATE agents SET current_job_id = NULL WHERE id = ?").run(agent.id);
        broadcast({ type: "job.updated", jobId: parsed.jobId, status: parsed.status });
        void dispatchQueue(agent.id);
      }
      if (parsed.type === "chat.sync") {
        upsertSyncedChat(agent.id, parsed);
      }
      if (parsed.type === "project.result") {
        const pending = projectRequests.get(parsed.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          projectRequests.delete(parsed.requestId);
          pending.resolve(parsed);
        }
      }
      if (parsed.type === "git.result") {
        const pending = gitRequests.get(parsed.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          gitRequests.delete(parsed.requestId);
          pending.resolve(parsed);
        }
      }
      if (parsed.type === "deploy.result") {
        const pending = deployRequests.get(parsed.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          deployRequests.delete(parsed.requestId);
          pending.resolve(parsed);
        }
      }
      if (parsed.type === "project.command.result") {
        const pending = projectCommandRequests.get(parsed.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          projectCommandRequests.delete(parsed.requestId);
          pending.resolve(parsed);
        }
      }
      if (parsed.type === "nginx.result") {
        const pending = nginxRequests.get(parsed.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          nginxRequests.delete(parsed.requestId);
          pending.resolve(parsed);
        }
      }
      if (parsed.type === "ssl.result") {
        const pending = sslRequests.get(parsed.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          sslRequests.delete(parsed.requestId);
          pending.resolve(parsed);
        }
      }
      if (parsed.type === "vscode.result") {
        const pending = vscodeRequests.get(parsed.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          vscodeRequests.delete(parsed.requestId);
          pending.resolve(parsed);
        }
      }
      if (parsed.type === "file.result") {
        const pending = fileRequests.get(parsed.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          fileRequests.delete(parsed.requestId);
          pending.resolve(parsed);
        }
      }
      if (parsed.type === "chat.sync.result") {
        const pending = chatSyncRequests.get(parsed.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          chatSyncRequests.delete(parsed.requestId);
          pending.resolve(parsed);
        }
      }
    });

    socket.on("close", () => {
      rejectAgentRequestsForConnection(agent.id, connectionId, "agent_disconnected");
      if (agents.get(agent.id)?.connectionId !== connectionId) return;
      agents.delete(agent.id);
      setTimeout(() => {
        if (agents.has(agent.id)) return;
        markAgentStatus(agent.id, "offline");
        db.prepare("UPDATE agents SET current_job_id = NULL WHERE id = ?").run(agent.id);
      }, AGENT_OFFLINE_GRACE_MS);
      setTimeout(() => {
        if (agents.has(agent.id)) return;
        clearOrphanedAgentJobs(agent.id, undefined, "Agent socket stayed disconnected; marking stale job as disconnected.");
      }, STALE_JOB_GRACE_MS + 1000);
    });
  });

  if (existsSync(config.publicDir)) {
    await app.register(fastifyStatic, {
      root: config.publicDir,
      prefix: "/"
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.raw.url?.startsWith("/api/")) return reply.code(404).send({ error: "not_found" });
      if (request.raw.url?.startsWith("/assets/")) return reply.code(404).send("Not found");
      return reply.sendFile("index.html");
    });
  } else {
    app.get("/", async () => ({ ok: true, message: "Build apps/web first." }));
  }

  return app;
}

createApp()
  .then((app) => app.listen({ host: "0.0.0.0", port: config.port }))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
