import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/db/prisma.js", () => ({
  prisma: {
    watchlistItem: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      createMany: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    demoSeed: { updateMany: vi.fn() },
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
  },
}));
vi.mock("../src/services/quotes.service.js", () => ({ getBatchQuotes: vi.fn() }));
vi.mock("../src/services/symbols.service.js", () => ({ symbolNames: vi.fn() }));
vi.mock("../src/services/holdings.service.js", () => ({ ensureDemoHoldings: vi.fn() }));

import { prisma } from "../src/db/prisma.js";
import {
  AlreadyWatchingError,
  InvalidTickerError,
  NotFoundError,
  WatchlistLimitError,
} from "../src/errors.js";
import { ensureDemoHoldings } from "../src/services/holdings.service.js";
import { getBatchQuotes } from "../src/services/quotes.service.js";
import { symbolNames } from "../src/services/symbols.service.js";
import * as watchlist from "../src/services/watchlist.service.js";

const mockPrisma = vi.mocked(prisma, true);
const quotesMock = vi.mocked(getBatchQuotes);
const namesMock = vi.mocked(symbolNames);
const USER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const NOW = new Date("2026-10-19T15:00:00.000Z");

function itemRow(ticker: string, price: number | null = null) {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    userId: USER_ID,
    ticker,
    addedPrice: price === null ? null : new Prisma.Decimal(price),
    addedPriceAt: price === null ? null : NOW,
    createdAt: NOW,
  };
}

function quoteFor(ticker: string, price: number) {
  return {
    ticker,
    price,
    previousClose: price - 1,
    change: 1,
    changePercent: 1,
    currency: "USD",
    name: null,
    provider: "finnhub",
    asOf: NOW.toISOString(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Interactive transactions run their callback against the same mock client.
  mockPrisma.$transaction.mockImplementation(((fn: (tx: unknown) => unknown) =>
    fn(prisma)) as never);
  mockPrisma.watchlistItem.findUnique.mockResolvedValue(null);
  mockPrisma.watchlistItem.count.mockResolvedValue(0);
  mockPrisma.watchlistItem.create.mockImplementation((({ data }: { data: never }) =>
    Promise.resolve({ ...itemRow("X"), ...(data as object) })) as never);
});

describe("assertCanAdd", () => {
  it("refuses a ticker already on the list", async () => {
    mockPrisma.watchlistItem.findUnique.mockResolvedValue({ id: "x" } as never);

    await expect(watchlist.assertCanAdd(USER_ID, "AMD")).rejects.toBeInstanceOf(
      AlreadyWatchingError,
    );
  });

  it("refuses the 51st company and allows the 50th", async () => {
    mockPrisma.watchlistItem.count.mockResolvedValue(50);
    await expect(watchlist.assertCanAdd(USER_ID, "AMD")).rejects.toBeInstanceOf(
      WatchlistLimitError,
    );

    mockPrisma.watchlistItem.count.mockResolvedValue(49);
    await expect(watchlist.assertCanAdd(USER_ID, "AMD")).resolves.toBeUndefined();
  });
});

describe("addItem", () => {
  it("re-checks the limit under the per-user lock", async () => {
    mockPrisma.watchlistItem.count.mockResolvedValue(50);

    await expect(watchlist.addItem(USER_ID, "AMD", 150)).rejects.toBeInstanceOf(
      WatchlistLimitError,
    );
    expect(mockPrisma.$executeRaw).toHaveBeenCalledOnce();
    expect(mockPrisma.watchlistItem.create).not.toHaveBeenCalled();
  });

  it("stores the price when added", async () => {
    await watchlist.addItem(USER_ID, "AMD", 153.25, NOW);

    const { data } = mockPrisma.watchlistItem.create.mock.calls[0]![0];
    expect(data.userId).toBe(USER_ID);
    expect(data.ticker).toBe("AMD");
    expect(String(data.addedPrice)).toBe("153.25");
    expect(data.addedPriceAt).toEqual(NOW);
  });

  it("stores no price when no quote was available", async () => {
    await watchlist.addItem(USER_ID, "AMD", null);

    const { data } = mockPrisma.watchlistItem.create.mock.calls[0]![0];
    expect(data.addedPrice).toBeNull();
    expect(data.addedPriceAt).toBeNull();
  });

  it("turns a unique violation (a concurrent add) into already watching", async () => {
    mockPrisma.watchlistItem.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dup", {
        code: "P2002",
        clientVersion: "test",
      }),
    );

    await expect(watchlist.addItem(USER_ID, "AMD", 1)).rejects.toBeInstanceOf(
      AlreadyWatchingError,
    );
  });
});

