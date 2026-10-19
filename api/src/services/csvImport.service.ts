/**
 * CSV holdings import: parse and validate a file into a preview, then save
 * the rows the user confirms.
 *
 * The preview never writes. The save validates again (it is a separate
 * request), re-checks tickers (answered from the ai-service's caches after
 * the preview), and inserts every row in one transaction, or none.
 */
import { parse } from "csv-parse/sync";

import { config } from "../config.js";
import { ImportFileError, InvalidTickerError } from "../errors.js";
import { createHoldings } from "./holdings.service.js";
import { verifyTickers, type TickerCheck } from "./quotes.service.js";
import {
  IMPORT_COLUMNS,
  csvRowSchema,
  type ImportColumn,
  type ImportCommitInput,
  type ImportRowInput,
} from "../schemas/import.schema.js";

/** A valid row, with its line number in the file. */
export interface ImportRow extends ImportRowInput {
  line: number;
}

export interface ImportRowError {
  line: number;
  field: ImportColumn;
  message: string;
}

export interface ImportPreview {
  /** Rows that can be imported. */
  rows: ImportRow[];
  /** Problems in the other rows (a row may have several). */
  errors: ImportRowError[];
  /** Valid rows worth a note (e.g. a ticker that couldn't be checked). */
  warnings: { line: number; message: string }[];
  /** Data rows in the file. */
  totalRows: number;
  /** Rows with at least one error. */
  errorRowCount: number;
}

export interface ParsedCsv {
  rows: ImportRow[];
  errors: ImportRowError[];
  totalRows: number;
}

/** Header spellings accepted for each column (compared without case or spacing). */
const HEADER_ALIASES: Record<ImportColumn, string[]> = {
  ticker: ["ticker", "symbol"],
  quantity: ["quantity", "shares", "qty"],
  price: ["price", "buyprice", "purchaseprice", "costpershare"],
  purchase_date: ["purchasedate", "date", "buydate", "tradedate"],
};

const TEMPLATE_HINT =
  "Use the template's columns: ticker, quantity, price, purchase_date.";

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z]/g, "");
}

/** Index of each column in the header row; throws when any is missing. */
function columnIndexes(header: string[]): Record<ImportColumn, number> {
  const normalized = header.map(normalizeHeader);
  const missing: string[] = [];
  const indexes = {} as Record<ImportColumn, number>;
  for (const column of IMPORT_COLUMNS) {
    const index = normalized.findIndex((name) => HEADER_ALIASES[column].includes(name));
    if (index === -1) missing.push(column);
    indexes[column] = index;
  }
  if (missing.length > 0) {
    throw new ImportFileError(
      "invalid_csv_header",
      `The file is missing the ${missing.join(", ")} column${missing.length > 1 ? "s" : ""}. ${TEMPLATE_HINT}`,
    );
  }
  return indexes;
}

/**
 * Pure parse + validation of a CSV file. File-level problems (unreadable,
 * no header, too many rows) throw ImportFileError; row problems are returned.
 */
export function parseHoldingsCsv(
  text: string,
  maxRows = config.holdings.importMaxRows,
): ParsedCsv {
  let records: { record: string[]; info: { lines: number } }[];
  try {
    records = parse(text, {
      bom: true,
      info: true,
      relax_column_count: true,
      skip_empty_lines: true,
      skip_records_with_empty_values: true,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    throw new ImportFileError(
      "invalid_csv",
      `The file couldn't be read as CSV (${reason}).`,
    );
  }

  const [header, ...data] = records;
  if (!header) {
    throw new ImportFileError("invalid_csv", `The file is empty. ${TEMPLATE_HINT}`);
  }
  const indexes = columnIndexes(header.record);
  if (data.length === 0) {
    throw new ImportFileError("invalid_csv", "The file has a header but no rows.");
  }
  if (data.length > maxRows) {
    throw new ImportFileError(
      "too_many_rows",
      `The file has ${data.length} rows; import at most ${maxRows} at a time.`,
    );
  }

  const rows: ImportRow[] = [];
  const errors: ImportRowError[] = [];
  for (const { record, info } of data) {
    const raw = Object.fromEntries(
      IMPORT_COLUMNS.map((column) => [column, record[indexes[column]]]),
    );
    const result = csvRowSchema.safeParse(raw);
    if (result.success) {
      rows.push({ line: info.lines, ...result.data });
      continue;
    }
    // One message per field: the first problem found.
    const seen = new Set<string>();
    for (const issue of result.error.issues) {
      const field = issue.path[0] as ImportColumn;
      if (seen.has(field)) continue;
      seen.add(field);
      errors.push({ line: info.lines, field, message: issue.message });
    }
  }
  return { rows, errors, totalRows: data.length };
}

function uniqueTickers(rows: { ticker: string }[]): string[] {
  return [...new Set(rows.map((row) => row.ticker))];
}

/** Parse, validate and check tickers, without writing anything. */
export async function previewImport(csv: string): Promise<ImportPreview> {
  const parsed = parseHoldingsCsv(csv);
  const statuses = await verifyTickers(uniqueTickers(parsed.rows));

  const rows: ImportRow[] = [];
  const errors = [...parsed.errors];
  const warnings: ImportPreview["warnings"] = [];
  for (const row of parsed.rows) {
    const status: TickerCheck = statuses[row.ticker] ?? "unavailable";
    if (status === "not_found") {
      errors.push({
        line: row.line,
        field: "ticker",
        message: `${row.ticker} isn't a recognized ticker.`,
      });
      continue;
    }
    if (status === "unavailable") {
      warnings.push({
        line: row.line,
        message: `${row.ticker} couldn't be checked right now; it will be imported as entered.`,
      });
    }
    rows.push(row);
  }
  errors.sort((a, b) => a.line - b.line);
  return {
    rows,
    errors,
    warnings,
    totalRows: parsed.totalRows,
    errorRowCount: new Set(errors.map((e) => e.line)).size,
  };
}

/** Save confirmed rows in one transaction; rejects them all on an unknown ticker. */
export async function importHoldings(
  input: ImportCommitInput,
  userId: string,
): Promise<{ imported: number }> {
  const statuses = await verifyTickers(uniqueTickers(input.rows));
  const unknown = uniqueTickers(input.rows).filter((t) => statuses[t] === "not_found");
  if (unknown.length > 0) {
    throw new InvalidTickerError(
      `Not recognized: ${unknown.join(", ")}. Nothing was imported.`,
    );
  }
  const imported = await createHoldings(input.rows, userId);
  return { imported };
}
