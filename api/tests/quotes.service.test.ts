import { afterEach, describe, expect, it, vi } from "vitest";

import { getQuotes } from "../src/services/quotes.service.js";

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
});
