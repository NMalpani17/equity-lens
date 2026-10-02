import { describe, expect, it } from "vitest";

import type { AiChatEvent, ChartDto } from "../src/services/chatStream.service.js";
import { relayEvents } from "../src/services/chatTurn.service.js";

function sink() {
  const sent: { event: string; data: unknown }[] = [];
  return { sent, send: (event: string, data: unknown) => sent.push({ event, data }) };
}

async function* events(...items: AiChatEvent[]) {
  for (const item of items) yield item;
}

const DONE: AiChatEvent = {
  type: "done",
  content: "NVDA guided higher [1].",
  status: "complete",
  citations: [],
  charts: [],
  toolCalls: [],
  inputTokens: 100,
  outputTokens: 20,
  model: "m",
};

describe("relayEvents", () => {
  it("relays progress and returns the final answer", async () => {
    const out = sink();

    const result = await relayEvents(
      events(
        { type: "token", text: "Let me check. " },
        {
          type: "tool_start",
          id: "t1",
          name: "get_quote",
          label: "Getting NVDA quote…",
          args: {},
        },
        {
          type: "tool_end",
          id: "t1",
          name: "get_quote",
          ok: true,
          summary: "NVDA 180",
        },
        { type: "token", text: "NVDA guided higher [1]." },
        DONE,
      ),
      out,
      new AbortController().signal,
    );

    expect(out.sent.map((s) => s.event)).toEqual([
      "token",
      "tool_start",
      "tool_end",
      "token",
    ]);
    expect(result).toMatchObject({
      kind: "done",
      outcome: {
        content: "NVDA guided higher [1].",
        status: "complete",
        inputTokens: 100,
      },
    });
  });

  it("turns an upstream error into an error outcome", async () => {
    const result = await relayEvents(
      events({
        type: "error",
        code: "ai_credits_exhausted",
        message: "Out of credits",
        retryable: false,
      }),
      sink(),
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      kind: "error",
      outcome: { status: "error", errorCode: "ai_credits_exhausted" },
      error: { code: "ai_credits_exhausted", retryable: false },
    });
  });

  it("treats a stream that ends without done as an incomplete error", async () => {
    const result = await relayEvents(
      events({ type: "token", text: "partial" }),
      sink(),
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      kind: "error",
      error: { code: "incomplete_response" },
    });
  });

  it("saves partial text as interrupted when the client disconnects", async () => {
    const abort = new AbortController();
    async function* slow(): AsyncGenerator<AiChatEvent> {
      yield {
        type: "tool_start",
        id: "t1",
        name: "search_transcripts",
        label: "Searching…",
        args: {},
      };
      yield { type: "token", text: "Demand was " };
      yield { type: "token", text: "strong" };
      abort.abort(); // the browser went away
      yield { type: "token", text: " and growing" };
      yield DONE;
    }

    const result = await relayEvents(slow(), sink(), abort.signal);

    expect(result).toEqual({
      kind: "interrupted",
      outcome: {
        content: "Demand was strong",
        status: "interrupted",
        charts: [],
        toolCalls: [
          { id: "t1", name: "search_transcripts", label: "Searching…", args: {} },
        ],
      },
    });
  });

  it("treats a failing upstream after abort as interrupted, not an error", async () => {
    const abort = new AbortController();
    async function* failing(): AsyncGenerator<AiChatEvent> {
      yield { type: "token", text: "Half" };
      abort.abort();
      throw new Error("socket closed");
    }

    const result = await relayEvents(failing(), sink(), abort.signal);

    expect(result.kind).toBe("interrupted");
    expect(result.outcome.content).toBe("Half");
  });
});

describe("tool progress", () => {
  it("relays progress labels for the running tool", async () => {
    const out = sink();

    await relayEvents(
      events(
        {
          type: "tool_start",
          id: "t1",
          name: "search_transcripts",
          label: "Searching SBUX transcripts…",
          args: {},
        },
        { type: "tool_progress", id: "t1", label: "Indexing Starbucks transcripts…" },
        DONE,
      ),
      out,
      new AbortController().signal,
    );

    expect(out.sent[1]).toEqual({
      event: "tool_progress",
      data: { id: "t1", label: "Indexing Starbucks transcripts…" },
    });
  });
});

describe("charts", () => {
  const CHART: Extract<ChartDto, { kind: "price_history" }> = {
    id: "chart-h1",
    kind: "price_history",
    ticker: "NVDA",
    period: "6mo",
    currency: "USD",
    points: [
      { date: "2026-04-01", close: 100 },
      { date: "2026-10-01", close: 120 },
    ],
    firstClose: 100,
    lastClose: 120,
    change: 20,
    changePercent: 20,
    high: 121,
    low: 98,
    asOf: null,
  };

  it("relays chart events and saves the final charts with the answer", async () => {
    const out = sink();

    const result = await relayEvents(
      events({ type: "chart", chart: CHART }, { ...DONE, charts: [CHART] }),
      out,
      new AbortController().signal,
    );

    expect(out.sent).toEqual([{ event: "chart", data: { chart: CHART } }]);
    expect(result).toMatchObject({ kind: "done", outcome: { charts: [CHART] } });
  });

  it("keeps charts already streamed when the client disconnects", async () => {
    const abort = new AbortController();
    async function* stopped(): AsyncGenerator<AiChatEvent> {
      yield { type: "chart", chart: { ...CHART, lastClose: 110 } };
      yield { type: "chart", chart: CHART }; // same chart again: replaces
      yield { type: "token", text: "NVDA rose" };
      abort.abort();
      yield DONE;
    }

    const result = await relayEvents(stopped(), sink(), abort.signal);

    expect(result).toMatchObject({
      kind: "interrupted",
      outcome: { content: "NVDA rose", charts: [CHART] },
    });
  });
});
