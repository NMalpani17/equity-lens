/** Pure helpers for rendering chat messages. */
import type { ChatMessage, Citation } from "./chatApi";

export const CITE_PREFIX = "#cite-";

/**
 * Turn [n] markers that match a known citation into in-page links, which
 * ChatMarkdown renders as buttons. Unknown numbers are left as plain text.
 */
export function linkCitations(content: string, citations: Citation[]): string {
  const known = new Set(citations.map((c) => c.id));
  return content.replace(/\[(\d{1,2})\](?!\()/g, (match, raw: string) =>
    known.has(Number(raw)) ? `[\\[${raw}\\]](${CITE_PREFIX}${raw})` : match,
  );
}

/** Fallback text so an assistant bubble is never blank. */
export function fallbackText(message: ChatMessage): string | null {
  if (message.content.trim()) return null;
  switch (message.status) {
    case "interrupted":
      return "Stopped before an answer was written.";
    case "error":
      return "This reply failed. Please try again.";
    case "blocked":
      return "This request couldn't be answered.";
    case "empty":
      return "No answer was produced. Try rephrasing the question.";
    default:
      return null;
  }
}

export const STARTER_QUESTIONS = [
  "What did NVIDIA say about Vera Rubin timing last quarter?",
  "How is my portfolio allocated, and where am I most concentrated?",
  "Compare Microsoft's and Alphabet's cloud growth commentary.",
  "How has AAPL performed over the last 6 months?",
];
