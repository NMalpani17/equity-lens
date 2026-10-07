/**
 * Research reports: reading the shared reports (Prisma; the ai-service writes
 * them), who may generate one and when, and the usage accounting.
 *
 * Reports are keyed by ticker + fiscal quarter. The current report is the one
 * for the ticker's newest indexed call; until it exists, the newest older
 * report is shown as outdated. Rules for generating:
 *   - signed-in (non-demo) users only; demo users view cached reports
 *   - not while a generation runs, and not if the current report is newer
 *     than REPORT_REGENERATE_AFTER_DAYS
 *   - REPORT_DAILY_LIMIT per user per UTC day, counting failed and cancelled
 *     generations, and REPORT_GLOBAL_WEIGHT units of the global daily cap
 */
import type { RagTicker, ResearchReport } from "@prisma/client";

import { config } from "../config.js";
import { prisma } from "../db/prisma.js";
import {
  ForbiddenError,
  NotFoundError,
  ReportConflictError,
  ReportLimitError,
} from "../errors.js";
import { logger } from "../logger.js";
import {
  periodLabel,
  reportContentSchema,
  toReportDto,
  type ReportDto,
} from "./reportContent.js";
import {
  REPORT_USAGE_KIND,
  countUserEvents,
  globalUnitsUsed,
  utcDayWindow,
} from "./usage.service.js";

const DAY_MS = 24 * 60 * 60 * 1000;
// Serializes report starts so two requests can't both pass the caps.
const USAGE_LOCK_KEY = 7_202_610;

export type BlockedReason =
  "demo" | "in_progress" | "fresh" | "daily_limit" | "global_limit";

export interface Quarter {
  fiscalYear: number;
  fiscalQuarter: number;
  label: string;
}

export interface ReportUsageDto {
  used: number;
  limit: number;
  remaining: number;
  resetsAt: string;
  isDemo: boolean;
}

export interface ReportSummaryDto {
  ticker: string;
  companyName: string;
  latestQuarter: Quarter;
  /** The newest generated report, current or outdated; null if none yet. */
  report: { generatedAt: string; quarter: Quarter; outdated: boolean } | null;
  generating: boolean;
}

export interface ReportViewDto {
  ticker: string;
  companyName: string;
  latestQuarter: Quarter;
  report: ReportDto | null;
  /** True when the report is for an older quarter than the newest call. */
  outdated: boolean;
  generating: boolean;
  canGenerate: boolean;
  blockedReason: BlockedReason | null;
  /** When the current report may be regenerated (fresh reports only). */
  regenerateAvailableAt: string | null;
  usage: ReportUsageDto;
}

export interface GenerationStart {
  usageEventId: string;
  latestQuarter: Quarter;
  regenerateAfterDays: number;
}

type ReportRow = Pick<
  ResearchReport,
  | "ticker"
  | "fiscalYear"
  | "fiscalQuarter"
  | "generatedAt"
  | "generatingSince"
  | "generationId"
>;

/** "FY2027Q2" -> FY2027, Q2. */
export function parseQuarterLabel(label: unknown): Quarter | null {
  const match = typeof label === "string" ? /^FY(\d{4})Q([1-4])$/.exec(label) : null;
  if (!match) return null;
  const fiscalYear = Number(match[1]);
  const fiscalQuarter = Number(match[2]);
  return { fiscalYear, fiscalQuarter, label: periodLabel(fiscalYear, fiscalQuarter) };
}

/** The newest indexed quarter of a searchable ticker, else null. */
export function latestIndexedQuarter(ticker: RagTicker): Quarter | null {
  const searchable = ticker.status === "indexed" || ticker.indexedAt !== null;
  const quarters = Array.isArray(ticker.quarters) ? ticker.quarters : [];
  return searchable ? parseQuarterLabel(quarters[0]) : null;
}

function isCurrent(row: ReportRow, latest: Quarter): boolean {
  return (
    row.fiscalYear === latest.fiscalYear && row.fiscalQuarter === latest.fiscalQuarter
  );
}

function isGenerating(row: ReportRow | undefined, now: Date): boolean {
  if (!row?.generatingSince || !row.generationId) return false;
  const staleMs = config.reports.staleGenerationMinutes * 60 * 1000;
  return now.getTime() - row.generatingSince.getTime() < staleMs;
}

