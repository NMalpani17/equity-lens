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

/**
 * The ai-service's refusals that mean nothing was generated, so the usage
 * event is refunded (as when the stream never opens). Failures after the
 * stream has started, and cancellations, still count.
 */
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
 * {report} or `error` {code, message, retryable}.
 *
 * A generation always finishes once started: if the client leaves, the api
 * keeps reading the ai-service's stream until the report is saved (and the
 * ai-service finishes on its own even if this connection drops). If the
 * ai-service can't be reached, nothing is generated and it doesn't count.
 */
export async function generateReport(req: Request, res: Response): Promise<void> {
  // Only for the log: the client leaving no longer stops the generation.
  const client = watchClient(res);
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
  let outcome = "incomplete";
  try {
    outcome = await relayReport(sink, { userId, ticker, start });
  } finally {
    stopKeepalive();
    if (!res.writableEnded) res.end();
    logger.info(
      {
        event: "research_report",
        ticker,
        quarter: start.latestQuarter.label,
        outcome,
        clientLeft: client.signal.aborted,
        totalMs: Math.round(performance.now() - started),
      },
      "research report",
    );
  }
}

async function relayReport(
  sink: EventSink,
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
      // Never aborted by the client: the report finishes either way.
      new AbortController().signal,
    );
  } catch (error) {
    // The stream never opened (unreachable, refused, not configured): nothing
    // was generated, so the usage event is given back.
    await reportsService.refundGeneration(ctx.start.usageEventId);
    sink.send("error", streamOpenError(error));
    return "upstream_failed";
  }

  let generating = false;
  try {
    // Read to the end even after the client has gone; events it can no longer
    // receive are dropped by the sink.
    for await (const event of events) {
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
    logger.warn({ err: error }, "report stream failed mid-generation");
  }
  sink.send("error", INCOMPLETE);
  return "incomplete";
}
