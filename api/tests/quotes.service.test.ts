import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getQuotes,
  verifyTicker,
  verifyTickers,
} from "../src/services/quotes.service.js";

function upstreamQuote(overrides: Record<string, unknown> = {}) {
  return {
    ticker: "AAPL",
    price: 110,
    previous_close: 105,
    change: 5,
    change_percent: 4.76,
    currency: "USD",
    name: "Apple Inc",
    provider: "finnhub",
    as_of: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getQuotes", () => {
  it("maps snake_case upstream quotes to camelCase", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          quotes: {
            AAPL: {
              ticker: "AAPL",
              price: 110,
              previous_close: 105,
              change: 5,
              change_percent: 4.76,
              currency: "USD",
              name: "Apple Inc",
              provider: "finnhub",
              as_of: "2026-01-02T00:00:00.000Z",
            },
          },
          errors: {},
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await getQuotes(["AAPL"]);

    expect(result.quotes.AAPL).toMatchObject({
      previousClose: 105,
      changePercent: 4.76,
      asOf: "2026-01-02T00:00:00.000Z",
    });
  });

  it("returns all tickers as unavailable when the AI service fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await getQuotes(["AAPL", "MSFT"]);

    expect(result.quotes).toEqual({});
    expect(result.errors).toEqual({ AAPL: "unavailable", MSFT: "unavailable" });
  });

  it("does not call the AI service for an empty ticker list", async () => {
    const spy = vi.spyOn(globalThis, "fetch");

    const result = await getQuotes([]);

    expect(spy).not.toHaveBeenCalled();
    expect(result).toEqual({ quotes: {}, errors: {} });
  });

  it("keeps valid quotes when one quote in the batch is malformed", async () => {
    // AAPL is well-formed; BADQ has a null price (invalid). The bad entry must
    // not sink the whole batch — the old monolithic parse marked all tickers
    // unavailable in this case.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          quotes: {
            AAPL: upstreamQuote({ ticker: "AAPL" }),
            BADQ: upstreamQuote({ ticker: "BADQ", price: null }),
          },
          errors: {},
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await getQuotes(["AAPL", "BADQ"]);

    expect(result.quotes.AAPL).toMatchObject({ price: 110 });
    expect(result.quotes.BADQ).toBeUndefined();
    expect(result.errors.BADQ).toBe("unavailable");
  });

  it("passes through per-ticker not_found errors alongside valid quotes", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          quotes: { AAPL: upstreamQuote({ ticker: "AAPL" }) },
          errors: { ASDASD: "not_found" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await getQuotes(["AAPL", "ASDASD"]);

    expect(result.quotes.AAPL).toMatchObject({ price: 110 });
    expect(result.errors.ASDASD).toBe("not_found");
  });
});

describe("verifyTicker", () => {
  it("returns 'ok' when the AI service has a quote", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(upstreamQuote()), { status: 200 }),
    );

    expect(await verifyTicker("AAPL")).toBe("ok");
  });

  it("returns 'not_found' for an unknown ticker (404)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ detail: "unknown" }), { status: 404 }),
    );

    expect(await verifyTicker("ASDASD")).toBe("not_found");
  });

  it("returns 'unavailable' when the AI service can't be reached", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    expect(await verifyTicker("AAPL")).toBe("unavailable");
  });
});

describe("verifyTickers", () => {
  it("posts the tickers once and returns each status", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ results: { AAPL: "ok", ZZZZ: "not_found" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await verifyTickers(["AAPL", "ZZZZ"]);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(new URL(String(url)).pathname).toBe("/tickers/verify");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ symbols: ["AAPL", "ZZZZ"] });
    expect(result).toEqual({ AAPL: "ok", ZZZZ: "not_found" });
  });

  it("skips the call for no tickers", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    expect(await verifyTickers([])).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports every ticker unavailable when the ai-service fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));

    expect(await verifyTickers(["AAPL", "MSFT"])).toEqual({
      AAPL: "unavailable",
      MSFT: "unavailable",
    });
  });
});
