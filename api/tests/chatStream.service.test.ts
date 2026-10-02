import { afterEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config.js";
import { HttpError, ServiceUnavailableError } from "../src/errors.js";
import {
  mapEvent,
  openChatStream,
  parseSse,
} from "../src/services/chatStream.service.js";

const encoder = new TextEncoder();

async function* chunks(...parts: string[]) {
  for (const part of parts) yield encoder.encode(part);
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

function sseResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}

const REQUEST = {
  userId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  isAnonymous: false,
  conversationId: "c1",
  message: "What did NVDA say?",
  history: [],
  portfolio: null,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseSse", () => {
  it("reassembles frames split across chunks", async () => {
    const frames = await collect(
      parseSse(
        chunks(
          'event: token\ndata: {"te',
          'xt":"Hi"}\n\nevent: done\r\n',
          'data: {"x":1}\r\n\r\n',
        ),
      ),
    );

    expect(frames).toEqual([
      { event: "token", data: '{"text":"Hi"}' },
      { event: "done", data: '{"x":1}' },
    ]);
  });
});

describe("mapEvent", () => {
  it("maps done events to camelCase", () => {
    const event = mapEvent("done", {
      content: "Answer [1]",
      status: "complete",
      citations: [
        {
          id: 1,
          ticker: "NVDA",
          company_name: "Nvidia Corp",
          fiscal_year: 2027,
          fiscal_quarter: 2,
          call_date: "2026-08-26",
          speaker: "Colette Kress",
          role: "CFO",
          section: "prepared_remarks",
          text: "Data center revenue grew.",
        },
      ],
      tool_calls: [
        { id: "t1", name: "search_transcripts", label: "Searching…", args: {} },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
      model: "google_genai:gemini-3.8-flash",
    });

    expect(event).toMatchObject({
      type: "done",
      citations: [
        { companyName: "Nvidia Corp", fiscalQuarter: 2, callDate: "2026-08-26" },
      ],
      inputTokens: 10,
      outputTokens: 5,
    });
  });

  it("drops malformed or unknown events", () => {
    expect(mapEvent("token", { text: 5 })).toBeNull();
    expect(mapEvent("done", { content: "x", status: "bogus" })).toBeNull();
    expect(mapEvent("mystery", {})).toBeNull();
  });
});

describe("mapEvent chart", () => {
  const price = {
    id: "chart-h1",
    kind: "price_history",
    ticker: "NVDA",
    period: "6mo",
    currency: "USD",
    points: [
      { date: "2026-04-01", close: 100 },
      { date: "2026-10-01", close: 120 },
    ],
    first_close: 100,
    last_close: 120,
    change: 20,
    change_percent: 20,
    high: 121,
    low: 98,
    as_of: "2026-10-01T20:00:00Z",
  };
  const allocation = {
    id: "chart-p1",
    kind: "portfolio_allocation",
    currency: "USD",
    slices: [{ ticker: "NVDA", name: null, market_value: 1500, weight_percent: 100 }],
    total_market_value: 1500,
    partial: false,
  };

  it("maps price and allocation charts to camelCase", () => {
    expect(mapEvent("chart", price)).toEqual({
      type: "chart",
      chart: {
        id: "chart-h1",
        kind: "price_history",
        ticker: "NVDA",
        period: "6mo",
        currency: "USD",
        points: price.points,
        firstClose: 100,
        lastClose: 120,
        change: 20,
        changePercent: 20,
        high: 121,
        low: 98,
        asOf: "2026-10-01T20:00:00Z",
      },
    });
    expect(mapEvent("chart", allocation)).toMatchObject({
      chart: {
        kind: "portfolio_allocation",
        slices: [{ ticker: "NVDA", marketValue: 1500, weightPercent: 100 }],
        totalMarketValue: 1500,
        asOf: null,
      },
    });
  });

  it("attaches charts to done and rejects malformed charts", () => {
    const done = mapEvent("done", {
      content: "x",
      status: "complete",
      citations: [],
      charts: [allocation],
      tool_calls: [],
      usage: {},
    });
    expect(done).toMatchObject({ charts: [{ id: "chart-p1" }] });
    expect(mapEvent("chart", { ...price, points: [price.points[0]] })).toBeNull();
    expect(mapEvent("chart", { ...price, kind: "pie" })).toBeNull();
    expect(mapEvent("chart", { ...allocation, slices: [] })).toBeNull();
  });
});

describe("openChatStream", () => {
  it("sends the internal token and user context, then yields events", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        sseResponse(
          'event: tool_start\ndata: {"id":"t1","name":"get_quote","label":"Getting NVDA quote…","args":{"ticker":"NVDA"}}\n\n' +
            'event: token\ndata: {"text":"NVDA is up."}\n\n' +
            "event: garbage\ndata: not json\n\n",
        ),
      );

    const events = await collect(
      await openChatStream(REQUEST, new AbortController().signal),
    );

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toMatch(/\/chat\/stream$/);
    expect(new Headers(init?.headers).get("X-Internal-Token")).toBe(
      "test-internal-token",
    );
    expect(JSON.parse(String(init?.body))).toMatchObject({
      user_id: REQUEST.userId,
      message: "What did NVDA say?",
      portfolio: null,
    });
    expect(events.map((e) => e.type)).toEqual(["tool_start", "token"]);
  });

  it("refuses to call upstream when the token is not configured", async () => {
    const original = config.aiServiceInternalToken;
    (config as { aiServiceInternalToken: string }).aiServiceInternalToken = "";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      await expect(
        openChatStream(REQUEST, new AbortController().signal),
      ).rejects.toMatchObject({
        status: 503,
        code: "chat_not_configured",
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      (config as { aiServiceInternalToken: string }).aiServiceInternalToken = original;
    }
  });

  it("maps upstream refusals", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: "message_too_long", message: "Too long." }),
        {
          status: 422,
        },
      ),
    );
    fetchSpy.mockResolvedValueOnce(new Response("{}", { status: 401 }));
    fetchSpy.mockRejectedValueOnce(new TypeError("fetch failed"));
    const signal = new AbortController().signal;

    await expect(openChatStream(REQUEST, signal)).rejects.toMatchObject({
      status: 422,
      code: "message_too_long",
    });
    await expect(openChatStream(REQUEST, signal)).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );
    const unreachable = await openChatStream(REQUEST, signal).catch((e: unknown) => e);
    expect(unreachable).toBeInstanceOf(HttpError);
    expect(unreachable).toMatchObject({ status: 503, code: "chat_unavailable" });
  });
});

describe("mapEvent tool_progress", () => {
  it("accepts progress labels and rejects malformed ones", () => {
    expect(mapEvent("tool_progress", { id: "t1", label: "Indexing…" })).toEqual({
      type: "tool_progress",
      id: "t1",
      label: "Indexing…",
    });
    expect(mapEvent("tool_progress", { id: "t1" })).toBeNull();
  });
});
