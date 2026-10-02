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
  done: z.object({
    content: z.string(),
    status: z.enum(["complete", "truncated", "blocked", "empty", "refused"]),
    citations: z.array(citationSchema),
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
  | {
      type: "done";
      content: string;
      status: "complete" | "truncated" | "blocked" | "empty" | "refused";
      citations: CitationDto[];
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
    case "done": {
      const parsed = eventSchemas.done.safeParse(data);
      if (!parsed.success) return null;
      const d = parsed.data;
      return {
        type: "done",
        content: d.content,
        status: d.status,
        citations: d.citations.map(toCitation),
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

/**
 * Open the upstream stream. Throws an HttpError (before any bytes are sent to
 * the client) when the ai-service is unconfigured, unreachable or refuses.
 */
export async function openChatStream(
  request: ChatStreamRequest,
  signal: AbortSignal,
): Promise<AsyncGenerator<AiChatEvent>> {
  if (!config.aiServiceInternalToken) {
    throw new ServiceUnavailableError(
      "chat_not_configured",
      "The AI analyst is not configured.",
    );
  }
  const url = aiServiceUrl("/chat/stream");
  let response: Response;
  try {
    response = await aiServiceFetch(url, {
      method: "POST",
      signal,
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
      }),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    logger.warn({ url: url.toString(), err: error }, "failed to reach ai-service chat");
    throw new ServiceUnavailableError(
      "chat_unavailable",
      "The AI analyst is unavailable right now.",
    );
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
      throw new ServiceUnavailableError(
        "chat_unavailable",
        "The AI analyst is unavailable right now.",
      );
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
