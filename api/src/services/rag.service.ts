/**
 * Client for the AI service's transcript search (RAG) endpoints.
 *
 * Upstream responses are external input, so they are validated with Zod and
 * mapped from snake_case to camelCase. Expected upstream errors (no
 * transcripts, daily cap reached, not configured) are passed through with
 * their status and code; anything else becomes a 502.
 */
import { z } from "zod";

import { config } from "../config.js";
import { HttpError, UpstreamError } from "../errors.js";
import { logger } from "../logger.js";
import type { RagSearchInput } from "../schemas/rag.schema.js";

// Embedding + vector query + rerank, plus a cold start, can take a few seconds.
const REQUEST_TIMEOUT_MS = 20_000;

/** Upstream statuses whose error body is meaningful to the client. */
const PASSTHROUGH_STATUSES = new Set([404, 429, 503]);

const upstreamResultSchema = z.object({
  id: z.string(),
  text: z.string(),
  score: z.number(),
  retrieval_score: z.number(),
  rerank_score: z.number().nullable(),
  ticker: z.string(),
  company_name: z.string(),
  fiscal_year: z.number(),
  fiscal_quarter: z.number(),
  call_date: z.string().nullable(),
  speaker: z.string(),
  role: z.string().nullable(),
  section: z.enum(["prepared_remarks", "qa"]),
  chunk_index: z.number(),
  context_header: z.string(),
});

const upstreamSearchSchema = z.object({
  status: z.literal("ok"),
  query: z.string(),
  filters: z.object({
    ticker: z.string().nullable(),
    fiscal_year: z.number().nullable(),
    fiscal_quarter: z.number().nullable(),
  }),
  reranked: z.boolean(),
  candidate_count: z.number(),
  results: z.array(upstreamResultSchema),
  latency_ms: z.number(),
});

const upstreamIndexingSchema = z.object({
  status: z.literal("indexing"),
  ticker: z.string(),
  job_id: z.string().nullable(),
  message: z.string(),
  poll_url: z.string(),
});

const upstreamJobSchema = z.object({
  id: z.string(),
  status: z.enum(["queued", "running", "succeeded", "failed"]),
  trigger: z.string(),
  error: z.string().nullable(),
  created_at: z.string(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
});

const upstreamTickerStatusSchema = z.object({
  ticker: z.string(),
  status: z.enum(["not_indexed", "indexing", "indexed", "failed", "unavailable"]),
  company_name: z.string().nullable(),
  chunk_count: z.number(),
  quarters: z.array(z.string()),
  indexed_at: z.string().nullable(),
  last_error: z.string().nullable(),
  job: upstreamJobSchema.nullable(),
});

const upstreamTickerListSchema = z.object({
  tickers: z.array(upstreamTickerStatusSchema),
});

const upstreamErrorSchema = z
  .object({ error: z.string(), message: z.string().optional() })
  .passthrough();

type UpstreamResult = z.infer<typeof upstreamResultSchema>;
type UpstreamTickerStatus = z.infer<typeof upstreamTickerStatusSchema>;

export interface RagSearchResult {
  id: string;
  text: string;
  score: number;
  retrievalScore: number;
  rerankScore: number | null;
  ticker: string;
  companyName: string;
  fiscalYear: number;
  fiscalQuarter: number;
  callDate: string | null;
  speaker: string;
  role: string | null;
  section: "prepared_remarks" | "qa";
  chunkIndex: number;
  contextHeader: string;
}

export interface RagSearchResponse {
  status: "ok";
  query: string;
  filters: {
    ticker: string | null;
    fiscalYear: number | null;
    fiscalQuarter: number | null;
  };
  reranked: boolean;
  candidateCount: number;
  results: RagSearchResult[];
  latencyMs: number;
}

export interface RagIndexingResponse {
  status: "indexing";
  ticker: string;
  jobId: string | null;
  message: string;
  /** Path on this API to poll for indexing progress. */
  pollUrl: string;
}

export type RagSearchOutcome =
  | { kind: "results"; body: RagSearchResponse }
  | { kind: "indexing"; body: RagIndexingResponse };

export interface RagTickerStatus {
  ticker: string;
  status: UpstreamTickerStatus["status"];
  companyName: string | null;
  chunkCount: number;
  quarters: string[];
  indexedAt: string | null;
  lastError: string | null;
  job: {
    id: string;
    status: "queued" | "running" | "succeeded" | "failed";
    trigger: string;
    error: string | null;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
  } | null;
}

function toResult(raw: UpstreamResult): RagSearchResult {
  return {
    id: raw.id,
    text: raw.text,
    score: raw.score,
    retrievalScore: raw.retrieval_score,
    rerankScore: raw.rerank_score,
    ticker: raw.ticker,
    companyName: raw.company_name,
    fiscalYear: raw.fiscal_year,
    fiscalQuarter: raw.fiscal_quarter,
    callDate: raw.call_date,
    speaker: raw.speaker,
    role: raw.role,
    section: raw.section,
    chunkIndex: raw.chunk_index,
    contextHeader: raw.context_header,
  };
}

function toTickerStatus(raw: UpstreamTickerStatus): RagTickerStatus {
  return {
    ticker: raw.ticker,
    status: raw.status,
    companyName: raw.company_name,
    chunkCount: raw.chunk_count,
    quarters: raw.quarters,
    indexedAt: raw.indexed_at,
    lastError: raw.last_error,
    job: raw.job && {
      id: raw.job.id,
      status: raw.job.status,
      trigger: raw.job.trigger,
      error: raw.job.error,
      createdAt: raw.job.created_at,
      startedAt: raw.job.started_at,
      finishedAt: raw.job.finished_at,
    },
  };
}

/** Convert snake_case error detail keys (e.g. resets_at) to camelCase. */
function camelizeKeys(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
      value,
    ]),
  );
}

