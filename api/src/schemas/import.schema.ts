/** Zod schemas validating CSV holdings imports (external data). */
import { z } from "zod";

import { config } from "../config.js";
import {
  createHoldingSchema,
  isNotFuture,
  purchaseDateString,
  tickerSchema,
} from "./holding.schema.js";

/** The CSV columns, in template order. */
export const IMPORT_COLUMNS = ["ticker", "quantity", "price", "purchase_date"] as const;
export type ImportColumn = (typeof IMPORT_COLUMNS)[number];

const LARGEST_NUMBER = 1e12;

/** A required cell: trimmed, with a "<column> is missing" message when empty. */
function cell(column: ImportColumn) {
  return z
    .string({ required_error: `${column} is missing` })
    .trim()
    .min(1, `${column} is missing`);
}

/** A positive amount; a leading "$" and thousands separators are allowed. */
function amount(column: ImportColumn) {
  return cell(column)
    .transform((value) => value.replace(/^\$/, "").replace(/,/g, ""))
    .refine(
      (value) => /^-?(\d+(\.\d*)?|\.\d+)$/.test(value),
      `${column} must be a number`,
    )
    .transform(Number)
    .refine((value) => value > 0, `${column} must be greater than 0`)
    .refine((value) => value <= LARGEST_NUMBER, `${column} is too large`);
}

/** M/D/YYYY (how Excel re-saves US dates) as YYYY-MM-DD; other input unchanged. */
function toIsoDate(value: string): string {
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (!us) return value;
  const [, month, day, year] = us;
  return `${year}-${month!.padStart(2, "0")}-${day!.padStart(2, "0")}`;
}

const csvDate = cell("purchase_date")
  .transform(toIsoDate)
  .pipe(
    z
      .string()
      .date("purchase_date must be a date like 2024-03-15 or 3/15/2024")
      .refine(isNotFuture, "purchase_date can't be in the future"),
  );

/** One CSV data row (raw cell text), validated into a holding. */
export const csvRowSchema = z
  .object({
    ticker: cell("ticker").pipe(tickerSchema),
    quantity: amount("quantity"),
    price: amount("price"),
    purchase_date: csvDate,
  })
  .transform((row) => ({
    ticker: row.ticker,
    shares: row.quantity,
    buyPrice: row.price,
    purchaseDate: row.purchase_date,
  }));

export type ImportRowInput = z.infer<typeof csvRowSchema>;

/** POST /holdings/import/preview: the file's text. */
export const importPreviewSchema = z.object({
  csv: z
    .string({ required_error: "csv is required" })
    .min(1, "The file is empty.")
    .refine(
      (text) => Buffer.byteLength(text, "utf8") <= config.holdings.importMaxFileBytes,
      `The file is larger than ${Math.round(config.holdings.importMaxFileBytes / 1000)} KB.`,
    ),
});

/** POST /holdings/import: the previewed rows the user confirmed. */
export const importCommitSchema = z.object({
  rows: z
    .array(createHoldingSchema.extend({ purchaseDate: purchaseDateString }))
    .min(1, "Choose at least one row to import.")
    .max(
      config.holdings.importMaxRows,
      `Import at most ${config.holdings.importMaxRows} rows at a time.`,
    ),
});

export type ImportCommitInput = z.infer<typeof importCommitSchema>;
