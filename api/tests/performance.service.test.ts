import { describe, expect, it } from "vitest";

import {
  BENCHMARK_TICKER,
  MAX_POINTS,
  computePerformance,
  downsample,
  newYorkDate,
  planPerformance,
  shiftMonths,
} from "../src/services/performance.service.js";
import type { PricePoint } from "../src/services/priceHistory.service.js";
import type { HoldingDto } from "../src/types.js";

const TODAY = "2026-10-16";

function lot(ticker: string, shares: number, purchaseDate: string | null): HoldingDto {
  return {
    id: `${ticker}-${purchaseDate}`,
    ticker,
    shares,
    buyPrice: 1,
    purchaseDate,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

/** Closes keyed by date, as the price-history client returns them. */
function closes(byDate: Record<string, number>): PricePoint[] {
  return Object.entries(byDate).map(([date, close]) => ({ date, close }));
}

// Mon Oct 5 – Fri Oct 16, 2026, skipping the weekend.
const DAYS = [
  "2026-10-05",
  "2026-10-06",
  "2026-10-07",
  "2026-10-08",
  "2026-10-09",
  "2026-10-12",
  "2026-10-13",
  "2026-10-14",
  "2026-10-15",
  "2026-10-16",
];

function flat(price: number, days = DAYS): PricePoint[] {
  return days.map((date) => ({ date, close: price }));
}

describe("computePerformance", () => {
  it("returns the price change for a single lot held the whole range", () => {
    const result = computePerformance([lot("AAPL", 10, "2026-10-05")], "ALL", TODAY, {
      series: {
        AAPL: closes({ "2026-10-05": 100, "2026-10-09": 105, "2026-10-16": 110 }),
        SPY: closes({ "2026-10-05": 400, "2026-10-09": 410, "2026-10-16": 420 }),
      },
    });

    expect(result.status).toBe("ok");
    expect(result.startDate).toBe("2026-10-05");
    expect(result.endDate).toBe("2026-10-16");
    expect(result.portfolioReturnPercent).toBe(10);
    expect(result.benchmarkReturnPercent).toBe(5);
    expect(result.points[0]).toEqual({
      date: "2026-10-05",
      portfolioPercent: 0,
      benchmarkPercent: 0,
      portfolioValue: 1000,
    });
    expect(result.points.at(-1)?.portfolioValue).toBe(1100);
  });

  it("does not count a lot bought mid-range as a gain (time-weighted)", () => {
    const result = computePerformance(
      [lot("AAPL", 10, "2026-10-05"), lot("MSFT", 10, "2026-10-07")],
      "ALL",
      TODAY,
      {
        series: {
          AAPL: closes({ "2026-10-05": 100, "2026-10-08": 110 }),
          MSFT: flat(50),
          SPY: flat(400),
        },
      },
    );

    const byDate = Object.fromEntries(result.points.map((p) => [p.date, p]));
    // Value jumps from 1,000 to 1,500 when MSFT is bought; the return doesn't.
    expect(byDate["2026-10-06"]).toMatchObject({
      portfolioValue: 1000,
      portfolioPercent: 0,
    });
    expect(byDate["2026-10-07"]).toMatchObject({
      portfolioValue: 1500,
      portfolioPercent: 0,
    });
    // AAPL +10% on a 1,500 portfolio: +100 / 1,500.
    expect(byDate["2026-10-08"]).toMatchObject({
      portfolioValue: 1600,
      portfolioPercent: 6.67,
    });
    expect(result.portfolioReturnPercent).toBe(6.67);
  });

  it("starts a weekend purchase at the next trading day's close", () => {
    const result = computePerformance([lot("AAPL", 1, "2026-10-10")], "ALL", TODAY, {
      series: { AAPL: flat(100), SPY: flat(400) },
    });

    expect(result.startDate).toBe("2026-10-12");
    expect(result.points.every((p) => p.date >= "2026-10-12")).toBe(true);
  });

  it("opens the range at the last close on or before its start", () => {
    // 1M before Oct 16 is Wed Sep 16, a (pretend) holiday: open from Sep 15.
    const days = ["2026-09-14", "2026-09-15", "2026-09-17", ...DAYS];
    const result = computePerformance([lot("AAPL", 1, "2025-01-02")], "1M", TODAY, {
      series: {
        AAPL: closes({ "2026-09-14": 90, "2026-09-15": 100, "2026-10-16": 120 }),
        SPY: flat(400, days),
      },
    });

    expect(result.startDate).toBe("2026-09-15");
    expect(result.startClamped).toBe(false);
    expect(result.portfolioReturnPercent).toBe(20);
  });

  it("starts at the first purchase when the range began before it", () => {
    const result = computePerformance([lot("AAPL", 1, "2026-10-08")], "1Y", TODAY, {
      series: {
        AAPL: flat(100),
        SPY: closes({ "2026-10-05": 380, "2026-10-08": 400, "2026-10-16": 440 }),
      },
    });

    expect(result.startDate).toBe("2026-10-08");
    expect(result.startClamped).toBe(true);
    // Both lines are rebased to the same start.
    expect(result.benchmarkReturnPercent).toBe(10);
  });

  it("carries a close forward over a day a holding didn't trade", () => {
    const result = computePerformance([lot("XYZ", 2, "2026-10-05")], "ALL", TODAY, {
      series: {
        XYZ: closes({ "2026-10-05": 10, "2026-10-07": 12 }), // no Oct 6 close
        SPY: flat(400),
      },
    });

    const oct6 = result.points.find((p) => p.date === "2026-10-06");
    expect(oct6).toMatchObject({ portfolioValue: 20, portfolioPercent: 0 });
  });

  it("skips tickers without history and notes them", () => {
    const result = computePerformance(
      [lot("AAPL", 1, "2026-10-05"), lot("GONE", 5, "2026-10-05")],
      "ALL",
      TODAY,
      { series: { AAPL: flat(100), SPY: flat(400) } },
    );

    expect(result.status).toBe("ok");
    expect(result.excluded).toEqual([{ ticker: "GONE", reason: "no_history" }]);
    expect(result.points[0]?.portfolioValue).toBe(100);
  });

  it("leaves out lots without a purchase date and counts them", () => {
    const result = computePerformance(
      [lot("AAPL", 1, "2026-10-05"), lot("MSFT", 1, null), lot("NVDA", 1, null)],
      "ALL",
      TODAY,
      { series: { AAPL: flat(100), SPY: flat(400) } },
    );

    expect(result.lotsWithoutDate).toBe(2);
    expect(result.points[0]?.portfolioValue).toBe(100);
  });

  it("reports an empty portfolio and one with no dated lots", () => {
    expect(computePerformance([], "1Y", TODAY, { series: {} })).toMatchObject({
      status: "empty",
      points: [],
    });
    expect(
      computePerformance([lot("AAPL", 1, null)], "1Y", TODAY, { series: {} }),
    ).toMatchObject({
      status: "no_dates",
      lotsWithoutDate: 1,
    });
  });

  it("has no data when the only lot has no close yet", () => {
    const result = computePerformance(
      [lot("AAPL", 1, "2026-10-17")],
      "1M",
      "2026-10-17",
      {
        series: { AAPL: flat(100), SPY: flat(400) },
      },
    );

    expect(result.status).toBe("no_data");
    expect(result.excluded).toEqual([{ ticker: "AAPL", reason: "no_close_yet" }]);
  });

  it("charts without the benchmark when its closes are missing", () => {
    const result = computePerformance([lot("AAPL", 1, "2026-10-05")], "ALL", TODAY, {
      series: { AAPL: closes({ "2026-10-05": 100, "2026-10-06": 105 }) },
    });

    expect(result.benchmark).toEqual({ ticker: BENCHMARK_TICKER, available: false });
    expect(result.benchmarkReturnPercent).toBeNull();
    expect(result.points.map((p) => p.date)).toEqual(["2026-10-05", "2026-10-06"]);
    expect(result.portfolioReturnPercent).toBe(5);
  });

  it("thins long series but keeps the true end return", () => {
    const days = Array.from({ length: 1000 }, (_, i) => {
      const d = new Date(Date.UTC(2023, 0, 2 + i));
      return d.toISOString().slice(0, 10);
    });
    const rising = days.map((date, i) => ({ date, close: 100 + i }));
    const result = computePerformance([lot("AAPL", 1, days[0]!)], "ALL", days.at(-1)!, {
      series: { AAPL: rising, SPY: rising },
    });

    expect(result.points).toHaveLength(MAX_POINTS);
    expect(result.points[0]?.date).toBe(days[0]);
    expect(result.points.at(-1)?.date).toBe(days.at(-1));
    expect(result.portfolioReturnPercent).toBe(999);
  });
});

describe("planPerformance", () => {
  it("fetches from the later of range start and first purchase, minus a lookback", () => {
    const lots = [lot("AAPL", 1, "2025-03-01"), lot("SPY", 1, "2026-01-02")];

    expect(planPerformance(lots, "1M", TODAY)).toEqual({
      tickers: ["AAPL", "SPY"],
      start: "2026-09-06",
    });
    expect(planPerformance(lots, "ALL", TODAY)?.start).toBe("2025-02-19");
    expect(planPerformance([lot("AAPL", 1, "2026-10-01")], "1Y", TODAY)).toEqual({
      tickers: ["AAPL", "SPY"],
      start: "2026-09-21",
    });
  });

  it("needs no closes without dated lots", () => {
    expect(planPerformance([lot("AAPL", 1, null)], "1Y", TODAY)).toBeNull();
  });
});

describe("date helpers", () => {
  it("shifts months, clamping to the month's last day", () => {
    expect(shiftMonths("2026-03-31", -1)).toBe("2026-02-28");
    expect(shiftMonths("2024-03-31", -1)).toBe("2024-02-29");
    expect(shiftMonths("2026-01-15", -12)).toBe("2025-01-15");
    expect(shiftMonths("2026-10-16", -6)).toBe("2026-04-16");
  });

  it("uses New York's calendar date", () => {
    expect(newYorkDate(new Date("2026-10-17T02:00:00.000Z"))).toBe("2026-10-16");
    expect(newYorkDate(new Date("2026-10-17T05:00:00.000Z"))).toBe("2026-10-17");
  });

  it("downsamples evenly, keeping both ends", () => {
    expect(downsample([1, 2, 3], 5)).toEqual([1, 2, 3]);
    const thinned = downsample(
      Array.from({ length: 100 }, (_, i) => i),
      5,
    );
    expect(thinned).toEqual([0, 25, 50, 74, 99]);
  });
});
