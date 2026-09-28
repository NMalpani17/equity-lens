/**
 * Environment-based configuration, validated with Zod.
 *
 * This is the only module that reads `process.env`. Everything else imports
 * the typed `config` object.
 */
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  AI_SERVICE_URL: z.string().url().default("http://localhost:8000"),
  // Comma-separated list of origins allowed by CORS (the client dev server).
  CLIENT_ORIGIN: z.string().default("http://localhost:5173"),
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
} as const;

export type Config = typeof config;
