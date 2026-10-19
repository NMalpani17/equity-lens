import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

// Real parsing and validation; only the ticker check and the database write
// are mocked.
vi.mock("../src/services/quotes.service.js", () => ({
  verifyTickers: vi.fn(),
  verifyTicker: vi.fn(),
}));
vi.mock("../src/services/holdings.service.js", () => ({
  createHoldings: vi.fn(),
}));
vi.mock("../src/auth/verifyToken.js", () => ({
  verifySupabaseToken: vi.fn(),
}));

import { createApp } from "../src/app.js";
import { config } from "../src/config.js";
import { HoldingLimitError } from "../src/errors.js";
import { createHoldings } from "../src/services/holdings.service.js";
import { verifyTickers } from "../src/services/quotes.service.js";
import { verifySupabaseToken } from "../src/auth/verifyToken.js";

const app = createApp();
const createMock = vi.mocked(createHoldings);
const USER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const post = (path: string) =>
  request(app).post(path).set("Authorization", "Bearer test-token");

const rows = [
  { ticker: "AAPL", shares: 10, buyPrice: 172.4, purchaseDate: "2024-02-12" },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(verifySupabaseToken).mockResolvedValue({
    userId: USER_ID,
    isAnonymous: true,
  });
  vi.mocked(verifyTickers).mockImplementation(async (tickers) =>
    Object.fromEntries(tickers.map((t) => [t, "ok" as const])),
  );
  createMock.mockResolvedValue(1);
});

describe("POST /api/holdings/import/preview", () => {
  it("returns valid rows and row errors without writing (demo users too)", async () => {
    const res = await post("/api/holdings/import/preview").send({
      csv: "ticker,quantity,price,purchase_date\nAAPL,10,172.40,2024-02-12\nMSFT,abc,1,2024-01-02",
    });

    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([{ line: 2, ...rows[0] }]);
    expect(res.body.errors).toEqual([
      { line: 3, field: "quantity", message: "quantity must be a number" },
    ]);
    expect(res.body.errorRowCount).toBe(1);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("returns 422 for a file-level problem", async () => {
    const res = await post("/api/holdings/import/preview").send({ csv: "a,b\n1,2" });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("invalid_csv_header");
  });

  it("returns 422 for a file over the size limit", async () => {
    const big = "x".repeat(config.holdings.importMaxFileBytes + 1);

    const res = await post("/api/holdings/import/preview").send({ csv: big });

    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/larger than 100 KB/);
  });

  it("returns 413 for a body over the parser limit", async () => {
    const huge = "x".repeat(config.holdings.importMaxFileBytes * 3);

    const res = await post("/api/holdings/import/preview").send({ csv: huge });

    expect(res.status).toBe(413);
    expect(res.body.error).toBe("payload_too_large");
  });

  it("returns 401 without a token", async () => {
    const res = await request(app)
      .post("/api/holdings/import/preview")
      .send({ csv: "x" });

    expect(res.status).toBe(401);
  });
});

describe("POST /api/holdings/import", () => {
  it("saves the confirmed rows and returns 201", async () => {
    const res = await post("/api/holdings/import").send({ rows });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ imported: 1 });
    expect(createMock).toHaveBeenCalledWith(rows, USER_ID);
  });

  it.each([
    ["no rows", { rows: [] }],
    ["a row without a purchase date", { rows: [{ ...rows[0], purchaseDate: null }] }],
    ["a bad number", { rows: [{ ...rows[0], shares: -1 }] }],
    [
      "too many rows",
      {
        rows: Array.from({ length: config.holdings.importMaxRows + 1 }, () => rows[0]),
      },
    ],
  ])("returns 422 for %s and saves nothing", async (_label, body) => {
    const res = await post("/api/holdings/import").send(body);

    expect(res.status).toBe(422);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("returns 422 and saves nothing for an unknown ticker", async () => {
    vi.mocked(verifyTickers).mockResolvedValue({ AAPL: "not_found" });

    const res = await post("/api/holdings/import").send({ rows });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("invalid_ticker");
    expect(createMock).not.toHaveBeenCalled();
  });

  it("returns 409 at the holdings cap", async () => {
    createMock.mockRejectedValue(new HoldingLimitError(1000, 1000));

    const res = await post("/api/holdings/import").send({ rows });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: "holding_limit_reached",
      limit: 1000,
      current: 1000,
    });
  });

  it("returns 400 for malformed JSON", async () => {
    const res = await post("/api/holdings/import")
      .set("Content-Type", "application/json")
      .send("{not json");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });
});
