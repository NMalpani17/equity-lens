/** Typed client for the AI analyst chat endpoints. */
import { API_URL, apiErrorFrom, ApiError, authHeaders, request } from "./api";
import { parseSse } from "./sse";

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

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: MessageStatus;
  citations: Citation[];
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
export async function streamMessage(
  conversationId: string,
  content: string,
  onEvent: (event: ChatStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}/api/conversations/${conversationId}/messages`, {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...(await authHeaders()),
      },
      // The server shows dates and times in the user's own time zone.
      body: JSON.stringify({ content, timeZone: browserTimeZone() }),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError(0, "Could not reach the API. Is it running?");
  }
  if (!response.ok || !response.body) {
    throw await apiErrorFrom(response);
  }
  for await (const frame of parseSse(response.body)) {
    if (!STREAM_EVENTS.has(frame.event)) continue;
    try {
      onEvent({ type: frame.event, ...JSON.parse(frame.data) } as ChatStreamEvent);
    } catch {
      // Ignore a malformed frame rather than abandoning the stream.
    }
  }
}