describe("watchTicker", () => {
  it("adds a listed ticker with its name and current price", async () => {
    namesMock.mockResolvedValue(new Map([["AMD", "Advanced Micro Devices"]]));
    quotesMock.mockResolvedValue({ quotes: { AMD: quoteFor("AMD", 153) }, errors: {} });

    const added = await watchlist.watchTicker(USER_ID, "AMD");

    expect(quotesMock).toHaveBeenCalledWith(["AMD"]);
    expect(added).toMatchObject({
      ticker: "AMD",
      name: "Advanced Micro Devices",
      addedPrice: 153,
    });
  });

  it("rejects a ticker that is unlisted and unknown to every provider", async () => {
    namesMock.mockResolvedValue(new Map());
    quotesMock.mockResolvedValue({ quotes: {}, errors: { ZZZZ: "not_found" } });

    await expect(watchlist.watchTicker(USER_ID, "ZZZZ")).rejects.toBeInstanceOf(
      InvalidTickerError,
    );
    expect(mockPrisma.watchlistItem.create).not.toHaveBeenCalled();
  });

  it("lets an unlisted ticker through while prices are unavailable", async () => {
    namesMock.mockResolvedValue(new Map());
    quotesMock.mockResolvedValue({ quotes: {}, errors: { NEWCO: "unavailable" } });

    const added = await watchlist.watchTicker(USER_ID, "NEWCO");

    expect(added).toMatchObject({ ticker: "NEWCO", name: null, addedPrice: null });
  });

  it("keeps a listed ticker even if the quote says not found", async () => {
    namesMock.mockResolvedValue(new Map([["AMD", "Advanced Micro Devices"]]));
    quotesMock.mockResolvedValue({ quotes: {}, errors: { AMD: "not_found" } });

    await expect(watchlist.watchTicker(USER_ID, "AMD")).resolves.toMatchObject({
      ticker: "AMD",
    });
  });

  it("checks the limit before spending a quote", async () => {
    mockPrisma.watchlistItem.count.mockResolvedValue(50);

    await expect(watchlist.watchTicker(USER_ID, "AMD")).rejects.toBeInstanceOf(
      WatchlistLimitError,
    );
    expect(quotesMock).not.toHaveBeenCalled();
  });
});

describe("removeItem", () => {
  it("deletes only the user's own row", async () => {
    mockPrisma.watchlistItem.deleteMany.mockResolvedValue({ count: 1 });

    await watchlist.removeItem(USER_ID, "AMD");

    expect(mockPrisma.watchlistItem.deleteMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, ticker: "AMD" },
    });
  });

  it("is a 404 when the ticker isn't on the list", async () => {
    mockPrisma.watchlistItem.deleteMany.mockResolvedValue({ count: 0 });

    await expect(watchlist.removeItem(USER_ID, "AMD")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe("fillAddedPrices", () => {
  it("only fills rows that have no price yet", async () => {
    mockPrisma.watchlistItem.updateMany.mockResolvedValue({ count: 1 });

    await watchlist.fillAddedPrices(USER_ID, new Map([["AMD", 150]]), NOW);

    const call = mockPrisma.watchlistItem.updateMany.mock.calls[0]![0];
    expect(call.where).toEqual({ userId: USER_ID, ticker: "AMD", addedPrice: null });
    expect(String(call.data.addedPrice)).toBe("150");
    expect(call.data.addedPriceAt).toEqual(NOW);
  });
});

describe("ensureDemoWatchlist", () => {
  it("seeds AMD and JPM when it claims the marker", async () => {
    mockPrisma.demoSeed.updateMany.mockResolvedValue({ count: 1 });

    await watchlist.ensureDemoWatchlist(USER_ID);

    expect(ensureDemoHoldings).toHaveBeenCalledWith(USER_ID);
    expect(mockPrisma.demoSeed.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER_ID, watchlistSeededAt: null } }),
    );
    expect(mockPrisma.watchlistItem.createMany).toHaveBeenCalledWith({
      data: [
        { userId: USER_ID, ticker: "AMD" },
        { userId: USER_ID, ticker: "JPM" },
      ],
      skipDuplicates: true,
    });
  });

  it("never seeds twice", async () => {
    mockPrisma.demoSeed.updateMany.mockResolvedValue({ count: 0 });

    await watchlist.ensureDemoWatchlist(USER_ID);

    expect(mockPrisma.watchlistItem.createMany).not.toHaveBeenCalled();
  });
});
