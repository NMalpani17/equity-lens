/**
 * Client for the ai-service chat stream (POST /chat/stream, SSE).
 *
 * The request carries the gateway's internal token and the authenticated
 * user's id; the ai-service never sees a user id from the browser. Each event
 * is external input, so it is validated with Zod and mapped to camelCase.
 */
import { z } from "zod";

import { config } from "../config.js";
import { HttpError, ServiceUnavailableError, UpstreamError } from "../errors.js";
import { logger } from "../logger.js";
import { aiServiceFetch, aiServiceUrl } from "./aiServiceClient.js";
import type { PortfolioSummary } from "../types.js";
import type { HistoryMessage } from "./chat.service.js";

const citationSchema = z.object({
  id: z.number().int(),
  ticker: z.string(),
  company_name: z.string(),
  fiscal_year: z.number().int(),
  fiscal_quarter: z.number().int(),
  call_date: z.string().nullable(),
  speaker: z.string(),
  role: z.string().nullable(),
  section: z.string(),
  text: z.string(),
});

const toolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  label: z.string(),
  args: z.record(z.unknown()).default({}),
  ok: z.boolean().nullable().optional(),
  summary: z.string().nullable().optional(),
});

const pricePointSchema = z.object({ date: z.string(), close: z.number() });

const chartSchema = z.discriminatedUnion("kind", [
  z.object({
    id: z.string(),
    kind: z.literal("price_history"),
    ticker: z.string(),
    period: z.string(),
    currency: z.string(),
    points: z.array(pricePointSchema).min(2).max(400),
    first_close: z.number(),
    last_close: z.number(),
    change: z.number(),
    change_percent: z.number(),
    high: z.number(),
    low: z.number(),
    as_of: z.string().nullable().optional(),
  }),
  z.object({
    id: z.string(),
    kind: z.literal("portfolio_allocation"),
    currency: z.string(),
    slices: z
      .array(
        z.object({
          ticker: z.string(),
          name: z.string().nullable().optional(),
          market_value: z.number(),
          weight_percent: z.number(),
        }),
      )
      .min(1)
      .max(20),
    total_market_value: z.number(),
    partial: z.boolean(),
    as_of: z.string().nullable().optional(),
  }),
]);

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

export interface CitationDto {
  id: number;
  ticker: string;
  companyName: string;
  fiscalYear: number;
  fiscalQuarter: number;
  callDate: string | null;
  speaker: string;
  role: string | null;
  section: string;
  text: string;
}

export type ChartDto =
  | {
      id: string;
      kind: "price_history";
      ticker: string;
      period: string;
      currency: string;
      points: { date: string; close: number }[];
      firstClose: number;
      lastClose: number;
      change: number;
      changePercent: number;
      high: number;
      low: number;
      asOf: string | null;
    }
  | {
      id: string;
      kind: "portfolio_allocation";
      currency: string;
      slices: {
        ticker: string;
        name: string | null;
        marketValue: number;
        weightPercent: number;
      }[];
      totalMarketValue: number;
      partial: boolean;
      asOf: string | null;
    };

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

function toCitation(c: z.infer<typeof citationSchema>): CitationDto {
  return {
    id: c.id,
    ticker: c.ticker,
    companyName: c.company_name,
    fiscalYear: c.fiscal_year,
    fiscalQuarter: c.fiscal_quarter,
    callDate: c.call_date,
    speaker: c.speaker,
    role: c.role,
    section: c.section,
    text: c.text,
  };
}

/** Chart from upstream (snake_case) to the API's camelCase shape. */
export function toChart(c: z.infer<typeof chartSchema>): ChartDto {
  if (c.kind === "price_history") {
    return {
      id: c.id,
      kind: c.kind,
      ticker: c.ticker,
      period: c.period,
      currency: c.currency,
      points: c.points.map((p) => ({ date: p.date, close: p.close })),
      firstClose: c.first_close,
      lastClose: c.last_close,
      change: c.change,
      changePercent: c.change_percent,
      high: c.high,
      low: c.low,
      asOf: c.as_of ?? null,
    };
  }
  return {
    id: c.id,
    kind: c.kind,
    currency: c.currency,
    slices: c.slices.map((s) => ({
      ticker: s.ticker,
      name: s.name ?? null,
      marketValue: s.market_value,
      weightPercent: s.weight_percent,
    })),
    totalMarketValue: c.total_market_value,
    partial: c.partial,
    asOf: c.as_of ?? null,
  };
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

/** Parse an SSE byte stream into (event, data) pairs. */
export async function* parseSse(
  body: AsyncIterable<Uint8Array>,
): AsyncGenerator<{ event: string; data: string }> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (data.length > 0) yield { event, data: data.join("\n") };
    }
  }
}

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
  if (!config.aiServiceInternalToken) {
    throw new ServiceUnavailableError(
      "chat_not_configured",
      "The AI analyst is not configured.",
    );
  }
  const url = aiServiceUrl("/chat/stream");
  // One signal for the whole request: aborted by the client going away, or by
  // the connect timer until the response headers arrive.
  const upstream = new AbortController();
  const onClientAbort = () => upstream.abort(signal.reason);
  if (signal.aborted) upstream.abort(signal.reason);
  else signal.addEventListener("abort", onClientAbort, { once: true });
  let timedOut = false;
  const connectTimer = setTimeout(() => {
    timedOut = true;
    upstream.abort(new Error("ai-service connect timeout"));
  }, connectTimeoutMs);
  let response: Response;
  try {
    response = await aiServiceFetch(url, {
      method: "POST",
      signal: upstream.signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        user_id: request.userId,
        is_anonymous: request.isAnonymous,
        conversation_id: request.conversationId,
        message: request.message,
        history: request.history,
        portfolio: toSnapshot(request.portfolio),
        time_zone: request.timeZone,
      }),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    if (timedOut) {
      logger.warn(
        { url: url.toString(), connectTimeoutMs },
        "ai-service chat did not answer in time",
      );
    } else {
      logger.warn(
        { url: url.toString(), err: error },
        "failed to reach ai-service chat",
      );
    }
    throw new ServiceUnavailableError("chat_unavailable", UNAVAILABLE_MESSAGE);
  } finally {
    clearTimeout(connectTimer);
  }

  if (!response.ok || !response.body) {
    let body: { error?: string; message?: string } = {};
    try {
      body = (await response.json()) as typeof body;
    } catch {
      // non-JSON error body
    }
    logger.warn(
      { status: response.status, body },
      "ai-service chat refused the request",
    );
    if (response.status === 422 && body.error === "message_too_long") {
      throw new HttpError(
        422,
        "message_too_long",
        body.message ?? "Message is too long.",
      );
    }
    if (response.status === 401 || response.status === 503) {
      throw new ServiceUnavailableError("chat_unavailable", UNAVAILABLE_MESSAGE);
    }
    throw new UpstreamError("The AI analyst returned an unexpected error.");
  }

  const body = response.body;
  return (async function* events() {
    for await (const frame of parseSse(body as AsyncIterable<Uint8Array>)) {
      let data: unknown;
      try {
        data = JSON.parse(frame.data);
      } catch {
        logger.warn({ event: frame.event }, "dropping non-JSON chat event");
        continue;
      }
      const event = mapEvent(frame.event, data);
      if (event) {
        yield event;
      } else {
        logger.warn({ event: frame.event }, "dropping malformed chat event");
      }
    }
  })();
}