/** Perform a request to the AI service, returning status + parsed JSON body. */
async function requestAiService(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown }> {
  const url = new URL(path, config.aiServiceUrl);
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    logger.warn({ url: url.toString(), err: error }, "failed to reach ai-service rag");
    throw new UpstreamError("transcript search is unavailable");
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON body: handled below via the status code.
  }

  if (!response.ok) {
    const parsedError = upstreamErrorSchema.safeParse(body);
    if (PASSTHROUGH_STATUSES.has(response.status) && parsedError.success) {
      const { error, message, ...details } = parsedError.data;
      throw new HttpError(
        response.status,
        error,
        message ?? error,
        camelizeKeys(details),
      );
    }
    logger.warn(
      { url: url.toString(), status: response.status },
      "ai-service rag returned non-OK",
    );
    throw new UpstreamError("transcript search failed");
  }
  return { status: response.status, body };
}

function parseOrThrow<T>(schema: z.ZodType<T>, body: unknown, what: string): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    logger.warn({ err: parsed.error.flatten() }, `unexpected ai-service ${what} shape`);
    throw new UpstreamError("transcript search returned an unexpected response");
  }
  return parsed.data;
}

/** Search transcripts; returns results or an "indexing" status to poll. */
export async function searchTranscripts(
  input: RagSearchInput,
): Promise<RagSearchOutcome> {
  const { status, body } = await requestAiService("/rag/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: input.query,
      ticker: input.ticker,
      fiscal_year: input.fiscalYear,
      fiscal_quarter: input.fiscalQuarter,
      top_k: input.topK,
    }),
  });

  if (status === 202) {
    const raw = parseOrThrow(upstreamIndexingSchema, body, "indexing");
    return {
      kind: "indexing",
      body: {
        status: "indexing",
        ticker: raw.ticker,
        jobId: raw.job_id,
        message: raw.message,
        pollUrl: `/api/rag/tickers/${encodeURIComponent(raw.ticker)}`,
      },
    };
  }

  const raw = parseOrThrow(upstreamSearchSchema, body, "search");
  return {
    kind: "results",
    body: {
      status: "ok",
      query: raw.query,
      filters: {
        ticker: raw.filters.ticker,
        fiscalYear: raw.filters.fiscal_year,
        fiscalQuarter: raw.filters.fiscal_quarter,
      },
      reranked: raw.reranked,
      candidateCount: raw.candidate_count,
      results: raw.results.map(toResult),
      latencyMs: raw.latency_ms,
    },
  };
}

/** Indexing status for one ticker. */
export async function getTickerStatus(ticker: string): Promise<RagTickerStatus> {
  const { body } = await requestAiService(`/rag/tickers/${encodeURIComponent(ticker)}`);
  return toTickerStatus(
    parseOrThrow(upstreamTickerStatusSchema, body, "ticker status"),
  );
}

/** Every ticker that has been indexed or attempted. */
export async function listTickerStatuses(): Promise<RagTickerStatus[]> {
  const { body } = await requestAiService("/rag/tickers");
  return parseOrThrow(upstreamTickerListSchema, body, "ticker list").tickers.map(
    toTickerStatus,
  );
}
