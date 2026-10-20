import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/holdings.service.js", () => ({ listHeldTickers: vi.fn() }));
vi.mock("../src/services/watchlist.service.js", () => ({
  listWatchlistItems: vi.fn(),
}));
vi.mock("../src/services/symbols.service.js", () => ({ symbolNames: vi.fn() }));

import {
  getUpcomingEarnings,
  getUserUpcomingEarnings,
} from "../src/services/earnings.service.js";
import { listHeldTickers } from "../src/services/holdings.service.js";
import { symbolNames } from "../src/services/symbols.service.js";
import { listWatchlistItems } from "../src/services/watchlist.service.js";

const USER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

const upstream = {
  earnings: [
    {
      ticker: "MSFT",
      date: "2026-10-28",
      hour: "amc",
      eps_estimate: 3.6,
      revenue_estimate: 75e9,
      fiscal_year: 2027,
      fiscal_quarter: 1,
    },
    {
      ticker: "AMD",
      date: "2026-11-03",
      hour: "amc",
      eps_estimate: 1.9664,
      revenue_estimate: null,
      fiscal_year: 2026,
      fiscal_quarter: 3,
    },
  ],
  unscheduled: ["VOO", "JPM"],
  window_start: "2026-10-20",
  window_end: "2026-12-19",
  refreshed_at: "2026-10-20T13:00:00Z",
  refreshing: false,
  available: true,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getUpcomingEarnings", () => {
  it("asks the ai-service for the next 60 days", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(upstream));

    const result = await getUpcomingEarnings(["MSFT", "AMD", "VOO", "JPM"]);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(new URL(String(url)).pathname).toBe("/earnings/upcoming");
    expect(JSON.parse(String(init?.body))).toEqual({
      symbols: ["MSFT", "AMD", "VOO", "JPM"],
      days: 60,
    });
    expect(result.earnings[1]).toEqual({
      ticker: "AMD",
      date: "2026-11-03",
      hour: "amc",
      epsEstimate: 1.9664,
    });
    expect(result.unscheduled).toEqual(["VOO", "JPM"]);
    expect(result.available).toBe(true);
  });

  it.each([
    ["a non-OK answer", () => Promise.resolve(new Response("", { status: 503 }))],
    ["a malformed body", () => Promise.resolve(jsonResponse({ earnings: "x" }))],
    ["a network failure", () => Promise.reject(new TypeError("fetch failed"))],
  ])("lists every ticker unscheduled and unavailable on %s", async (_, answer) => {
    vi.spyOn(globalThis, "fetch").mockImplementation(answer);

    const result = await getUpcomingEarnings(["AMD"]);

    expect(result).toMatchObject({
      earnings: [],
      unscheduled: ["AMD"],
      available: false,
    });
  });

  it("makes no call for no tickers", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const result = await getUpcomingEarnings([]);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.earnings).toEqual([]);
    expect(result.available).toBe(true);
  });
});

describe("getUserUpcomingEarnings", () => {
  it("covers holdings and watchlist, tagged by source", async () => {
    vi.mocked(listHeldTickers).mockResolvedValue(["MSFT", "VOO", "AMD"]);
    vi.mocked(listWatchlistItems).mockResolvedValue([
      { ticker: "AMD" },
      { ticker: "JPM" },
    ] as never);
    vi.mocked(symbolNames).mockResolvedValue(
      new Map([
        ["MSFT", "Microsoft Corp"],
        ["AMD", "Advanced Micro Devices"],
      ]),
    );
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(upstream));

    const result = await getUserUpcomingEarnings(USER_ID);

    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)).symbols).toEqual([
      "MSFT",
      "VOO",
      "AMD",
      "JPM",
    ]);
    expect(result.earnings.map((e) => [e.ticker, e.name, e.source])).toEqual([
      ["MSFT", "Microsoft Corp", "holding"],
      ["AMD", "Advanced Micro Devices", "both"],
    ]);
    expect(result.unscheduled).toEqual([
      { ticker: "VOO", name: null, source: "holding" },
      { ticker: "JPM", name: null, source: "watchlist" },
    ]);
    expect(result.windowEnd).toBe("2026-12-19");
  });
});
