/** Zod schemas validating holdings input (external data). */
import { z } from "zod";

/** A stock ticker: 1–10 chars, letters/digits/dot/dash, normalized to upper. */
export const tickerSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9.-]{0,9}$/, "invalid ticker symbol");

export const holdingIdSchema = z.string().uuid("invalid holding id");

/** True when an ISO date (YYYY-MM-DD) is today or earlier (UTC). */
function isNotFuture(value: string): boolean {
  return value <= new Date().toISOString().slice(0, 10);
}

/**
 * Optional purchase date as an ISO calendar date (YYYY-MM-DD). Must not be in
 * the future. Compared as strings, which is safe for the YYYY-MM-DD format.
 */
const purchaseDateSchema = z
  .string()
  .date("purchaseDate must be an ISO date (YYYY-MM-DD)")
  .refine(isNotFuture, "purchaseDate cannot be in the future")
  .nullable()
  .optional();

export const createHoldingSchema = z.object({
  ticker: tickerSchema,
  shares: z.number().positive("shares must be greater than 0"),
  buyPrice: z.number().positive("buyPrice must be greater than 0"),
  purchaseDate: purchaseDateSchema,
});

/** All fields optional on update, but at least one must be present. */
export const updateHoldingSchema = createHoldingSchema
  .partial()
  .refine((data) => Object.keys(data).length > 0, {
    message: "at least one field is required",
  });

export type CreateHoldingInput = z.infer<typeof createHoldingSchema>;
export type UpdateHoldingInput = z.infer<typeof updateHoldingSchema>;
