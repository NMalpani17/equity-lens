/**
 * Watchlist limits and seeding against a real Postgres (see
 * vitest.integration.config.ts): the advisory lock, the unique index and the
 * demo seed marker only prove themselves under real concurrency.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = Boolean(process.env.API_TEST_DATABASE_URL);

describe.skipIf(!enabled)("watchlist on real Postgres", () => {
  let prisma: typeof import("../../src/db/prisma.js").prisma;
  let watchlist: typeof import("../../src/services/watchlist.service.js");
  let errors: typeof import("../../src/errors.js");

  beforeAll(async () => {
    ({ prisma } = await import("../../src/db/prisma.js"));
    watchlist = await import("../../src/services/watchlist.service.js");
    errors = await import("../../src/errors.js");
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  const tickers = async (userId: string) =>
    (await watchlist.listWatchlistItems(userId)).map((item) => item.ticker);

  it("never passes 50 companies, even when adds race", async () => {
    const user = randomUUID();
    const symbols = Array.from({ length: 60 }, (_, i) => `W${i}`);

    const outcomes = await Promise.allSettled(
      symbols.map((ticker) => watchlist.addItem(user, ticker, 10)),
    );

    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(50);
    const refused = outcomes.filter((o) => o.status === "rejected");
    expect(refused).toHaveLength(10);
    for (const outcome of refused) {
      expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(
        errors.WatchlistLimitError,
      );
    }
    expect(await prisma.watchlistItem.count({ where: { userId: user } })).toBe(50);
  });

  it("keeps one row per user and ticker", async () => {
    const user = randomUUID();

    const outcomes = await Promise.allSettled(
      Array.from({ length: 5 }, () => watchlist.addItem(user, "AMD", 150)),
    );

    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    for (const outcome of outcomes.filter((o) => o.status === "rejected")) {
      expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(
        errors.AlreadyWatchingError,
      );
    }
    // Another user may watch the same ticker.
    await watchlist.addItem(randomUUID(), "AMD", 150);
    expect(await tickers(user)).toEqual(["AMD"]);
  });

  it("seeds the demo watchlist exactly once", async () => {
    const user = randomUUID();

    await Promise.all(
      Array.from({ length: 4 }, () => watchlist.ensureDemoWatchlist(user)),
    );
    expect((await tickers(user)).sort()).toEqual(["AMD", "JPM"]);

    await watchlist.removeItem(user, "AMD");
    await watchlist.removeItem(user, "JPM");
    await watchlist.ensureDemoWatchlist(user);
    expect(await tickers(user)).toEqual([]);
  });

  it("seeds a demo user from before the watchlist existed", async () => {
    const user = randomUUID();
    await prisma.demoSeed.create({ data: { userId: user } }); // holdings seeded long ago

    await watchlist.ensureDemoWatchlist(user);

    expect((await tickers(user)).sort()).toEqual(["AMD", "JPM"]);
    expect(await prisma.holding.count({ where: { userId: user } })).toBe(0);
  });

  it("fills a missing price once and never overwrites one", async () => {
    const user = randomUUID();
    await watchlist.addItem(user, "AMD", null);
    await watchlist.addItem(user, "JPM", 300);

    await watchlist.fillAddedPrices(
      user,
      new Map([
        ["AMD", 150],
        ["JPM", 310],
      ]),
    );
    await watchlist.fillAddedPrices(user, new Map([["AMD", 999]]));

    const items = await watchlist.listWatchlistItems(user);
    const price = (t: string) =>
      items.find((i) => i.ticker === t)?.addedPrice?.toNumber();
    expect(price("AMD")).toBe(150);
    expect(price("JPM")).toBe(300);
  });

  it("never touches the portfolio", async () => {
    const { Prisma } = await import("@prisma/client");
    const { getPortfolioSummary } =
      await import("../../src/services/portfolio.service.js");
    const holdings = await import("../../src/services/holdings.service.js");
    const user = randomUUID();
    await prisma.holding.create({
      data: {
        userId: user,
        ticker: "AAPL",
        shares: new Prisma.Decimal(10),
        buyPrice: new Prisma.Decimal(100),
      },
    });
    await watchlist.addItem(user, "AMD", 150);
    await watchlist.addItem(user, "AAPL", 230); // watched and held

    // No ai-service here, so prices are unavailable; positions and cost are not.
    const summary = await getPortfolioSummary(user);

    expect(summary.positions.map((p) => p.ticker)).toEqual(["AAPL"]);
    expect(summary.positions[0]!.totalShares).toBe(10);
    expect(summary.positions[0]!.costBasis).toBe(1000);
    // Totals cover one position (unpriced here), never a watched ticker.
    expect(summary.totals.pricedCount + summary.totals.unpricedCount).toBe(1);
    expect(await holdings.listHeldTickers(user)).toEqual(["AAPL"]);
    expect(await prisma.holding.count({ where: { userId: user } })).toBe(1);
  });

  it("removes only the owner's row", async () => {
    const owner = randomUUID();
    await watchlist.addItem(owner, "AMD", 150);

    await expect(watchlist.removeItem(randomUUID(), "AMD")).rejects.toBeInstanceOf(
      errors.NotFoundError,
    );
    expect(await tickers(owner)).toEqual(["AMD"]);
  });
});
