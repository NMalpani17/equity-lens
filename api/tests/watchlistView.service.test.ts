import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/quotes.service.js", () => ({
  getBatchQuotes: vi.fn(),
  getQuotes: vi.fn(),
}));
vi.mock("../src/services/earnings.service.js", () => ({
  getUpcomingEarnings: vi.fn(),
}));
vi.mock("../src/services/reports.service.js", () => ({ reportStatuses: vi.fn() }));
vi.mock("../src/services/symbols.service.js", () => ({ symbolNames: vi.fn() }));
vi.mock("../src/services/holdings.service.js", () => ({ listHeldTickers: vi.fn() }));
vi.mock("../src/services/watchlist.service.js", () => ({
  listWatchlistItems: vi.fn(),
  fillAddedPrices: vi.fn(),
}));

import { getUpcomingEarnings } from "../src/services/earnings.service.js";
import { listHeldTickers } from "../src/services/holdings.service.js";
import { getBatchQuotes, getQuotes } from "../src/services/quotes.service.js";
import { reportStatuses } from "../src/services/reports.service.js";
import { symbolNames } from "../src/services/symbols.service.js";
import {
  fillAddedPrices,
  listWatchlistItems,
} from "../src/services/watchlist.service.js";
import { getWatchlist } from "../src/services/watchlistView.service.js";

const USER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const NOW = new Date("2026-10-20T15:00:00.000Z");
const ADDED = new Date("2026-10-01T14:00:00.000Z");

function item(ticker: string, addedPrice: number | null) {
  return {
    id: `id-${ticker}`,
    userId: USER_ID,
    ticker,
    addedPrice: addedPrice === null ? null : new Prisma.Decimal(addedPrice),
    addedPriceAt: addedPrice === null ? null : ADDED,
    createdAt: ADDED,
  };
}

function quote(ticker: string, price: number, previousClose: number) {
  const change = price - previousClose;
  return {
    ticker,
    price,
    previousClose,
    change,
    changePercent: (change / previousClose) * 100,
    currency: "USD",
    name: null,
    provider: "finnhub",
    asOf: NOW.toISOString(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listWatchlistItems).mockResolvedValue([
    item("AMD", 150),
    item("JPM", null), // added while prices were unavailable
    item("ZZZZ", 10),
  ]);
  vi.mocked(symbolNames).mockResolvedValue(
    new Map([
      ["AMD", "Advanced Micro Devices"],
      ["JPM", "JPMorgan Chase & Co"],
    ]),
  );
  vi.mocked(getBatchQuotes).mockResolvedValue({
    quotes: { AMD: quote("AMD", 165, 160), JPM: quote("JPM", 300, 303) },
    errors: { ZZZZ: "unavailable" },
  });
  vi.mocked(getUpcomingEarnings).mockResolvedValue({
    earnings: [{ ticker: "AMD", date: "2026-11-03", hour: "amc", epsEstimate: 1.9664 }],
    unscheduled: ["JPM", "ZZZZ"],
    windowStart: "2026-10-20",
    windowEnd: "2026-12-19",
    refreshedAt: null,
    refreshing: false,
    available: true,
  });
  vi.mocked(reportStatuses).mockResolvedValue(
    new Map([
      ["AMD", { status: "ready" as const, demoLocked: false }],
      ["JPM", { status: "outdated" as const, demoLocked: false }],
    ]),
  );
  vi.mocked(listHeldTickers).mockResolvedValue(["AAPL", "JPM"]);
});

describe("getWatchlist", () => {
  it("prices each row with today's change and change since added", async () => {
    const { items, limit } = await getWatchlist(USER_ID, false, NOW);

    expect(limit).toBe(50);
    expect(items[0]).toEqual({
      ticker: "AMD",
      name: "Advanced Micro Devices",
      price: 165,
      change: 5,
      changePercent: 3.13,
      priceStatus: "ok",
      addedAt: ADDED.toISOString(),
      addedPrice: 150,
      addedPriceAt: ADDED.toISOString(),
      changeSinceAdded: 15,
      changeSinceAddedPercent: 10,
      nextEarnings: { date: "2026-11-03", hour: "amc", epsEstimate: 1.9664 },
      report: { status: "ready", demoLocked: false },
      inPortfolio: false,
    });
  });

  it("uses the budgeted batch quotes, never the per-ticker path", async () => {
    await getWatchlist(USER_ID, false, NOW);

    expect(getBatchQuotes).toHaveBeenCalledWith(["AMD", "JPM", "ZZZZ"]);
    expect(getQuotes).not.toHaveBeenCalled();
  });

  it("fills a missing price when added from today's quote, once", async () => {
    const { items } = await getWatchlist(USER_ID, false, NOW);

    expect(fillAddedPrices).toHaveBeenCalledWith(USER_ID, new Map([["JPM", 300]]), NOW);
    expect(items[1]).toMatchObject({
      addedPrice: 300,
      addedPriceAt: NOW.toISOString(),
      changeSinceAdded: 0,
      changeSinceAddedPercent: 0,
    });
  });

  it("shows no price and no change for an unpriced ticker", async () => {
    const { items } = await getWatchlist(USER_ID, false, NOW);

    expect(items[2]).toMatchObject({
      ticker: "ZZZZ",
      name: null,
      price: null,
      change: null,
      priceStatus: "unavailable",
      addedPrice: 10,
      changeSinceAdded: null,
      nextEarnings: null,
      report: { status: "none", demoLocked: false },
    });
  });

  it("marks tickers the user also holds", async () => {
    const { items } = await getWatchlist(USER_ID, false, NOW);

    expect(items.map((row) => [row.ticker, row.inPortfolio])).toEqual([
      ["AMD", false],
      ["JPM", true],
      ["ZZZZ", false],
    ]);
  });

  it("passes demo status to the report rules", async () => {
    await getWatchlist(USER_ID, true, NOW);

    expect(reportStatuses).toHaveBeenCalledWith(["AMD", "JPM", "ZZZZ"], true);
  });

  it("skips the price fill when nothing is missing", async () => {
    vi.mocked(listWatchlistItems).mockResolvedValue([item("AMD", 150)]);

    await getWatchlist(USER_ID, false, NOW);

    expect(fillAddedPrices).not.toHaveBeenCalled();
  });
});
