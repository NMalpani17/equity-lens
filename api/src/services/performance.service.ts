/**
 * Portfolio performance vs the S&P 500 (SPY), as % price return.
 *
 * Built from each lot's purchase date and quantity: a lot joins at the close of
 * its purchase date (or the next trading day's, for a weekend or holiday), so it
 * only counts from the day it was bought. The return is time-weighted: each
 * day's return excludes that day's new lots, which enter as cash flows valued at
 * the close, so buying more never shows up as a gain. Closes are split-adjusted
 * without dividends (price return) for holdings and benchmark alike.
 *
 * Lots without a purchase date can't be placed in time and are left out (and
 * counted, so the UI can say so). There is no record of sales: the chart shows
 * the current lots, back-dated.
 */
import { listHoldings } from "./holdings.service.js";
import {
  getDailyCloses,
  type DailyCloses,
  type PricePoint,
} from "./priceHistory.service.js";
import type {
  HoldingDto,
  PerformanceExclusionReason,
  PerformancePoint,
  PerformanceRange,
  PortfolioPerformance,
} from "../types.js";

export const BENCHMARK_TICKER = "SPY";
/** Points sent to the client at most; longer series are thinned evenly. */
export const MAX_POINTS = 400;

const RANGE_MONTHS: Record<Exclude<PerformanceRange, "ALL">, number> = {
  "1M": 1,
  "3M": 3,
  "6M": 6,
  "1Y": 12,
};
/** Closes fetched before the range start, so its opening close is covered. */
const LOOKBACK_DAYS = 10;

interface DatedLot {
  ticker: string;
  shares: number;
  purchaseDate: string;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Today's calendar date in New York (the market's time zone), YYYY-MM-DD. */