/** When a current report may be regenerated, or null if it may be now. */
function freshUntil(row: ReportRow | undefined, now: Date): Date | null {
  if (!row?.generatedAt) return null;
  const until = new Date(
    row.generatedAt.getTime() + config.reports.regenerateAfterDays * DAY_MS,
  );
  return until > now ? until : null;
}

/** Newest first; the first is the latest quarter's row when it exists. */
function newestFirst<T extends ReportRow>(rows: T[]): T[] {
  return [...rows].sort(
    (a, b) => b.fiscalYear - a.fiscalYear || b.fiscalQuarter - a.fiscalQuarter,
  );
}

function companyName(ticker: RagTicker): string {
  return ticker.companyName ?? ticker.ticker;
}

export async function getReportUsage(
  userId: string,
  isAnonymous: boolean,
): Promise<ReportUsageDto> {
  const { start, resetsAt } = utcDayWindow();
  const limit = isAnonymous ? 0 : config.reports.dailyLimit;
  const used = isAnonymous
    ? 0
    : await countUserEvents(userId, [REPORT_USAGE_KIND], start);
  return {
    used,
    limit,
    remaining: Math.max(0, limit - used),
    resetsAt: resetsAt.toISOString(),
    isDemo: isAnonymous,
  };
}

async function indexedTicker(
  ticker: string,
): Promise<{ row: RagTicker; latest: Quarter }> {
  const row = await prisma.ragTicker.findUnique({ where: { ticker } });
  const latest = row ? latestIndexedQuarter(row) : null;
  if (!row || !latest) {
    throw new NotFoundError(`${ticker} has no indexed earnings calls.`);
  }
  return { row, latest };
}

/** Every indexed ticker with its newest report (no report content). */
export async function listReports(): Promise<ReportSummaryDto[]> {
  const tickers = await prisma.ragTicker.findMany({
    where: { OR: [{ status: "indexed" }, { indexedAt: { not: null } }] },
    orderBy: { ticker: "asc" },
  });
  const rows = await prisma.researchReport.findMany({
    where: { ticker: { in: tickers.map((t) => t.ticker) } },
    select: {
      ticker: true,
      fiscalYear: true,
      fiscalQuarter: true,
      generatedAt: true,
      generatingSince: true,
      generationId: true,
    },
  });
  const now = new Date();
  return tickers.flatMap((ticker) => {
    const latest = latestIndexedQuarter(ticker);
    if (!latest) return [];
    const own = newestFirst(rows.filter((r) => r.ticker === ticker.ticker));
    const generated = own.find((r) => r.generatedAt !== null);
    const current = own.find((r) => isCurrent(r, latest));
    return [
      {
        ticker: ticker.ticker,
        companyName: companyName(ticker),
        latestQuarter: latest,
        report: generated?.generatedAt
          ? {
              generatedAt: generated.generatedAt.toISOString(),
              quarter: {
                fiscalYear: generated.fiscalYear,
                fiscalQuarter: generated.fiscalQuarter,
                label: periodLabel(generated.fiscalYear, generated.fiscalQuarter),
              },
              outdated: !isCurrent(generated, latest),
            }
          : null,
        generating: isGenerating(current, now),
      },
    ];
  });
}

/** Why the user can't generate now (first reason that applies), or null. */
async function blockedReason(
  isAnonymous: boolean,
  current: ReportRow | undefined,
  usage: ReportUsageDto,
  now: Date,
): Promise<BlockedReason | null> {
  if (isAnonymous) return "demo";
  if (isGenerating(current, now)) return "in_progress";
  if (freshUntil(current, now)) return "fresh";
  if (usage.remaining <= 0) return "daily_limit";
  const used = await globalUnitsUsed(utcDayWindow(now).start);
  if (used + config.reports.globalWeight > config.chat.globalDailyLimit) {
    return "global_limit";
  }
  return null;
}

