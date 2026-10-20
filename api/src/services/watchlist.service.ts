/**
 * Watchlist storage: companies a user is considering (not owned). Every query
 * is scoped to the user. A watchlist never touches holdings, so it can't
 * affect portfolio totals, performance or sectors.
 *
 * Rules: one row per user and ticker (unique), at most WATCHLIST_MAX_ITEMS
 * per user (checked under a per-user advisory lock, so concurrent adds can't
 * both slip under it), and the price when added is kept for "change since
 * added" (filled later when no quote was available at the time).
 */
import { Prisma, type WatchlistItem } from "@prisma/client";

import { config } from "../config.js";
import { prisma } from "../db/prisma.js";
import {
  AlreadyWatchingError,
  InvalidTickerError,
  NotFoundError,
  WatchlistLimitError,
} from "../errors.js";
import type { WatchlistAddedDto } from "../types.js";
import { ensureDemoHoldings } from "./holdings.service.js";
import { getBatchQuotes } from "./quotes.service.js";
import { symbolNames } from "./symbols.service.js";

/** The sample watchlist demo users start with (both are demo report tickers). */
export const DEMO_WATCHLIST = ["AMD", "JPM"] as const;

/** Prisma's "unique constraint failed" error code. */
const UNIQUE_VIOLATION = "P2002";

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === UNIQUE_VIOLATION
  );
}

export async function listWatchlistItems(userId: string): Promise<WatchlistItem[]> {
  return prisma.watchlistItem.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Throw if adding `ticker` would be refused, without the lock. Lets the
 * caller skip the quote lookup for a duplicate or a full list; addItem
 * checks again under the lock.
 */
export async function assertCanAdd(userId: string, ticker: string): Promise<void> {
  const [existing, count] = await Promise.all([
    prisma.watchlistItem.findUnique({
      where: { userId_ticker: { userId, ticker } },
      select: { id: true },
    }),
    prisma.watchlistItem.count({ where: { userId } }),
  ]);
  if (existing) throw new AlreadyWatchingError(ticker);
  if (count >= config.watchlist.maxItems) {
    throw new WatchlistLimitError(config.watchlist.maxItems);
  }
}

/** Add a ticker (with its current price, if known) to the user's watchlist. */
export async function addItem(
  userId: string,
  ticker: string,
  price: number | null,
  now: Date = new Date(),
): Promise<WatchlistItem> {
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`watchlist:${userId}`}))`;
      const count = await tx.watchlistItem.count({ where: { userId } });
      if (count >= config.watchlist.maxItems) {
        throw new WatchlistLimitError(config.watchlist.maxItems);
      }
      return tx.watchlistItem.create({
        data: {
          userId,
          ticker,
          addedPrice: price === null ? null : new Prisma.Decimal(price),
          addedPriceAt: price === null ? null : now,
        },
      });
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new AlreadyWatchingError(ticker);
    throw error;
  }
}

/**
 * Validate and add a ticker. A ticker in the symbol list is accepted without
 * asking anyone; otherwise (the list isn't loaded yet, or an unusual symbol)
 * the quote decides, and only a confirmed unknown is rejected, like adding a
 * holding. The same one batch quote (at most one Finnhub call) gives the
 * price when added.
 */
export async function watchTicker(
  userId: string,
  ticker: string,
): Promise<WatchlistAddedDto> {
  await assertCanAdd(userId, ticker);
  const [names, quotes] = await Promise.all([
    symbolNames([ticker]),
    getBatchQuotes([ticker]),
  ]);
  if (!names.has(ticker) && quotes.errors[ticker] === "not_found") {
    throw new InvalidTickerError(`'${ticker}' is not a recognized ticker symbol.`);
  }
  const item = await addItem(userId, ticker, quotes.quotes[ticker]?.price ?? null);
  return {
    ticker: item.ticker,
    name: names.get(ticker) ?? null,
    addedPrice: item.addedPrice?.toNumber() ?? null,
    addedPriceAt: item.addedPriceAt?.toISOString() ?? null,
    addedAt: item.createdAt.toISOString(),
  };
}

/** Remove a ticker from the user's watchlist (404 if it isn't on it). */
export async function removeItem(userId: string, ticker: string): Promise<void> {
  const { count } = await prisma.watchlistItem.deleteMany({
    where: { userId, ticker },
  });
  if (count === 0) {
    throw new NotFoundError(`${ticker} is not on your watchlist`);
  }
}

/**
 * Record the price for items added while no quote was available, once (rows
 * that already have one are left alone, even by a concurrent load).
 */
export async function fillAddedPrices(
  userId: string,
  prices: Map<string, number>,
  now: Date = new Date(),
): Promise<void> {
  await Promise.all(
    [...prices].map(([ticker, price]) =>
      prisma.watchlistItem.updateMany({
        where: { userId, ticker, addedPrice: null },
        data: { addedPrice: new Prisma.Decimal(price), addedPriceAt: now },
      }),
    ),
  );
}

/**
 * Seed the sample watchlist for a demo user, exactly once.
 *
 * Gated by DemoSeed.watchlistSeededAt, so removing both companies doesn't
 * bring them back, and demo users seeded before the watchlist existed get it
 * on their next load. Claiming the marker (an UPDATE ... WHERE null) locks
 * the row, so of two concurrent loads only one seeds. Prices start empty and
 * are filled by the first priced load.
 */
export async function ensureDemoWatchlist(userId: string): Promise<void> {
  await ensureDemoHoldings(userId); // creates the DemoSeed marker if missing
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.demoSeed.updateMany({
      where: { userId, watchlistSeededAt: null },
      data: { watchlistSeededAt: new Date() },
    });
    if (claimed.count === 0) return;
    await tx.watchlistItem.createMany({
      data: DEMO_WATCHLIST.map((ticker) => ({ userId, ticker })),
      skipDuplicates: true,
    });
  });
}
