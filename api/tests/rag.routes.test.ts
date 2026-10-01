import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

// Mock the RAG service so route tests cover auth, validation and status codes
// without calling the AI service.
vi.mock("../src/services/rag.service.js", () => ({
  searchTranscripts: vi.fn(),
  getTickerStatus: vi.fn(),
  listTickerStatuses: vi.fn(),
}));

vi.mock("../src/auth/verifyToken.js", () => ({
  verifySupabaseToken: vi.fn(),
}));

import { createApp } from "../src/app.js";
import * as ragService from "../src/services/rag.service.js";
import { verifySupabaseToken } from "../src/auth/verifyToken.js";
import { HttpError } from "../src/errors.js";

const app = createApp();
const service = vi.mocked(ragService);
const verifyTokenMock = vi.mocked(verifySupabaseToken);
const AUTH = "Bearer test-token";

const post = (path: string) => request(app).post(path).set("Authorization", AUTH);
const get = (path: string) => request(app).get(path).set("Authorization", AUTH);

const searchBody = {
  status: "ok" as const,
  query: "services growth",
  filters: { ticker: "AAPL", fiscalYear: null, fiscalQuarter: null },
  reranked: true,
  candidateCount: 25,
  results: [],
  latencyMs: 210,
};

beforeEach(() => {
  vi.clearAllMocks();
  verifyTokenMock.mockResolvedValue({
    userId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    isAnonymous: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/rag/search", () => {
  it("requires authentication", async () => {
    const res = await request(app).post("/api/rag/search").send({ query: "q" });

    expect(res.status).toBe(401);
    expect(service.searchTranscripts).not.toHaveBeenCalled();
  });

  it("returns results and normalizes input", async () => {
    service.searchTranscripts.mockResolvedValue({ kind: "results", body: searchBody });

    const res = await post("/api/rag/search").send({
      query: "  services growth ",
      ticker: "aapl",
    });

    expect(res.status).toBe(200);
    expect(res.body.reranked).toBe(true);
    expect(service.searchTranscripts).toHaveBeenCalledWith({
      query: "services growth",
      ticker: "AAPL",
      topK: 5,
    });
  });

  it("returns 202 with a poll URL while the ticker is indexing", async () => {
    service.searchTranscripts.mockResolvedValue({
      kind: "indexing",
      body: {
        status: "indexing",
        ticker: "NVDA",
        jobId: "job-1",
        message: "indexing",
        pollUrl: "/api/rag/tickers/NVDA",
      },
    });

    const res = await post("/api/rag/search").send({ query: "q", ticker: "NVDA" });

    expect(res.status).toBe(202);
    expect(res.body.pollUrl).toBe("/api/rag/tickers/NVDA");
  });

  it.each([
    [{}],
    [{ query: "" }],
    [{ query: "q", topK: 21 }],
    [{ query: "q", fiscalQuarter: 5 }],
    [{ query: "q", ticker: "not a ticker" }],
  ])("rejects invalid input %j with 422", async (body) => {
    const res = await post("/api/rag/search").send(body);

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("validation_error");
    expect(service.searchTranscripts).not.toHaveBeenCalled();
  });

  it("passes through the daily cap error with its details", async () => {
    service.searchTranscripts.mockRejectedValue(
      new HttpError(429, "ingestion_cap_reached", "daily limit reached", {
        cap: 8,
        resetsAt: "2026-10-01T00:00:00+00:00",
      }),
    );

    const res = await post("/api/rag/search").send({ query: "q", ticker: "NVDA" });

    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({
      error: "ingestion_cap_reached",
      cap: 8,
      resetsAt: "2026-10-01T00:00:00+00:00",
    });
  });
});

describe("GET /api/rag/tickers", () => {
  it("returns a ticker's status", async () => {
    service.getTickerStatus.mockResolvedValue({
      ticker: "NVDA",
      status: "indexing",
      companyName: null,
      chunkCount: 0,
      quarters: [],
      indexedAt: null,
      lastError: null,
      job: null,
    });

    const res = await get("/api/rag/tickers/nvda");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("indexing");
    expect(service.getTickerStatus).toHaveBeenCalledWith("NVDA");
  });

  it("lists tickers", async () => {
    service.listTickerStatuses.mockResolvedValue([]);

    const res = await get("/api/rag/tickers");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tickers: [] });
  });

  it("requires authentication for status polling", async () => {
    const res = await request(app).get("/api/rag/tickers/NVDA");

    expect(res.status).toBe(401);
  });
});
