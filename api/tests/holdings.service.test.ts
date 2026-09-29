import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Prisma client singleton before importing the service under test.
vi.mock("../src/db/prisma.js", () => ({
  prisma: {
    holding: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      createMany: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    demoSeed: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

import { Prisma } from "@prisma/client";

import { prisma } from "../src/db/prisma.js";
import * as service from "../src/services/holdings.service.js";
import { NotFoundError } from "../src/errors.js";

const mockPrisma = vi.mocked(prisma, true);

const USER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    userId: USER_ID,
    ticker: "AAPL",
    shares: new Prisma.Decimal(10),
    buyPrice: new Prisma.Decimal(150.25),
    purchaseDate: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    ...overrides,
  };
}

function notFoundError() {
  return new Prisma.PrismaClientKnownRequestError("not found", {
    code: "P2025",
    clientVersion: "test",
  });
}

function uniqueViolationError() {
  return new Prisma.PrismaClientKnownRequestError("unique violation", {
    code: "P2002",
    clientVersion: "test",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Run the interactive-transaction callback against the same mock client.
  // Cast around Prisma's overloaded $transaction signature.
  mockPrisma.$transaction.mockImplementation(((fn: (tx: unknown) => unknown) =>
    fn(mockPrisma)) as never);
});

describe("holdings.service", () => {
  it("scopes listHoldings to the user and maps rows to DTOs", async () => {
    mockPrisma.holding.findMany.mockResolvedValue([makeRow()]);

    const [holding] = await service.listHoldings(USER_ID);

    expect(mockPrisma.holding.findMany).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      orderBy: { createdAt: "asc" },
    });
    // The user id is internal and not exposed in the DTO.
    expect(holding).toEqual({
      id: "11111111-1111-1111-1111-111111111111",
      ticker: "AAPL",
      shares: 10,
      buyPrice: 150.25,
      purchaseDate: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
  });

  it("serializes a purchase date to a YYYY-MM-DD string", async () => {
    mockPrisma.holding.findMany.mockResolvedValue([
      makeRow({ purchaseDate: new Date("2026-01-15T00:00:00.000Z") }),
    ]);

    const [holding] = await service.listHoldings(USER_ID);

    expect(holding?.purchaseDate).toBe("2026-01-15");
  });

  it("scopes getHolding to the user with findFirst", async () => {
    mockPrisma.holding.findFirst.mockResolvedValue(makeRow());

    const holding = await service.getHolding(makeRow().id, USER_ID);

    expect(mockPrisma.holding.findFirst).toHaveBeenCalledWith({
      where: { id: makeRow().id, userId: USER_ID },
    });
    expect(holding.ticker).toBe("AAPL");
  });

  it("throws NotFoundError when getHolding finds nothing", async () => {
    mockPrisma.holding.findFirst.mockResolvedValue(null);

    await expect(service.getHolding("missing", USER_ID)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("does not return another user's holding (scoped query yields 404)", async () => {
    // A holding owned by someone else is invisible to this user: findFirst,
    // filtered by userId, returns null.
    mockPrisma.holding.findFirst.mockResolvedValue(null);

    await expect(
      service.getHolding("someone-elses-id", USER_ID),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("persists a purchase date as a UTC Date on create", async () => {
    mockPrisma.holding.create.mockResolvedValue(makeRow());

    await service.createHolding(
      { ticker: "AAPL", shares: 10, buyPrice: 150.25, purchaseDate: "2026-01-15" },
      USER_ID,
    );

    const data = mockPrisma.holding.create.mock.calls[0]![0].data;
    expect(data.purchaseDate).toEqual(new Date("2026-01-15T00:00:00.000Z"));
  });

  it("creates a holding owned by the user with Decimal values", async () => {
    mockPrisma.holding.create.mockResolvedValue(makeRow());

    const result = await service.createHolding(
      { ticker: "AAPL", shares: 10, buyPrice: 150.25 },
      USER_ID,
    );

    expect(mockPrisma.holding.create).toHaveBeenCalledWith({
      data: {
        userId: USER_ID,
        ticker: "AAPL",
        shares: expect.any(Prisma.Decimal),
        buyPrice: expect.any(Prisma.Decimal),
        purchaseDate: null,
      },
    });
    expect(result.shares).toBe(10);
  });

  it("updates a holding after confirming ownership", async () => {
    mockPrisma.holding.findFirst.mockResolvedValue(makeRow());
    mockPrisma.holding.update.mockResolvedValue(
      makeRow({ shares: new Prisma.Decimal(5) }),
    );

    const result = await service.updateHolding(makeRow().id, { shares: 5 }, USER_ID);

    expect(mockPrisma.holding.findFirst).toHaveBeenCalledWith({
      where: { id: makeRow().id, userId: USER_ID },
    });
    expect(result.shares).toBe(5);
  });

  it("refuses to update another user's holding and never touches it", async () => {
    mockPrisma.holding.findFirst.mockResolvedValue(null); // not owned by USER_ID

    await expect(
      service.updateHolding("someone-elses-id", { shares: 5 }, USER_ID),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(mockPrisma.holding.update).not.toHaveBeenCalled();
  });

  it("maps Prisma P2025 to NotFoundError on update", async () => {
    mockPrisma.holding.findFirst.mockResolvedValue(makeRow());
    mockPrisma.holding.update.mockRejectedValue(notFoundError());

    await expect(
      service.updateHolding(makeRow().id, { shares: 5 }, USER_ID),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("deletes a holding scoped to its owner", async () => {
    mockPrisma.holding.deleteMany.mockResolvedValue({ count: 1 });

    await service.deleteHolding(makeRow().id, USER_ID);

    expect(mockPrisma.holding.deleteMany).toHaveBeenCalledWith({
      where: { id: makeRow().id, userId: USER_ID },
    });
  });

  it("throws NotFoundError when deleting a holding the user does not own", async () => {
    mockPrisma.holding.deleteMany.mockResolvedValue({ count: 0 });

    await expect(
      service.deleteHolding("someone-elses-id", USER_ID),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("deletes all lots for a ticker owned by the user and returns the count", async () => {
    mockPrisma.holding.deleteMany.mockResolvedValue({ count: 3 });

    const count = await service.deleteHoldingsByTicker("AAPL", USER_ID);

    expect(count).toBe(3);
    expect(mockPrisma.holding.deleteMany).toHaveBeenCalledWith({
      where: { ticker: "AAPL", userId: USER_ID },
    });
  });

  describe("ensureDemoHoldings", () => {
    it("seeds holdings and records a DemoSeed marker on first run", async () => {
      mockPrisma.demoSeed.findUnique.mockResolvedValue(null); // never seeded

      await service.ensureDemoHoldings(USER_ID);

      expect(mockPrisma.demoSeed.findUnique).toHaveBeenCalledWith({
        where: { userId: USER_ID },
      });
      expect(mockPrisma.demoSeed.create).toHaveBeenCalledWith({
        data: { userId: USER_ID },
      });
      expect(mockPrisma.holding.createMany).toHaveBeenCalledOnce();
      const arg = mockPrisma.holding.createMany.mock.calls[0]![0]!;
      const rows = arg.data as Array<{ userId: string }>;
      expect(rows.length).toBeGreaterThan(0);
      // Every seeded row is owned by the user.
      for (const row of rows) {
        expect(row.userId).toBe(USER_ID);
      }
    });

    it("does not re-seed once the user has a DemoSeed marker", async () => {
      // Regression: a demo user who deleted every holding must stay empty. The
      // marker persists even with zero holdings, so no re-seed happens.
      mockPrisma.demoSeed.findUnique.mockResolvedValue({
        userId: USER_ID,
        seededAt: new Date("2026-01-01T00:00:00.000Z"),
      });

      await service.ensureDemoHoldings(USER_ID);

      expect(mockPrisma.demoSeed.create).not.toHaveBeenCalled();
      expect(mockPrisma.holding.createMany).not.toHaveBeenCalled();
    });

    it("swallows a concurrent seed's unique-violation without re-seeding", async () => {
      // Two requests race: this one loses the marker's primary key.
      mockPrisma.demoSeed.findUnique.mockResolvedValue(null);
      mockPrisma.$transaction.mockRejectedValue(uniqueViolationError());

      await expect(service.ensureDemoHoldings(USER_ID)).resolves.toBeUndefined();
    });
  });
});
