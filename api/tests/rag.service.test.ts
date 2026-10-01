import { afterEach, describe, expect, it, vi } from "vitest";

import { getTickerStatus, searchTranscripts } from "../src/services/rag.service.js";
import { HttpError, UpstreamError } from "../src/errors.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const upstreamResult = {
  id: "AAPL#FY2025Q3#0007",
  text: "Services revenue hit an all-time record.",
  score: 0.93,
  retrieval_score: 0.71,
  rerank_score: 0.93,
  ticker: "AAPL",
  company_name: "Apple Inc",
  fiscal_year: 2025,
  fiscal_quarter: 3,
  call_date: "2025-07-31",
  speaker: "Tim Cook",
  role: "CEO",
  section: "prepared_remarks",
  chunk_index: 7,
  context_header: "AAPL (Apple Inc) · Q3 FY2025 earnings call",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("searchTranscripts", () => {
  it("sends snake_case input and maps results to camelCase", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        status: "ok",
        query: "services",
        filters: { ticker: "AAPL", fiscal_year: 2025, fiscal_quarter: null },
        reranked: false,
        candidate_count: 25,
        results: [upstreamResult],
        latency_ms: 150.2,
      }),
    );

    const outcome = await searchTranscripts({
      query: "services",
      ticker: "AAPL",
      fiscalYear: 2025,
      topK: 5,
    });

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toMatch(/\/rag\/search$/);
    expect(JSON.parse(String(init?.body))).toEqual({
      query: "services",
      ticker: "AAPL",
      fiscal_year: 2025,
      top_k: 5,
    });
    expect(outcome.kind).toBe("results");
    if (outcome.kind !== "results") throw new Error("unreachable");
    expect(outcome.body.reranked).toBe(false);
    expect(outcome.body.filters).toEqual({
      ticker: "AAPL",
      fiscalYear: 2025,
      fiscalQuarter: null,
    });
    expect(outcome.body.results[0]).toMatchObject({
      companyName: "Apple Inc",
      retrievalScore: 0.71,
      rerankScore: 0.93,
      chunkIndex: 7,
      contextHeader: "AAPL (Apple Inc) · Q3 FY2025 earnings call",
    });
  });

  it("maps a 202 indexing response to this API's poll URL", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(
        {
          status: "indexing",
          ticker: "NVDA",
          job_id: "job-1",
          message: "indexing",
          poll_url: "/rag/tickers/NVDA",
        },
        202,
      ),
    );

    const outcome = await searchTranscripts({ query: "q", ticker: "NVDA", topK: 5 });

    expect(outcome).toEqual({
      kind: "indexing",
      body: {
        status: "indexing",
        ticker: "NVDA",
        jobId: "job-1",
        message: "indexing",
        pollUrl: "/api/rag/tickers/NVDA",
      },
    });
  });

  it("passes through a 429 with camelCased details", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(
        {
          error: "ingestion_cap_reached",
          message: "daily limit reached",
          ticker: "NVDA",
          cap: 8,
          resets_at: "2026-10-01T00:00:00+00:00",
        },
        429,
      ),
    );

    const error = await searchTranscripts({
      query: "q",
      ticker: "NVDA",
      topK: 5,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({
      status: 429,
      code: "ingestion_cap_reached",
      details: { ticker: "NVDA", cap: 8, resetsAt: "2026-10-01T00:00:00+00:00" },
    });
  });

  it("turns unexpected upstream errors into a 502", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ error: "internal_server_error" }, 500),
    );

    await expect(searchTranscripts({ query: "q", topK: 5 })).rejects.toBeInstanceOf(
      UpstreamError,
    );
  });

  it("turns network failures into a 502", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));

    await expect(searchTranscripts({ query: "q", topK: 5 })).rejects.toBeInstanceOf(
      UpstreamError,
    );
  });

  it("rejects malformed upstream bodies", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ status: "ok" }));

    await expect(searchTranscripts({ query: "q", topK: 5 })).rejects.toBeInstanceOf(
      UpstreamError,
    );
  });
});

describe("getTickerStatus", () => {
  it("maps the status and latest job", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        ticker: "NVDA",
        status: "indexing",
        company_name: null,
        chunk_count: 0,
        quarters: [],
        indexed_at: null,
        last_error: null,
        job: {
          id: "job-1",
          status: "running",
          trigger: "on_demand",
          error: null,
          created_at: "2026-09-30T12:00:00",
          started_at: "2026-09-30T12:00:01",
          finished_at: null,
        },
      }),
    );

    const status = await getTickerStatus("NVDA");

    expect(status.job).toMatchObject({
      id: "job-1",
      status: "running",
      finishedAt: null,
    });
    expect(status.chunkCount).toBe(0);
  });
});
