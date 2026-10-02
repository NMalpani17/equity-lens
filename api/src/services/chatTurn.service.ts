/**
 * Relays one chat turn's upstream events to the client and decides what to
 * persist: the final answer, an error, or — if the client disconnected — the
 * partial text with an `interrupted` status.
 */
import type { TurnOutcome } from "./chat.service.js";
import type { AiChatEvent, ToolCallDto } from "./chatStream.service.js";
import { getPortfolioSummary } from "./portfolio.service.js";
import { logger } from "../logger.js";
import type { PortfolioSummary } from "../types.js";

/** Where relayed events go (the SSE response, in production). */
export interface EventSink {
  send(event: string, data: unknown): void;
}

export interface ChatErrorPayload {
  code: string;
  message: string;
  retryable: boolean;
}

export type RelayResult =
  | { kind: "done"; outcome: TurnOutcome }
  | { kind: "error"; outcome: TurnOutcome; error: ChatErrorPayload }
  | { kind: "interrupted"; outcome: TurnOutcome };

const INCOMPLETE: ChatErrorPayload = {
  code: "incomplete_response",
  message: "The answer stopped unexpectedly. Please try again.",
  retryable: true,
};

/** The user's portfolio for tool use; a failure here never blocks chat. */
export async function loadPortfolioSnapshot(
  userId: string,
): Promise<PortfolioSummary | null> {
  try {
    return await getPortfolioSummary(userId);
  } catch (error) {
    logger.warn({ err: error }, "could not load portfolio for chat");
    return null;
  }
}

export async function relayEvents(
  events: AsyncIterable<AiChatEvent>,
  sink: EventSink,
  signal: AbortSignal,
): Promise<RelayResult> {
  // Text of the current model call; reset when the model turns to tools, so
  // a "let me look that up" preamble isn't kept as the answer.
  let text = "";
  const toolCalls = new Map<string, ToolCallDto>();
  const interrupted = (): RelayResult => ({
    kind: "interrupted",
    outcome: {
      content: text.trim(),
      status: "interrupted",
      toolCalls: [...toolCalls.values()],
    },
  });

  try {
    for await (const event of events) {
      if (signal.aborted) return interrupted();
      switch (event.type) {
        case "token":
          text += event.text;
          sink.send("token", { text: event.text });
          break;
        case "tool_start":
          text = "";
          toolCalls.set(event.id, {
            id: event.id,
            name: event.name,
            label: event.label,
            args: event.args,
          });
          sink.send("tool_start", {
            id: event.id,
            name: event.name,
            label: event.label,
            args: event.args,
          });
          break;
        case "tool_end": {
          const call = toolCalls.get(event.id);
          if (call) Object.assign(call, { ok: event.ok, summary: event.summary });
          sink.send("tool_end", {
            id: event.id,
            name: event.name,
            ok: event.ok,
            summary: event.summary,
          });
          break;
        }
        case "done":
          return {
            kind: "done",
            outcome: {
              content: event.content,
              status: event.status,
              citations: event.citations,
              toolCalls: event.toolCalls,
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
              model: event.model,
            },
          };
        case "error":
          return {
            kind: "error",
            outcome: {
              content: "",
              status: "error",
              errorCode: event.code,
              toolCalls: [...toolCalls.values()],
            },
            error: {
              code: event.code,
              message: event.message,
              retryable: event.retryable,
            },
          };
      }
    }
  } catch (error) {
    if (signal.aborted) return interrupted();
    logger.warn({ err: error }, "chat stream failed mid-turn");
  }
  if (signal.aborted) return interrupted();
  return {
    kind: "error",
    outcome: {
      content: "",
      status: "error",
      errorCode: INCOMPLETE.code,
      toolCalls: [...toolCalls.values()],
    },
    error: INCOMPLETE,
  };
}
