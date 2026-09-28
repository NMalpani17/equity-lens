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
  // Comma-separated list of origins allowed by CORS (the client dev server).
  CLIENT_ORIGIN: z.string().default("http://localhost:5173"),
  // Supabase PostgreSQL connection strings.
  // DATABASE_URL is the pooled (PgBouncer) URL used by the running app;
  // DIRECT_URL is the direct connection Prisma uses for migrations.
  DATABASE_URL: z.string().url(),
  DIRECT_URL: z.string().url(),
});

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
  clientOrigin: parsed.data.CLIENT_ORIGIN,
  databaseUrl: parsed.data.DATABASE_URL,
  directUrl: parsed.data.DIRECT_URL,
} as const;

export type Config = typeof config;