export function newYorkDate(now: Date): string {
  // en-CA formats as YYYY-MM-DD.
  return now.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

/** `date` moved by whole months, clamped to the month's last day. */
export function shiftMonths(date: string, months: number): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

function shiftDays(date: string, days: number): string {
  const shifted = new Date(`${date}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

function datedLots(lots: HoldingDto[]): DatedLot[] {
  return lots.flatMap((lot) =>
    lot.purchaseDate
      ? [{ ticker: lot.ticker, shares: lot.shares, purchaseDate: lot.purchaseDate }]
      : [],
  );
}

/** The first day of the range: `months` before today, or the first purchase. */
function rangeStart(range: PerformanceRange, today: string, firstPurchase: string) {
  return range === "ALL" ? firstPurchase : shiftMonths(today, -RANGE_MONTHS[range]);
}

/** What to fetch for a chart: the tickers and the first date needed, or null. */
export function planPerformance(
  lots: HoldingDto[],
  range: PerformanceRange,
  today: string,
): { tickers: string[]; start: string } | null {
  const dated = datedLots(lots);
  if (dated.length === 0) return null;
  const firstPurchase = dated.reduce(
    (min, lot) => (lot.purchaseDate < min ? lot.purchaseDate : min),
    dated[0]!.purchaseDate,
  );
  const start = rangeStart(range, today, firstPurchase);
  const from = start > firstPurchase ? start : firstPurchase;
  const tickers = [...new Set([...dated.map((lot) => lot.ticker), BENCHMARK_TICKER])];
  return { tickers, start: shiftDays(from, -LOOKBACK_DAYS) };
}

/** Each ticker's close on every timeline day, carried forward over gaps. */
function alignCloses(timeline: string[], points: PricePoint[]): (number | null)[] {
  const aligned: (number | null)[] = [];
  let next = 0;
  let last: number | null = null;
  for (const day of timeline) {
    while (next < points.length && points[next]!.date <= day) {
      last = points[next]!.close;
      next += 1;
    }
    aligned.push(last);
  }
  return aligned;
}

/** Evenly thin a series to `limit` points, keeping the first and last. */
export function downsample<T>(points: T[], limit = MAX_POINTS): T[] {
  if (points.length <= limit) return points;
  const step = (points.length - 1) / (limit - 1);
  return Array.from({ length: limit }, (_, i) => points[Math.round(i * step)]!);
}

function emptyResult(
  range: PerformanceRange,
  status: PortfolioPerformance["status"],
  lotsWithoutDate: number,
  excluded: PortfolioPerformance["excluded"] = [],
  benchmarkAvailable = false,
): PortfolioPerformance {
  return {
    range,
    status,
    benchmark: { ticker: BENCHMARK_TICKER, available: benchmarkAvailable },
    startDate: null,
    endDate: null,
    startClamped: false,
    portfolioReturnPercent: null,
    benchmarkReturnPercent: null,
    points: [],
    excluded,
    lotsWithoutDate,
  };
}

/**
 * Pure computation of the performance series from lots and daily closes.
 * Side-effect free so it can be unit-tested without any I/O.
 */
export function computePerformance(
  lots: HoldingDto[],
  range: PerformanceRange,
  today: string,
  closes: Pick<DailyCloses, "series">,
): PortfolioPerformance {
  const dated = datedLots(lots);
  const lotsWithoutDate = lots.length - dated.length;
  if (lots.length === 0) return emptyResult(range, "empty", 0);
  if (dated.length === 0) return emptyResult(range, "no_dates", lotsWithoutDate);

  const benchmarkSeries = closes.series[BENCHMARK_TICKER] ?? [];
  // The benchmark's trading days are the timeline (weekends and holidays have
  // no point); without it, every day any holding traded.
  const timeline =
    benchmarkSeries.length > 0
      ? benchmarkSeries.map((p) => p.date)
      : [
          ...new Set(Object.values(closes.series).flatMap((s) => s.map((p) => p.date))),
        ].sort();

  const excluded = new Map<string, PerformanceExclusionReason>();
  const aligned = new Map<string, (number | null)[]>();
  const entries: { lot: DatedLot; index: number }[] = [];
  for (const lot of dated) {
    const series = closes.series[lot.ticker];
    if (!series || series.length === 0) {
      excluded.set(lot.ticker, "no_history");
      continue;
    }
    let prices = aligned.get(lot.ticker);
    if (!prices) {
      prices = alignCloses(timeline, series);
      aligned.set(lot.ticker, prices);
    }
    // Joins at the first close on or after its purchase date.
    const index = timeline.findIndex(
      (day, i) => day >= lot.purchaseDate && prices[i] !== null,
    );
    if (index === -1) {
      if (!excluded.has(lot.ticker)) excluded.set(lot.ticker, "no_close_yet");
      continue;
    }
    entries.push({ lot, index });
  }
  // A ticker with any counted lot isn't reported as excluded.
  for (const { lot } of entries) excluded.delete(lot.ticker);
  const excludedList = [...excluded].map(([ticker, reason]) => ({ ticker, reason }));
  const benchmark = alignCloses(timeline, benchmarkSeries);
  const benchmarkAvailable = benchmarkSeries.length > 0;

  if (entries.length === 0) {
    return emptyResult(
      range,
      "no_data",
      lotsWithoutDate,
      excludedList,
      benchmarkAvailable,
    );
  }

  const firstPurchase = dated.reduce(
    (min, lot) => (lot.purchaseDate < min ? lot.purchaseDate : min),
    dated[0]!.purchaseDate,
  );
  const start = rangeStart(range, today, firstPurchase);
  // The close the range opens from: the last trading day on or before its start.
  let rangeAnchor = 0;
  for (let i = 0; i < timeline.length && timeline[i]! <= start; i += 1) rangeAnchor = i;
  const firstEntry = Math.min(...entries.map((e) => e.index));
  const anchor = Math.max(rangeAnchor, firstEntry);

  const valueAt = (i: number, joiningOnly: boolean): number =>
    entries.reduce((sum, { lot, index }) => {
      const counts = joiningOnly ? index === i : index <= i;
      return counts ? sum + lot.shares * aligned.get(lot.ticker)![i]! : sum;
    }, 0);

  const benchmarkBase = benchmark[anchor] ?? null;
  const benchmarkPercent = (i: number): number | null => {
    const close = benchmark[i];
    return benchmarkBase && close != null
      ? round2((close / benchmarkBase - 1) * 100)
      : null;
  };

  let growth = 1;
  let previousValue = valueAt(anchor, false);
  const points: PerformancePoint[] = [
    {
      date: timeline[anchor]!,
      portfolioPercent: 0,
      benchmarkPercent: benchmarkPercent(anchor),
      portfolioValue: round2(previousValue),
    },
  ];
  for (let i = anchor + 1; i < timeline.length; i += 1) {
    const value = valueAt(i, false);
    const inflow = valueAt(i, true);
    if (previousValue > 0) growth *= (value - inflow) / previousValue;
    previousValue = value;
    points.push({
      date: timeline[i]!,
      portfolioPercent: round2((growth - 1) * 100),
      benchmarkPercent: benchmarkPercent(i),
      portfolioValue: round2(value),
    });
  }

  const last = points.at(-1)!;
  return {
    range,
    status: "ok",
    benchmark: { ticker: BENCHMARK_TICKER, available: benchmarkAvailable },
    startDate: points[0]!.date,
    endDate: last.date,
    startClamped: range !== "ALL" && firstEntry > rangeAnchor,
    portfolioReturnPercent: last.portfolioPercent,
    benchmarkReturnPercent: last.benchmarkPercent,
    points: downsample(points),
    excluded: excludedList,
    lotsWithoutDate,
  };
}

/** Orchestrator: load the user's lots, fetch closes, and build the series. */
export async function getPortfolioPerformance(
  userId: string,
  range: PerformanceRange,
  now: Date = new Date(),
): Promise<PortfolioPerformance> {
  const lots = await listHoldings(userId);
  const today = newYorkDate(now);
  const plan = planPerformance(lots, range, today);
  const closes = plan ? await getDailyCloses(plan.tickers, plan.start) : { series: {} };
  return computePerformance(lots, range, today, closes);
}
