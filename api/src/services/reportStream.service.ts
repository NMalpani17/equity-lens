/**
 * Client for the ai-service report stream (POST /reports/stream, SSE).
 *
 * Same transport as chat (internal token, connect timeout for a cold start,
 * abort on client disconnect). Each event is external input, validated with
 * Zod and mapped to camelCase. The ai-service saves the report itself before
 * sending `done`.
 */
import { z } from "zod";

import { config } from "../config.js";
import { logger } from "../logger.js";
import { openAiServiceSse } from "./aiServiceSse.js";
import { reportContentSchema, toReportDto, type ReportDto } from "./reportContent.js";

export type ReportAgent = "transcripts" | "market" | "writer";

export type AiReportEvent =
  | {
      type: "agent";
      agent: ReportAgent;
      state: "running" | "done" | "failed";
      label: string;
      summary?: string;
    }
  | { type: "done"; report: ReportDto }
  | { type: "error"; code: string; message: string; retryable: boolean };

export interface ReportStreamRequest {
  userId: string;
  ticker: string;
  regenerateAfterDays: number;
}

const eventSchemas = {
  agent: z.object({
    agent: z.enum(["transcripts", "market", "writer"]),
    state: z.enum(["running", "done", "failed"]),
    label: z.string(),
    summary: z.string().optional(),
  }),
  done: z.object({
    report: reportContentSchema,
    generated_at: z.string().datetime({ offset: true }),
  }),
  error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }),
} as const;

export function mapReportEvent(type: string, data: unknown): AiReportEvent | null {
  switch (type) {
    case "agent": {
      const parsed = eventSchemas.agent.safeParse(data);
      return parsed.success ? { type, ...parsed.data } : null;
    }
    case "done": {
      const parsed = eventSchemas.done.safeParse(data);
      if (!parsed.success) return null;
      return {
        type,
        report: toReportDto(parsed.data.report, new Date(parsed.data.generated_at)),
      };
    }
    case "error": {
      const parsed = eventSchemas.error.safeParse(data);
      return parsed.success ? { type, ...parsed.data } : null;
    }
    default:
      return null;
  }
}

const UNAVAILABLE_MESSAGE = "Report generation is unavailable right now.";

export async function openReportStream(
  request: ReportStreamRequest,
  signal: AbortSignal,
  {
    connectTimeoutMs = config.reports.connectTimeoutMs,
  }: { connectTimeoutMs?: number } = {},
): Promise<AsyncGenerator<AiReportEvent>> {
  const frames = await openAiServiceSse({
    path: "/reports/stream",
    signal,
    connectTimeoutMs,
    label: "report",
    notConfigured: {
      code: "report_not_configured",
      message: "Report generation is not configured.",
    },
    unavailable: { code: "report_unavailable", message: UNAVAILABLE_MESSAGE },
    unexpectedMessage: "Report generation returned an unexpected error.",
    body: {
      user_id: request.userId,
      // Only signed-in users reach this; the ai-service checks again.
      is_anonymous: false,
      ticker: request.ticker,
      regenerate_after_days: request.regenerateAfterDays,
    },
  });
  return (async function* events() {
    for await (const frame of frames) {
      const event = mapReportEvent(frame.event, frame.data);
      if (event) {
        yield event;
      } else {
        logger.warn({ event: frame.event }, "dropping malformed report event");
      }
    }
  })();
}