/** A ticker's report (current, else the newest outdated one) and permissions. */
export async function getReport(
  ticker: string,
  userId: string,
  isAnonymous: boolean,
): Promise<ReportViewDto> {
  const { row: tickerRow, latest } = await indexedTicker(ticker);
  const rows = newestFirst(await prisma.researchReport.findMany({ where: { ticker } }));
  const now = new Date();
  const current = rows.find((r) => isCurrent(r, latest));
  const shown = rows.find((r) => r.generatedAt !== null && r.content !== null);
  let report: ReportDto | null = null;
  if (shown?.generatedAt) {
    const parsed = reportContentSchema.safeParse(shown.content);
    if (parsed.success) {
      report = toReportDto(parsed.data, shown.generatedAt);
    } else {
      logger.error(
        { ticker, issues: parsed.error.issues.slice(0, 3) },
        "stored report doesn't match the expected shape",
      );
    }
  }
  const usage = await getReportUsage(userId, isAnonymous);
  const reason = await blockedReason(isAnonymous, current, usage, now);
  const until = freshUntil(current, now);
  return {
    ticker,
    companyName: companyName(tickerRow),
    latestQuarter: latest,
    report,
    outdated: report !== null && shown !== undefined && !isCurrent(shown, latest),
    generating: isGenerating(current, now),
    canGenerate: reason === null,
    blockedReason: reason,
    regenerateAvailableAt: until ? until.toISOString() : null,
    usage,
  };
}

/**
 * Check every rule and record the usage event, or throw (403 / 404 / 409 /
 * 429). The event is recorded before generating, so a failed or cancelled
 * generation still counts; caps are checked and the event written under one
 * lock so concurrent requests can't both slip under a cap.
 */
export async function startGeneration(
  userId: string,
  isAnonymous: boolean,
  ticker: string,
): Promise<GenerationStart> {
  if (isAnonymous) {
    throw new ForbiddenError(
      "demo_read_only",
      "Demo accounts can view reports. Sign up to generate one.",
    );
  }
  const { latest } = await indexedTicker(ticker);
  const now = new Date();
  const current = await prisma.researchReport.findUnique({
    where: {
      ticker_fiscalYear_fiscalQuarter: {
        ticker,
        fiscalYear: latest.fiscalYear,
        fiscalQuarter: latest.fiscalQuarter,
      },
    },
  });
  if (current && isGenerating(current, now)) {
    throw new ReportConflictError(
      "report_in_progress",
      `${ticker}'s report is being generated. Check back in a minute.`,
    );
  }
  const until = current ? freshUntil(current, now) : null;
  if (until) {
    throw new ReportConflictError(
      "report_fresh",
      `${ticker}'s report is less than ${config.reports.regenerateAfterDays} days old.`,
      { regenerateAvailableAt: until.toISOString() },
    );
  }

  const { start, resetsAt } = utcDayWindow(now);
  const event = await prisma.$transaction(async (tx) => {
    // $executeRaw, not $queryRaw: pg_advisory_xact_lock returns void, which
    // $queryRaw can't deserialize (P2010); $executeRaw reads no columns.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${USAGE_LOCK_KEY})`;
    const [used, globalUsed] = await Promise.all([
      countUserEvents(userId, [REPORT_USAGE_KIND], start, tx),
      globalUnitsUsed(start, tx),
    ]);
    if (used >= config.reports.dailyLimit) {
      throw new ReportLimitError(
        "user",
        config.reports.dailyLimit,
        resetsAt.toISOString(),
        `You can generate ${config.reports.dailyLimit} reports a day.`,
      );
    }
    if (globalUsed + config.reports.globalWeight > config.chat.globalDailyLimit) {
      throw new ReportLimitError(
        "global",
        config.chat.globalDailyLimit,
        resetsAt.toISOString(),
        "Report generation has reached its daily capacity.",
      );
    }
    return tx.chatUsageEvent.create({
      data: { userId, kind: REPORT_USAGE_KIND, weight: config.reports.globalWeight },
    });
  });
  return {
    usageEventId: event.id,
    latestQuarter: latest,
    regenerateAfterDays: config.reports.regenerateAfterDays,
  };
}

/**
 * Give back a usage event when the ai-service refused before generating
 * anything (another generation won the race, or the report became fresh).
 * Failed and cancelled generations are never refunded.
 */
export async function refundGeneration(usageEventId: string): Promise<void> {
  try {
    await prisma.chatUsageEvent.deleteMany({ where: { id: usageEventId } });
  } catch (error) {
    logger.warn({ err: error, usageEventId }, "could not refund report usage");
  }
}
