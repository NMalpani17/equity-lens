/** Research reports controller (HTTP layer). */
import type { Request, Response } from "express";

import { HttpError } from "../errors.js";
import { logger } from "../logger.js";
import { getUserId, isAnonymousRequest } from "../middleware/auth.js";
import { reportTickerSchema } from "../schemas/report.schema.js";
import { openReportStream } from "../services/reportStream.service.js";
import * as reportsService from "../services/reports.service.js";
import type { EventSink } from "../types.js";
import { startKeepalive, startSse, watchClient } from "./sse.js";

/** Refusals that mean nothing was generated, so the usage event is refunded. */
const REFUNDED_CODES = new Set(["report_in_progress", "report_fresh"]);

const INCOMPLETE = {
  code: "incomplete_response",
  message: "The report stopped unexpectedly. Please try again.",
  retryable: true,
};

export async function listReports(req: Request, res: Response): Promise<void> {
  const [tickers, usage] = await Promise.all([
    reportsService.listReports(),
    reportsService.getReportUsage(getUserId(req), isAnonymousRequest(req)),
  ]);
  res.status(200).json({ tickers, usage });
}

export async function getReport(req: Request, res: Response): Promise<void> {
  const ticker = reportTickerSchema.parse(req.params.ticker);
  res
    .status(200)
    .json(
      await reportsService.getReport(ticker, getUserId(req), isAnonymousRequest(req)),
    );
}

/** The `error` event for a failure to open the upstream stream. */
function streamOpenError(error: unknown) {
  if (error instanceof HttpError) {
    return { code: error.code, message: error.message, retryable: error.status >= 500 };
  }
  return {
    code: "upstream_error",
    message: "Report generation returned an unexpected error. Please try again.",
    retryable: true,
  };
}

/**
 * Generate (or regenerate) a ticker's report and stream progress as SSE.
 *
 * Rule violations (demo, not indexed, in progress, fresh, caps) are JSON
 * errors before streaming starts. Then: `start` {ticker, quarter}, `agent`
 * {agent, state, label, summary?} as each agent runs, and finally `done`
 * {report} or `error` {code, message, retryable}. Closing the connection
 * cancels the generation (it still counts toward the daily cap).
 */
export async function generateReport(req: Request, res: Response): Promise<void> {
  const abort = watchClient(res);
  const userId = getUserId(req);
  const ticker = reportTickerSchema.parse(req.params.ticker);
  const start = await reportsService.startGeneration(
    userId,
    isAnonymousRequest(req),
    ticker,
  );

  const started = performance.now();
  const sink = startSse(res);
  sink.send("start", { ticker, quarter: start.latestQuarter });
  const stopKeepalive = startKeepalive(res);
  let outcome = "interrupted";
  try {
    outcome = await relayReport(sink, abort.signal, { userId, ticker, start });
  } finally {
    stopKeepalive();
    if (!res.writableEnded) res.end();
    logger.info(
      {
        event: "research_report",
        ticker,
        quarter: start.latestQuarter.label,
        outcome,
        totalMs: Math.round(performance.now() - started),
      },
      "research report",
    );
  }
}

async function relayReport(
  sink: EventSink,
  signal: AbortSignal,
  ctx: { userId: string; ticker: string; start: reportsService.GenerationStart },
): Promise<string> {
  let events;
  try {
    events = await openReportStream(
      {
        userId: ctx.userId,
        ticker: ctx.ticker,
        regenerateAfterDays: ctx.start.regenerateAfterDays,
      },
      signal,
    );
  } catch (error) {
    if (signal.aborted) return "interrupted";
    sink.send("error", streamOpenError(error));
    return "upstream_failed";
  }

  let generating = false;
  try {
    for await (const event of events) {
      if (signal.aborted) return "interrupted";
      switch (event.type) {
        case "agent":
          generating = true;
          sink.send("agent", {
            agent: event.agent,
            state: event.state,
            label: event.label,
            ...(event.summary ? { summary: event.summary } : {}),
          });
          break;
        case "done":
          sink.send("done", { report: event.report });
          return "done";
        case "error":
          if (!generating && REFUNDED_CODES.has(event.code)) {
            await reportsService.refundGeneration(ctx.start.usageEventId);
          }
          sink.send("error", {
            code: event.code,
            message: event.message,
            retryable: event.retryable,
          });
          return event.code;
      }
    }
  } catch (error) {
    if (signal.aborted) return "interrupted";
    logger.warn({ err: error }, "report stream failed mid-generation");
  }
  if (signal.aborted) return "interrupted";
  sink.send("error", INCOMPLETE);
  return "incomplete";
}
