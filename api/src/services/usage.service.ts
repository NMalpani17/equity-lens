/**
 * Daily usage accounting shared by chat and research reports.
 *
 * Every model run is one `chat_usage_events` row. Per-user caps count rows of
 * their own kinds (chat: messages and retries; reports: reports), and the
 * global daily cap sums every row's `weight` (a report weighs 3 chat turns).
 */
import type { Prisma, PrismaClient } from "@prisma/client";

import { prisma } from "../db/prisma.js";

export const CHAT_USAGE_KINDS = ["message", "retry"] as const;
export const REPORT_USAGE_KIND = "report";

type Db = PrismaClient | Prisma.TransactionClient;

/** Start of the current UTC day and the next reset. */
export function utcDayWindow(now = new Date()): { start: Date; resetsAt: Date } {
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  return { start, resetsAt: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

/** How many events of these kinds the user has today. */
export function countUserEvents(
  userId: string,
  kinds: readonly string[],
  since: Date,
  db: Db = prisma,
): Promise<number> {
  return db.chatUsageEvent.count({
    where: { userId, kind: { in: [...kinds] }, createdAt: { gte: since } },
  });
}

/** Units of the global daily cap used today (the sum of event weights). */
export async function globalUnitsUsed(since: Date, db: Db = prisma): Promise<number> {
  const result = await db.chatUsageEvent.aggregate({
    _sum: { weight: true },
    where: { createdAt: { gte: since } },
  });
  return result._sum.weight ?? 0;
}
