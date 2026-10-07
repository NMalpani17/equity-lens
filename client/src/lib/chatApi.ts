/** Typed client for the AI analyst chat endpoints. */
import { postEventStream, request } from "./api";

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export type MessageStatus =
  | "streaming"
  | "complete"
  | "truncated"
  | "blocked"
  | "empty"
  | "refused"
  | "interrupted"
  | "error";

export interface Citation {
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

export interface ToolCall {
  id: string;
  name: string;
  label: string;
  args: Record<string, unknown>;
  ok?: boolean | null;
  summary?: string | null;
}

/** A ticker's closing prices over a period (from the price history tool). */
export interface PriceChart {
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

/** The user's holdings by market value (from the portfolio tool). */
export interface AllocationChart {
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
  /** Some holdings had no price and are left out. */
  partial: boolean;
  asOf: string | null;
}

/** An inline chart built from tool results (never from model-written numbers). */
export type ChatChart = PriceChart | AllocationChart;

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: MessageStatus;
  citations: Citation[];
  /** Missing on messages saved before charts existed. */
  charts?: ChatChart[];
  toolCalls: ToolCall[];
  errorCode: string | null;
  createdAt: string;
}

export interface ChatUsage {
  used: number;
  limit: number;
  remaining: number;
  resetsAt: string;
  isDemo: boolean;
}

export interface ChatErrorPayload {
  code: string;
  message: string;
  retryable: boolean;
}

export type ChatStreamEvent =
  | {
      type: "turn";
      conversation: Conversation;
      userMessage: ChatMessage;
      assistantMessageId: string;
    }
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
  | { type: "chart"; chart: ChatChart }
  | ({ type: "error" } & ChatErrorPayload)
  | { type: "done"; message: ChatMessage };

/** The browser's IANA time zone (e.g. "America/New_York"), if available. */
export function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

const STREAM_EVENTS = new Set([
  "turn",
  "token",
  "tool_start",
  "tool_progress",
  "tool_end",
  "chart",
  "error",
  "done",
]);

export function listConversations(): Promise<Conversation[]> {
  return request<Conversation[]>("/api/conversations");
}

export function createConversation(title?: string): Promise<Conversation> {
  return request<Conversation>("/api/conversations", {
    method: "POST",
    body: JSON.stringify(title ? { title } : {}),
  });
}

export function renameConversation(id: string, title: string): Promise<Conversation> {
  return request<Conversation>(`/api/conversations/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ title }),
  });
}

export function deleteConversation(id: string): Promise<void> {
  return request<void>(`/api/conversations/${id}`, { method: "DELETE" });
}

export function listMessages(id: string): Promise<ChatMessage[]> {
  return request<ChatMessage[]>(`/api/conversations/${id}/messages`);
}

export function getChatUsage(): Promise<ChatUsage> {
  return request<ChatUsage>("/api/chat/usage");
}

/**
 * Send a message and stream the reply. Rejects with an ApiError for errors
 * before streaming starts (429 limits, 409 overlap, 422 validation, 503).
 * Aborting `signal` stops the stream; the server saves the partial reply.
 */
export function streamMessage(
  conversationId: string,
  content: string,
  onEvent: (event: ChatStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  return postStream(
    `/api/conversations/${conversationId}/messages`,
    { content, timeZone: browserTimeZone() },
    onEvent,
    signal,
  );
}

/**
 * Regenerate the latest stopped/failed reply in place. Same event stream as
 * streamMessage; no new user message is created.
 */
export function streamRetry(
  conversationId: string,
  assistantMessageId: string,
  onEvent: (event: ChatStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  return postStream(
    `/api/conversations/${conversationId}/messages/${assistantMessageId}/retry`,
    { timeZone: browserTimeZone() },
    onEvent,
    signal,
  );
}

function postStream(
  path: string,
  body: Record<string, unknown>,
  onEvent: (event: ChatStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  // The server shows dates and times in the user's own time zone.
  return postEventStream(
    path,
    body,
    STREAM_EVENTS,
    (type, data) => onEvent({ type, ...data } as ChatStreamEvent),
    signal,
  );
}
