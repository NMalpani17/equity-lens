import { afterEach, describe, expect, it, vi } from "vitest";

import { UpstreamError } from "../src/errors.js";
import { getDailyCloses } from "../src/services/priceHistory.service.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getDailyCloses", () => {
  it("requests the tickers from the start date and returns the series", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        series: { AAPL: [{ date: "2026-10-16", close: 101.5 }] },
        errors: { GONE: "not_found" },
        through: "2026-10-16",
      }),
    );

    const result = await getDailyCloses(["AAPL", "GONE", "SPY"], "2026-10-01");

    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.pathname).toBe("/history/daily");
    expect(url.searchParams.get("symbols")).toBe("AAPL,GONE,SPY");
    expect(url.searchParams.get("start")).toBe("2026-10-01");
    expect(result.series.AAPL).toEqual([{ date: "2026-10-16", close: 101.5 }]);
    expect(result.errors).toEqual({ GONE: "not_found" });
  });

  it.each([
    ["a non-OK response", () => Promise.resolve(jsonResponse({ error: "x" }, 500))],
    ["a malformed body", () => Promise.resolve(jsonResponse({ series: "nope" }))],
    ["a network failure", () => Promise.reject(new TypeError("fetch failed"))],
  ])("throws UpstreamError on %s", async (_label, respond) => {
    vi.spyOn(globalThis, "fetch").mockImplementation(respond);

    await expect(getDailyCloses(["AAPL"], "2026-10-01")).rejects.toBeInstanceOf(
      UpstreamError,
    );
  });
});
