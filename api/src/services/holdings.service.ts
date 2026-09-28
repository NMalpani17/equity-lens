/**
 * Holdings business logic. Owns all database access for holdings and maps
 * Prisma rows (with Decimal columns) to plain JSON-friendly DTOs.
 */
import { Prisma, type Holding } from "@prisma/client";

import { prisma } from "../db/prisma.js";
import { NotFoundError } from "../errors.js";
import type { HoldingDto } from "../types.js";
import type {
  CreateHoldingInput,
  UpdateHoldingInput,
} from "../schemas/holding.schema.js";

/** Prisma's "record not found" error code (thrown by update/delete). */
const RECORD_NOT_FOUND = "P2025";

/** Serialize a nullable purchase date to a YYYY-MM-DD string (or null). */
function toDateString(date: Date | null): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}

function toDto(holding: Holding): HoldingDto {
  return {
    id: holding.id,
    ticker: holding.ticker,
    shares: holding.shares.toNumber(),
    buyPrice: holding.buyPrice.toNumber(),
    purchaseDate: toDateString(holding.purchaseDate),
    createdAt: holding.createdAt.toISOString(),
    updatedAt: holding.updatedAt.toISOString(),
  };
}

/** Parse a YYYY-MM-DD string into a UTC Date, or null when absent. */
function toPurchaseDate(value: string | null | undefined): Date | null {
  return value ? new Date(`${value}T00:00:00.000Z`) : null;
}

function isRecordNotFound(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === RECORD_NOT_FOUND
  );
}

export async function listHoldings(): Promise<HoldingDto[]> {
  const holdings = await prisma.holding.findMany({
    orderBy: { createdAt: "asc" },
  });
  return holdings.map(toDto);
}

export async function getHolding(id: string): Promise<HoldingDto> {
  const holding = await prisma.holding.findUnique({ where: { id } });
  if (!holding) {
    throw new NotFoundError(`holding ${id} not found`);
  }
  return toDto(holding);
}

export async function createHolding(input: CreateHoldingInput): Promise<HoldingDto> {
  const holding = await prisma.holding.create({
    data: {
      ticker: input.ticker,
      shares: new Prisma.Decimal(input.shares),
      buyPrice: new Prisma.Decimal(input.buyPrice),
      purchaseDate: toPurchaseDate(input.purchaseDate),
    },
  });
  return toDto(holding);
}

export async function updateHolding(
  id: string,
  input: UpdateHoldingInput,
): Promise<HoldingDto> {
  try {
    const holding = await prisma.holding.update({
      where: { id },
      data: {
        ...(input.ticker !== undefined && { ticker: input.ticker }),
        ...(input.shares !== undefined && {
          shares: new Prisma.Decimal(input.shares),
        }),
        ...(input.buyPrice !== undefined && {
          buyPrice: new Prisma.Decimal(input.buyPrice),
        }),
        ...(input.purchaseDate !== undefined && {
          purchaseDate: toPurchaseDate(input.purchaseDate),
        }),
      },
    });
    return toDto(holding);
  } catch (error) {
    if (isRecordNotFound(error)) {
      throw new NotFoundError(`holding ${id} not found`);
    }
    throw error;
  }
}

export async function deleteHolding(id: string): Promise<void> {
  try {
    await prisma.holding.delete({ where: { id } });
  } catch (error) {
    if (isRecordNotFound(error)) {
      throw new NotFoundError(`holding ${id} not found`);
    }
    throw error;
  }
}

/** Delete every lot for a ticker; returns how many rows were removed. */
export async function deleteHoldingsByTicker(ticker: string): Promise<number> {
  const { count } = await prisma.holding.deleteMany({ where: { ticker } });
  return count;
}
