import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Prisma client singleton before importing the service under test.
vi.mock("../src/db/prisma.js", () => ({
  prisma: {
    holding: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

import { Prisma } from "@prisma/client";

import { prisma } from "../src/db/prisma.js";
import * as service from "../src/services/holdings.service.js";
import { NotFoundError } from "../src/errors.js";

const mockPrisma = vi.mocked(prisma, true);

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-1111-1111-111111111111",
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe("holdings.service", () => {
  it("maps Decimal columns to numbers and dates to ISO strings", async () => {
    mockPrisma.holding.findMany.mockResolvedValue([makeRow()]);

    const [holding] = await service.listHoldings();

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

    const [holding] = await service.listHoldings();

    expect(holding?.purchaseDate).toBe("2026-01-15");
  });

  it("persists a purchase date as a UTC Date on create", async () => {
    mockPrisma.holding.create.mockResolvedValue(makeRow());

    await service.createHolding({
      ticker: "AAPL",
      shares: 10,
      buyPrice: 150.25,
      purchaseDate: "2026-01-15",
    });

    const data = mockPrisma.holding.create.mock.calls[0]![0].data;
    expect(data.purchaseDate).toEqual(new Date("2026-01-15T00:00:00.000Z"));
  });

  it("throws NotFoundError when getHolding finds nothing", async () => {
    mockPrisma.holding.findUnique.mockResolvedValue(null);

    await expect(service.getHolding("missing")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("creates a holding with Decimal values", async () => {
    mockPrisma.holding.create.mockResolvedValue(makeRow());

    const result = await service.createHolding({
      ticker: "AAPL",
      shares: 10,
      buyPrice: 150.25,
    });

    expect(mockPrisma.holding.create).toHaveBeenCalledWith({
      data: {
        ticker: "AAPL",
        shares: expect.any(Prisma.Decimal),
        buyPrice: expect.any(Prisma.Decimal),
        purchaseDate: null,
      },
    });
    expect(result.shares).toBe(10);
  });

  it("maps Prisma P2025 to NotFoundError on update", async () => {
    mockPrisma.holding.update.mockRejectedValue(notFoundError());

    await expect(
      service.updateHolding("missing", { shares: 5 }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("maps Prisma P2025 to NotFoundError on delete", async () => {
    mockPrisma.holding.delete.mockRejectedValue(notFoundError());

    await expect(service.deleteHolding("missing")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
