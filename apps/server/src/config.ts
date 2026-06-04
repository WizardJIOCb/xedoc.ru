import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type ServerConfig = {
  port: number;
  databasePath: string;
  sessionSecret: string;
  cookieDomain?: string;
  publicBaseUrl?: string;
  publicDir: string;
  nodeEnv: string;
  modelApiToken?: string;
  modelApiAllowedOrigins: string[];
  modelApiDefaultAgentId?: string;
  modelApiDefaultRepoId?: string;
};

function workspaceRoot(): string {
  return process.env.INIT_CWD ?? process.cwd();
}

function sqlitePath(databaseUrl: string | undefined): string {
  if (!databaseUrl) return resolve(workspaceRoot(), "data", "cmc.db");
  if (databaseUrl.startsWith("file:")) return databaseUrl.slice("file:".length);
  return databaseUrl;
}

function csv(value: string | undefined, fallback: string[]): string[] {
  const source = value ?? fallback.join(",");
  return source.split(",").map((item) => item.trim()).filter(Boolean);
}

export function loadConfig(): ServerConfig {
  const databasePath = sqlitePath(process.env.DATABASE_URL);
  const nodeEnv = process.env.NODE_ENV ?? "development";
  const defaultModelApiOrigins = nodeEnv === "production"
    ? ["https://tg.xedoc.ru"]
    : ["https://tg.xedoc.ru", "http://localhost:5177", "http://127.0.0.1:5177"];
  mkdirSync(dirname(databasePath), { recursive: true });

  return {
    port: Number(process.env.PORT ?? 3000),
    databasePath,
    sessionSecret: process.env.SESSION_SECRET ?? "dev_secret_change_me_64_chars_minimum_for_local_only",
    cookieDomain: process.env.COOKIE_DOMAIN,
    publicBaseUrl: process.env.PUBLIC_BASE_URL,
    publicDir: resolve(workspaceRoot(), "apps", "web", "dist"),
    nodeEnv,
    modelApiToken: process.env.MODEL_API_TOKEN,
    modelApiAllowedOrigins: csv(process.env.MODEL_API_ALLOWED_ORIGINS, defaultModelApiOrigins),
    modelApiDefaultAgentId: process.env.MODEL_API_DEFAULT_AGENT_ID,
    modelApiDefaultRepoId: process.env.MODEL_API_DEFAULT_REPO_ID
  };
}
