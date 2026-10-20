/**
 * The watchlist as the Watchlist page shows it: each company with its live
 * price, today's change, change since added, next earnings date and report
 * status. Reads only; holdings are consulted (for "In portfolio") but never
 * changed, so watching a stock can't move portfolio totals.
 *
 * Finnhub cost per load: quotes come from the ai-service's batch path (at
 * most 15 Finnhub calls for a cold 50-ticker list, none when cached); names,
 * earnings dates and report status are database reads.
 */
import type { WatchlistItem } from "@prisma/client";

import { config } from "../config.js";
import { getUpcomingEarnings } from "./earnings.service.js";
import { listHeldTickers } from "./holdings.service.js";
import { getBatchQuotes, type Quote, type QuotesResult } from "./quotes.service.js";
import { reportStatuses } from "./reports.service.js";
import { symbolNames } from "./symbols.service.js";
import { fillAddedPrices, listWatchlistItems } from "./watchlist.service.js";
import type {
  NextEarningsDto,
  PriceStatus,
  WatchlistDto,
  WatchlistRowDto,
} from "../types.js";

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function priceStatus(ticker: string, quotes: QuotesResult): PriceStatus {
  if (quotes.quotes[ticker]) return "ok";
  return quotes.errors[ticker] === "not_found" ? "not_found" : "unavailable";
}

interface RowInputs {
  name: string | null;
  quote: Quote | undefined;
  status: PriceStatus;
  addedPrice: number | null;
  addedPriceAt: Date | null;
  nextEarnings: NextEarningsDto | null;
  report: WatchlistRowDto["report"];
  inPortfolio: boolean;
}

export function buildRow(item: WatchlistItem, inputs: RowInputs): WatchlistRowDto {
  const { quote, addedPrice } = inputs;
  const sinceAdded =
    quote && addedPrice !== null && addedPrice > 0 ? quote.price - addedPrice : null;
  return {
    ticker: item.ticker,
    name: inputs.name,
    price: quote?.price ?? null,
    change: quote ? round2(quote.change) : null,
    changePercent: quote ? round2(quote.changePercent) : null,
    priceStatus: inputs.status,
    addedAt: item.createdAt.toISOString(),
    addedPrice,
    addedPriceAt: inputs.addedPriceAt?.toISOString() ?? null,
    changeSinceAdded: sinceAdded === null ? null : round2(sinceAdded),
    changeSinceAddedPercent:
      sinceAdded === null || addedPrice === null
        ? null
        : round2((sinceAdded / addedPrice) * 100),
    nextEarnings: inputs.nextEarnings,
    report: inputs.report,
    inPortfolio: inputs.inPortfolio,
  };
}

export async function getWatchlist(
  userId: string,
  isAnonymous: boolean,
  now: Date = new Date(),
): Promise<WatchlistDto> {
  const items = await listWatchlistItems(userId);
  const tickers = items.map((item) => item.ticker);
  const [names, quotes, earnings, reports, held] = await Promise.all([
    symbolNames(tickers),
    getBatchQuotes(tickers),
    getUpcomingEarnings(tickers),
    reportStatuses(tickers, isAnonymous),
    listHeldTickers(userId),
  ]);

  // Items added while no quote was available get today's price, once.
  const toFill = new Map(
    items
      .filter((item) => item.addedPrice === null && quotes.quotes[item.ticker])
      .map((item) => [item.ticker, quotes.quotes[item.ticker]!.price]),
  );
  if (toFill.size > 0) await fillAddedPrices(userId, toFill, now);

  const heldSet = new Set(held);
  const nextByTicker = new Map(earnings.earnings.map((event) => [event.ticker, event]));
  const rows = items.map((item) => {
    const filled = toFill.get(item.ticker);
    const event = nextByTicker.get(item.ticker);
    return buildRow(item, {
      name: names.get(item.ticker) ?? null,
      quote: quotes.quotes[item.ticker],
      status: priceStatus(item.ticker, quotes),
      addedPrice: filled ?? item.addedPrice?.toNumber() ?? null,
      addedPriceAt: filled !== undefined ? now : item.addedPriceAt,
      nextEarnings: event
        ? { date: event.date, hour: event.hour, epsEstimate: event.epsEstimate }
        : null,
      report: reports.get(item.ticker) ?? { status: "none", demoLocked: false },
      inPortfolio: heldSet.has(item.ticker),
    });
  });
  return { items: rows, limit: config.watchlist.maxItems };
}
