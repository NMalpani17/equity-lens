/**
 * Prisma client singleton.
 *
 * A single PrismaClient instance is shared across the app to avoid exhausting
 * the connection pool. Nothing else should construct a PrismaClient.
 */
import { PrismaClient } from "@prisma/client";

import { config } from "../config.js";

export const prisma = new PrismaClient({
  log: config.nodeEnv === "development" ? ["warn", "error"] : ["error"],
});
