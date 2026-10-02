/** Structured logger (Pino). */
import pino, { type LoggerOptions } from "pino";

import { config } from "./config.js";

/**
 * Header paths that carry credentials. pino-http logs request and response
 * headers, so these are censored before anything is written.
 */
export const REDACTED_LOG_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-internal-token"]',
  'res.headers["set-cookie"]',
];

export const loggerOptions: LoggerOptions = {
  level: config.logLevel,
  base: { service: "equity-lens-api" },
  redact: { paths: REDACTED_LOG_PATHS, censor: "***" },
};

export const logger = pino(loggerOptions);
