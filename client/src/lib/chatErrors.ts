/** Friendly, user-facing messages for chat failures (never raw status codes). */
import { ApiError } from "./api";
import { describeReset } from "./format";

export interface ChatBannerState {
  kind: "limit" | "credits" | "busy" | "error";
  message: string;
}

/** What the user was doing when something failed. */
export type ChatAction = "send" | "retry" | "load";

const FALLBACK: Record<ChatAction, string> = {
  send: "Couldn't send your message. Please try again.",
  retry: "Couldn't retry that message. Please try again.",
  load: "Couldn't load your conversations. Please try again.",
};

export const DROPPED_MESSAGE =
  "The connection dropped before the reply finished. Please try again.";

/** The banner for a failed request, worded for what the user was doing. */
export function bannerForError(error: unknown, action: ChatAction): ChatBannerState {
  if (!(error instanceof ApiError)) return { kind: "error", message: FALLBACK[action] };
  if (error.status === 429) {
    const base =
      error.code === "chat_limit_reached"
        ? error.message
        : "You've reached today's message limit.";
    const resetsAt = error.details.resetsAt;
    // The server sends the reset as a timestamp; show it on the user's clock.
    return {
      kind: "limit",
      message:
        typeof resetsAt === "string"
          ? `${base} It resets ${describeReset(resetsAt)}.`
          : `${base} Please try again after the daily reset.`,
    };
  }
  switch (error.code) {
    case "turn_in_progress":
      return {
        kind: "busy",
        message: "A reply is still being written. Please wait a moment and try again.",
      };
    case "retry_not_allowed":
      return {
        kind: "error",
        message: "Only the latest stopped or failed reply can be retried.",
      };
    case "chat_unavailable":
    case "chat_not_configured":
      return {
        kind: "error",
        message: "The AI analyst is unavailable right now. Please try again shortly.",
      };
    case "not_found":
      return { kind: "error", message: "This conversation no longer exists." };
  }
  if (error.status === 0) {
    return {
      kind: "error",
      message: "Couldn't reach Equity Lens. Check your connection and try again.",
    };
  }
  if (error.status === 401) {
    return {
      kind: "error",
      message: "Your session has expired. Please sign in again.",
    };
  }
  return { kind: "error", message: FALLBACK[action] };
}

/** The banner for an `error` event inside a stream (already user-facing text). */
export function bannerForStreamError(code: string, message: string): ChatBannerState {
  if (code === "ai_credits_exhausted") return { kind: "credits", message };
  if (code === "ai_rate_limited") return { kind: "busy", message };
  return { kind: "error", message };
}

/** The server is still finishing the previous turn (e.g. just after Stop). */
export function isTurnInProgress(error: unknown): boolean {
  return error instanceof ApiError && error.code === "turn_in_progress";
}
