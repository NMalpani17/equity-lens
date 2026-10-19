import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/quotes.service.js", () => ({
  verifyTickers: vi.fn(),
}));
vi.mock("../src/services/holdings.service.js", () => ({
  createHoldings: vi.fn(),
}));

import {
  importHoldings,
  parseHoldingsCsv,
  previewImport,
} from "../src/services/csvImport.service.js";
import { verifyTickers } from "../src/services/quotes.service.js";
import { createHoldings } from "../src/services/holdings.service.js";
import { ImportFileError, InvalidTickerError } from "../src/errors.js";

const verifyMock = vi.mocked(verifyTickers);
const createMock = vi.mocked(createHoldings);

const HEADER = "ticker,quantity,price,purchase_date";

function csv(...rows: string[]): string {
  return [HEADER, ...rows].join("\n");
}

function future(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

beforeEach(() => {
  vi.clearAllMocks();
  verifyMock.mockImplementation(async (tickers) =>
    Object.fromEntries(tickers.map((t) => [t, "ok" as const])),
  );
});

describe("parseHoldingsCsv", () => {
  it("parses valid rows with their line numbers", () => {
    const result = parseHoldingsCsv(
      csv("aapl,10,172.40,2024-02-12", "MSFT,2.5,402.75,2024-03-19"),
    );

    expect(result.errors).toEqual([]);
    expect(result.totalRows).toBe(2);
    expect(result.rows).toEqual([
      {
        line: 2,
        ticker: "AAPL",
        shares: 10,
        buyPrice: 172.4,
        purchaseDate: "2024-02-12",
      },
      {
        line: 3,
        ticker: "MSFT",
        shares: 2.5,
        buyPrice: 402.75,
        purchaseDate: "2024-03-19",
      },
    ]);
  });

  it("accepts header aliases, a BOM, quoted amounts and US dates", () => {
    const result = parseHoldingsCsv(
      '﻿Symbol, Shares ,Buy Price,Purchase Date\r\nBRK.B,"1,200","$1,234.50",3/5/2024\r\n',
    );

    expect(result.errors).toEqual([]);
    expect(result.rows[0]).toMatchObject({
      ticker: "BRK.B",
      shares: 1200,
      buyPrice: 1234.5,
      purchaseDate: "2024-03-05",
    });
  });

  it("ignores extra columns and blank lines", () => {
    const result = parseHoldingsCsv(
      "notes,ticker,quantity,price,purchase_date\n\nhi,NVDA,1,100,2024-08-27\n,,,,\n",
    );

    expect(result.totalRows).toBe(1);
    expect(result.rows[0]?.ticker).toBe("NVDA");
  });

  it("reports each bad field on its row", () => {
    const result = parseHoldingsCsv(
      csv(
        "AAPL,10,172.40,2024-02-12",
        "@@@,abc,-5,2024-02-30",
        `MSFT,0,10,${future(3)}`,
        "NVDA,,10,",
      ),
    );

    expect(result.rows.map((r) => r.ticker)).toEqual(["AAPL"]);
    expect(result.errors).toEqual([
      { line: 3, field: "ticker", message: "invalid ticker symbol" },
      { line: 3, field: "quantity", message: "quantity must be a number" },
      { line: 3, field: "price", message: "price must be greater than 0" },
      {
        line: 3,
        field: "purchase_date",
        message: "purchase_date must be a date like 2024-03-15 or 3/15/2024",
      },
      { line: 4, field: "quantity", message: "quantity must be greater than 0" },
      {
        line: 4,
        field: "purchase_date",
        message: "purchase_date can't be in the future",
      },
      { line: 5, field: "quantity", message: "quantity is missing" },
      { line: 5, field: "purchase_date", message: "purchase_date is missing" },
    ]);
  });

  it("treats a short row's missing cells as missing fields", () => {
    const result = parseHoldingsCsv(csv("AAPL,10"));

    expect(result.errors.map((e) => e.field)).toEqual(["price", "purchase_date"]);
  });

  it.each([
    ["an empty file", ""],
    ["a header without rows", HEADER],
    ["a missing column", "ticker,quantity,price\nAAPL,1,2"],
    ["an unclosed quote", `${HEADER}\n"AAPL,1,2,2024-01-02`],
  ])("rejects %s as a whole", (_label, text) => {
    expect(() => parseHoldingsCsv(text)).toThrow(ImportFileError);
  });

  it("names the missing columns", () => {
    expect(() => parseHoldingsCsv("ticker,shares\nAAPL,1")).toThrow(
      /missing the price, purchase_date columns/,
    );
  });

  it("caps the number of rows", () => {
    const rows = Array.from({ length: 4 }, () => "AAPL,1,1,2024-01-02");

    expect(() => parseHoldingsCsv(csv(...rows), 3)).toThrow(
      /has 4 rows; import at most 3/,
    );
    expect(parseHoldingsCsv(csv(...rows.slice(0, 3)), 3).rows).toHaveLength(3);
  });
});

describe("previewImport", () => {
  it("turns unknown tickers into errors and unchecked ones into warnings", async () => {
    verifyMock.mockResolvedValue({
      AAPL: "ok",
      ZZZZ: "not_found",
      NEWCO: "unavailable",
    });

    const preview = await previewImport(
      csv(
        "AAPL,1,1,2024-01-02",
        "ZZZZ,1,1,2024-01-02",
        "NEWCO,1,1,2024-01-02",
        "AAPL,x,1,2024-01-02",
        "ZZZZ,1,1,2024-01-03",
      ),
    );

    // Each ticker is checked once.
    expect(verifyMock).toHaveBeenCalledWith(["AAPL", "ZZZZ", "NEWCO"]);
    expect(preview.rows.map((r) => r.line)).toEqual([2, 4]);
    expect(preview.errors.map((e) => [e.line, e.field])).toEqual([
      [3, "ticker"],
      [5, "quantity"],
      [6, "ticker"],
    ]);
    expect(preview.warnings).toEqual([
      { line: 4, message: expect.stringContaining("NEWCO couldn't be checked") },
    ]);
    expect(preview.totalRows).toBe(5);
    expect(preview.errorRowCount).toBe(3);
  });
});

describe("importHoldings", () => {
  const rows = [
    { ticker: "AAPL", shares: 1, buyPrice: 100, purchaseDate: "2024-01-02" },
    { ticker: "MSFT", shares: 2, buyPrice: 200, purchaseDate: "2024-01-03" },
  ];

  it("saves every row in one call", async () => {
    createMock.mockResolvedValue(2);

    expect(await importHoldings({ rows }, "user-1")).toEqual({ imported: 2 });
    expect(createMock).toHaveBeenCalledWith(rows, "user-1");
  });

  it("saves nothing when a ticker is unknown", async () => {
    verifyMock.mockResolvedValue({ AAPL: "ok", MSFT: "not_found" });

    await expect(importHoldings({ rows }, "user-1")).rejects.toBeInstanceOf(
      InvalidTickerError,
    );
    expect(createMock).not.toHaveBeenCalled();
  });
});
