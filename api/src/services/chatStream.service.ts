/**
 * Client for the ai-service chat stream (POST /chat/stream, SSE).
 *
 * The request carries the gateway's internal token and the authenticated
 * user's id; the ai-service never sees a user id from the browser. Each event
 * is external input, so it is validated with Zod and mapped to camelCase.
 */
import { z } from "zod";

import { config } from "../config.js";
import { HttpError } from "../errors.js";
import { logger } from "../logger.js";
import {
  chartSchema,
  citationSchema,
  toChart,
  toCitation,
  type ChartDto,
  type CitationDto,
} from "./aiSchemas.js";
import { openAiServiceSse, parseSse } from "./aiServiceSse.js";

export { chartSchema, citationSchema, toChart, toCitation };
export type { ChartDto, CitationDto };
import type { PortfolioSummary } from "../types.js";
import type { HistoryMessage } from "./chat.service.js";

const toolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  label: z.string(),
  args: z.record(z.unknown()).default({}),
  ok: z.boolean().nullable().optional(),
  summary: z.string().nullable().optional(),
});

const eventSchemas = {
  token: z.object({ text: z.string() }),
  tool_start: z.object({
    id: z.string(),
    name: z.string(),
    label: z.string(),
    args: z.record(z.unknown()).default({}),
  }),
  tool_progress: z.object({ id: z.string(), label: z.string() }),
  tool_end: z.object({
    id: z.string(),
    name: z.string(),
    ok: z.boolean(),
    summary: z.string(),
  }),
  chart: chartSchema,
  done: z.object({
    content: z.string(),
    status: z.enum(["complete", "truncated", "blocked", "empty", "refused"]),
    citations: z.array(citationSchema),
    charts: z.array(chartSchema).default([]),
    tool_calls: z.array(toolCallSchema),
    usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).partial(),
    model: z.string().optional(),
  }),
  error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }),
} as const;

export interface ToolCallDto {
  id: string;
  name: string;
  label: string;
  args: Record<string, unknown>;
  ok?: boolean | null;
  summary?: string | null;
}

export type AiChatEvent =
  | { type: "token"; text: string }
  | {
      type: "tool_start";
      id: string;
      name: string;
      label: string;
      args: Record<string, unknown>;
    }
  | { type: "tool_progress"; id: string; label: string }
  | { type: "tool_end"; id: string; name: string; ok: boolean; summary: string }
  | { type: "chart"; chart: ChartDto }
  | {
      type: "done";
      content: string;
      status: "complete" | "truncated" | "blocked" | "empty" | "refused";
      citations: CitationDto[];
      charts: ChartDto[];
      toolCalls: ToolCallDto[];
      inputTokens: number | null;
      outputTokens: number | null;
      model: string | null;
    }
  | { type: "error"; code: string; message: string; retryable: boolean };

export interface ChatStreamRequest {
  userId: string;
  isAnonymous: boolean;
  conversationId: string;
  message: string;
  history: HistoryMessage[];
  portfolio: PortfolioSummary | null;
  /** IANA time zone from the browser, for local dates and timestamps. */
  timeZone?: string;
}

/** Map a validated upstream event to the camelCase shape used by the API. */
export function mapEvent(type: string, data: unknown): AiChatEvent | null {
  switch (type) {
    case "token":
    case "tool_start":
    case "tool_progress":
    case "tool_end":
    case "error": {
      const parsed = eventSchemas[type].safeParse(data);
      return parsed.success ? ({ type, ...parsed.data } as AiChatEvent) : null;
    }
    case "chart": {
      const parsed = eventSchemas.chart.safeParse(data);
      return parsed.success ? { type: "chart", chart: toChart(parsed.data) } : null;
    }
    case "done": {
      const parsed = eventSchemas.done.safeParse(data);
      if (!parsed.success) return null;
      const d = parsed.data;
      return {
        type: "done",
        content: d.content,
        status: d.status,
        citations: d.citations.map(toCitation),
        charts: d.charts.map(toChart),
        toolCalls: d.tool_calls.map((t) => ({ ...t, args: t.args ?? {} })),
        inputTokens: d.usage.input_tokens ?? null,
        outputTokens: d.usage.output_tokens ?? null,
        model: d.model ?? null,
      };
    }
    default:
      return null;
  }
}

export { parseSse };

function toSnapshot(summary: PortfolioSummary | null) {
  if (!summary) return null;
  return {
    as_of: new Date().toISOString(),
    positions: summary.positions.map((p) => ({
      ticker: p.ticker,
      name: p.name,
      total_shares: p.totalShares,
      avg_buy_price: p.avgBuyPrice,
      cost_basis: p.costBasis,
      current_price: p.currentPrice,
      market_value: p.marketValue,
      gain_loss: p.gainLoss,
      gain_loss_percent: p.gainLossPercent,
      daily_change: p.dailyChange,
      daily_change_percent: p.dailyChangePercent,
      price_status: p.priceStatus,
    })),
    totals: {
      market_value: summary.totals.marketValue,
      cost_basis: summary.totals.costBasis,
      gain_loss: summary.totals.gainLoss,
      gain_loss_percent: summary.totals.gainLossPercent,
      daily_change: summary.totals.dailyChange,
      partial: summary.totals.partial,
    },
  };
}

const UNAVAILABLE_MESSAGE = "The AI analyst is unavailable right now.";

/**
 * Open the upstream stream. Throws an HttpError when the ai-service is
 * unconfigured, unreachable, refuses, or doesn't start answering within
 * `connectTimeoutMs` (time to response headers; allows for a cold start).
 * The timeout never applies to the stream itself once it has started.
 */
export async function openChatStream(
  request: ChatStreamRequest,
  signal: AbortSignal,
  {
    connectTimeoutMs = config.chat.connectTimeoutMs,
  }: { connectTimeoutMs?: number } = {},
): Promise<AsyncGenerator<AiChatEvent>> {
  const frames = await openAiServiceSse({
    path: "/chat/stream",
    signal,
    connectTimeoutMs,
    label: "chat",
    notConfigured: {
      code: "chat_not_configured",
      message: "The AI analyst is not configured.",
    },
    unavailable: { code: "chat_unavailable", message: UNAVAILABLE_MESSAGE },
    unexpectedMessage: "The AI analyst returned an unexpected error.",
    refused: (status, body) =>
      status === 422 && body.error === "message_too_long"
        ? new HttpError(422, "message_too_long", body.message ?? "Message is too long.")
        : undefined,
    body: {
      user_id: request.userId,
      is_anonymous: request.isAnonymous,
      conversation_id: request.conversationId,
      message: request.message,
      history: request.history,
      portfolio: toSnapshot(request.portfolio),
      time_zone: request.timeZone,
    },
  });
  return (async function* events() {
    for await (const frame of frames) {
      const event = mapEvent(frame.event, frame.data);
      if (event) {
        yield event;
      } else {
        logger.warn({ event: frame.event }, "dropping malformed chat event");
      }
    }
  })();
}
