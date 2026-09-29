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

/**
 * Confirm a holding exists and belongs to the user. Throws NotFoundError
 * otherwise, so accessing another user's holding is indistinguishable from a
 * missing one (no information leak about other users' data).
 */
async function assertOwned(id: string, userId: string): Promise<void> {
  const holding = await prisma.holding.findFirst({ where: { id, userId } });
  if (!holding) {
    throw new NotFoundError(`holding ${id} not found`);
  }
}

export async function listHoldings(userId: string): Promise<HoldingDto[]> {
  const holdings = await prisma.holding.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
  });
  return holdings.map(toDto);
}

export async function getHolding(id: string, userId: string): Promise<HoldingDto> {
  const holding = await prisma.holding.findFirst({ where: { id, userId } });
  if (!holding) {
    throw new NotFoundError(`holding ${id} not found`);
  }
  return toDto(holding);
}

export async function createHolding(
  input: CreateHoldingInput,
  userId: string,
): Promise<HoldingDto> {
  const holding = await prisma.holding.create({
    data: {
      userId,
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
  userId: string,
): Promise<HoldingDto> {
  // Verify ownership first so another user's holding reads as not found rather
  // than being modified.
  await assertOwned(id, userId);
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

export async function deleteHolding(id: string, userId: string): Promise<void> {
  // Scope the delete to the owner: deleteMany with a userId filter removes the
  // row only when it belongs to the user, and reports 0 otherwise.
  const { count } = await prisma.holding.deleteMany({ where: { id, userId } });
  if (count === 0) {
    throw new NotFoundError(`holding ${id} not found`);
  }
}

/** Delete every lot for a ticker owned by the user; returns rows removed. */
export async function deleteHoldingsByTicker(
  ticker: string,
  userId: string,
): Promise<number> {
  const { count } = await prisma.holding.deleteMany({ where: { ticker, userId } });
  return count;
}
