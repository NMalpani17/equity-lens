import { afterEach, describe, expect, it, vi } from "vitest";

import {
  aiServiceFetch,
  aiServiceUrl,
  INTERNAL_TOKEN_HEADER,
} from "../src/services/aiServiceClient.js";
import { getAiServiceHealth } from "../src/services/aiService.js";
import { getQuotes, verifyTicker } from "../src/services/quotes.service.js";
import {
  getTickerStatus,
  listTickerStatuses,
  searchTranscripts,
} from "../src/services/rag.service.js";
import { openChatStream } from "../src/services/chatStream.service.js";

const TOKEN = "test-internal-token"; // from vitest.config.ts

function tokenSent(spy: { mock: { calls: unknown[][] } }): string | null {
  const init = spy.mock.calls[0]?.[1] as RequestInit | undefined;
  return new Headers(init?.headers).get(INTERNAL_TOKEN_HEADER);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("aiServiceFetch", () => {
  it("adds the internal token and keeps the caller's headers", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));

    await aiServiceFetch(aiServiceUrl("/quotes"), {
      headers: { "Content-Type": "application/json" },
    });

    const [url, init] = spy.mock.calls[0]!;
    const headers = new Headers(init?.headers);
    expect(String(url)).toBe("http://localhost:8000/quotes");
    expect(headers.get(INTERNAL_TOKEN_HEADER)).toBe(TOKEN);
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("cannot be overridden by a caller-supplied token header", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));

    await aiServiceFetch(aiServiceUrl("/health"), {
      headers: { [INTERNAL_TOKEN_HEADER]: "spoofed" },
    });

    expect(tokenSent(spy)).toBe(TOKEN);
  });
});

describe("every ai-service caller sends the internal token", () => {
  it.each([
    ["health", () => getAiServiceHealth()],
    ["batch quotes", () => getQuotes(["AAPL"])],
    ["ticker check", () => verifyTicker("AAPL")],
    ["rag search", () => searchTranscripts({ query: "q", topK: 5 }).catch(() => null)],
    ["rag ticker status", () => getTickerStatus("AAPL").catch(() => null)],
    ["rag ticker list", () => listTickerStatuses().catch(() => null)],
    [
      "chat stream",
      () =>
        openChatStream(
          {
            userId: "u",
            isAnonymous: false,
            conversationId: "c",
            message: "hi",
            history: [],
            portfolio: null,
          },
          new AbortController().signal,
        ).catch(() => null),
    ],
  ])("%s", async (_name, call) => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 500 }));

    await call();

    expect(spy).toHaveBeenCalled();
    expect(tokenSent(spy)).toBe(TOKEN);
  });
});
