/**
 * Environment-based configuration, validated with Zod.
 *
 * This is the only module that reads `process.env`. Everything else imports
 * the typed `config` object.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

// Load `.env` from the api package root, resolved relative to this module so it
// works no matter what directory the process was started from (e.g. the repo
// root via `npm run dev`). `config.ts` lives in `api/src`, so the package root
// is one directory up.
const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(apiRoot, ".env") });

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  AI_SERVICE_URL: z.string().url().default("http://localhost:8000"),
  // Shared secret proving requests to the ai-service come from this gateway.
  // Chat returns 503 until it is set.
  AI_SERVICE_INTERNAL_TOKEN: z.string().default(""),
  // AI analyst chat limits (user messages per UTC day).
  CHAT_DAILY_LIMIT: z.coerce.number().int().positive().default(20),
  CHAT_DAILY_LIMIT_ANON: z.coerce.number().int().positive().default(5),
  CHAT_GLOBAL_DAILY_LIMIT: z.coerce.number().int().positive().default(60),
  CHAT_MAX_MESSAGE_CHARS: z.coerce.number().int().positive().default(2000),
  // Context sent to the model: final answers only, newest first.
  CHAT_HISTORY_MESSAGES: z.coerce.number().int().nonnegative().default(6),
  CHAT_HISTORY_TOKENS: z.coerce.number().int().positive().default(3000),
  // How long to wait for the ai-service to start answering a chat turn. Covers
  // a cold start (~15s) with margin; a real timeout shows the friendly
  // "unavailable" error.
  CHAT_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  // SSE comment sent this often while a turn is open, so the browser sees the
  // stream is alive and proxies don't close an idle connection.
  CHAT_KEEPALIVE_MS: z.coerce.number().int().positive().default(10_000),
  // Comma-separated origins allowed by CORS (exact matches, no wildcards),
  // e.g. "https://equity-lens.vercel.app,http://localhost:5173".
  CLIENT_ORIGIN: z.string().default("http://localhost:5173"),
  // Supabase PostgreSQL connection strings.
  // DATABASE_URL is the pooled (PgBouncer) URL used by the running app;
  // DIRECT_URL is the direct connection Prisma uses for migrations.
  DATABASE_URL: z.string().url(),
  DIRECT_URL: z.string().url(),
  // Supabase project URL (e.g. https://<project-ref>.supabase.co). Used to
  // derive the JWKS endpoint and expected issuer for verifying auth tokens.
  SUPABASE_URL: z.string().url(),
  // Supabase service-role key — SERVER-SIDE ONLY. Grants admin access (e.g.
  // deleting auth users); never expose it to the client.
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, "SUPABASE_SERVICE_ROLE_KEY is required"),
});

/**
 * Split a comma-separated origin list: trimmed, empty entries dropped, and a
 * trailing slash removed (browsers send origins without one). Each entry is
 * matched exactly; "*" or partial domains are never treated as patterns.
 */
export function parseOrigins(raw: string): string[] {
  return raw
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter((origin) => origin.length > 0);
}

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Fail fast on misconfiguration rather than starting in a broken state.
  console.error(
    "Invalid environment configuration:",
    parsed.error.flatten().fieldErrors,
  );
  process.exit(1);
}

export const config = {
  nodeEnv: parsed.data.NODE_ENV,
  port: parsed.data.PORT,
  logLevel: parsed.data.LOG_LEVEL,
  aiServiceUrl: parsed.data.AI_SERVICE_URL,
  aiServiceInternalToken: parsed.data.AI_SERVICE_INTERNAL_TOKEN,
  chat: {
    dailyLimit: parsed.data.CHAT_DAILY_LIMIT,
    dailyLimitAnon: parsed.data.CHAT_DAILY_LIMIT_ANON,
    globalDailyLimit: parsed.data.CHAT_GLOBAL_DAILY_LIMIT,
    maxMessageChars: parsed.data.CHAT_MAX_MESSAGE_CHARS,
    historyMessages: parsed.data.CHAT_HISTORY_MESSAGES,
    historyTokens: parsed.data.CHAT_HISTORY_TOKENS,
    connectTimeoutMs: parsed.data.CHAT_CONNECT_TIMEOUT_MS,
    keepaliveMs: parsed.data.CHAT_KEEPALIVE_MS,
  },
  clientOrigins: parseOrigins(parsed.data.CLIENT_ORIGIN),
  databaseUrl: parsed.data.DATABASE_URL,
  directUrl: parsed.data.DIRECT_URL,
  supabaseUrl: parsed.data.SUPABASE_URL,
  supabaseServiceRoleKey: parsed.data.SUPABASE_SERVICE_ROLE_KEY,
} as const;

export type Config = typeof config;
