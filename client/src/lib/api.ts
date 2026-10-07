/** Typed client for the Equity Lens API gateway. */
import { parseSse } from "./sse";
import { supabase } from "./supabase";

export const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3001";

/** Error thrown for non-OK API responses, carrying the HTTP status. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** Machine-readable error code from the API (e.g. "chat_limit_reached"). */
    public readonly code?: string,
    /** Extra fields from the error body (e.g. resetsAt for rate limits). */
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Build an ApiError from a non-OK response, preferring the API's message. */
export async function apiErrorFrom(response: Response): Promise<ApiError> {
  // Never show a bare status code; the status stays on ApiError.status.
  let message = "Something went wrong. Please try again.";
  let code: string | undefined;
  let details: Record<string, unknown> = {};
  try {
    const body = (await response.json()) as Record<string, unknown>;
    if (typeof body?.message === "string" && body.message.length > 0) {
      message = body.message;
    }
    if (typeof body?.error === "string") code = body.error;
    details = body ?? {};
  } catch {
    // Non-JSON or empty body: keep the generic message.
  }
  return new ApiError(response.status, message, code, details);
}

/** The Authorization header for the current session, or empty when signed out. */
export async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const auth = await authHeaders();
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...auth, ...init?.headers },
    });
  } catch {
    throw new ApiError(0, "Could not reach the API. Is it running?");
  }

  if (!response.ok) {
    // Prefer the API's human-readable error message (e.g. an invalid ticker)
    // so callers can surface it directly; fall back to a generic message.
    throw await apiErrorFrom(response);
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

/**
 * POST and read a server-sent-events response, calling `onFrame` for each
 * frame whose event name is in `events` (data parsed as JSON; malformed
 * frames are skipped). Rejects with an ApiError for errors before streaming
 * starts (the API's JSON errors). Aborting `signal` stops reading.
 */
export async function postEventStream(
  path: string,
  body: Record<string, unknown>,
  events: ReadonlySet<string>,
  onFrame: (event: string, data: Record<string, unknown>) => void,
  signal?: AbortSignal,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...(await authHeaders()),
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError(0, "Could not reach the API. Is it running?");
  }
  if (!response.ok || !response.body) {
    throw await apiErrorFrom(response);
  }
  for await (const frame of parseSse(response.body)) {
    if (!events.has(frame.event)) continue;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(frame.data) as Record<string, unknown>;
    } catch {
      continue; // a malformed frame doesn't abandon the stream
    }
    onFrame(frame.event, data);
  }
}

// --- Health ---------------------------------------------------------------

export interface ServiceHealth {
  status: string;
  service: string;
  version?: string;
  environment?: string;
}

export interface HealthResponse {
  status: "ok" | "degraded";
  service: string;
  version: string;
  /** Only reported to signed-in (or demo) users. */
  dependencies?: {
    aiService: ServiceHealth;
  };
}

/**
 * Fetch the API health, which in turn reflects the downstream AI service.
 *
 * A 503 means the API is up but a dependency is down: it returns a valid
 * `degraded` body, so we parse and return it instead of throwing. Only other
 * non-OK statuses (the API itself being unreachable) are treated as errors.
 */
export async function getApiHealth(): Promise<HealthResponse> {
  // The ai-service's status is only reported to signed-in (or demo) users.
  const response = await fetch(`${API_URL}/api/health`, {
    headers: await authHeaders(),
  });
  if (!response.ok && response.status !== 503) {
    throw new Error(`API health request failed: ${response.status}`);
  }
  return (await response.json()) as HealthResponse;
}

// --- Holdings -------------------------------------------------------------

export interface Holding {
  id: string;
  ticker: string;
  shares: number;
  buyPrice: number;
  purchaseDate: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HoldingInput {
  ticker: string;
  shares: number;
  buyPrice: number;
  /** Optional ISO date (YYYY-MM-DD); null clears an existing date. */
  purchaseDate?: string | null;
}

export function createHolding(input: HoldingInput): Promise<Holding> {
  return request<Holding>("/api/holdings", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateHolding(
  id: string,
  input: Partial<HoldingInput>,
): Promise<Holding> {
  return request<Holding>(`/api/holdings/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function deleteHolding(id: string): Promise<void> {
  return request<void>(`/api/holdings/${id}`, { method: "DELETE" });
}

/** Delete every lot for a ticker (a whole position). */
export function deleteHoldingsByTicker(ticker: string): Promise<void> {
  return request<void>(`/api/holdings?ticker=${encodeURIComponent(ticker)}`, {
    method: "DELETE",
  });
}

// --- Portfolio summary ----------------------------------------------------

export type PriceStatus = "ok" | "not_found" | "unavailable";

/** A single lot (one purchase) within a position. */
export interface PortfolioLot {
  id: string;
  ticker: string;
  shares: number;
  buyPrice: number;
  purchaseDate: string | null;
  costBasis: number;
  currentPrice: number | null;
  marketValue: number | null;
  gainLoss: number | null;
  gainLossPercent: number | null;
  dailyChange: number | null;
  dailyChangePercent: number | null;
  priceStatus: PriceStatus;
}

/** All lots for a ticker, grouped with aggregate figures. */
export interface PortfolioPosition {
  ticker: string;
  name: string | null;
  totalShares: number;
  avgBuyPrice: number;
  costBasis: number;
  currentPrice: number | null;
  marketValue: number | null;
  gainLoss: number | null;
  gainLossPercent: number | null;
  dailyChange: number | null;
  dailyChangePercent: number | null;
  priceStatus: PriceStatus;
  lots: PortfolioLot[];
}

export interface PortfolioTotals {
  marketValue: number;
  costBasis: number;
  gainLoss: number;
  gainLossPercent: number;
  dailyChange: number;
  pricedCount: number;
  unpricedCount: number;
  partial: boolean;
}

export interface PortfolioSummary {
  positions: PortfolioPosition[];
  totals: PortfolioTotals;
}

export function getPortfolioSummary(): Promise<PortfolioSummary> {
  return request<PortfolioSummary>("/api/portfolio/summary");
}

// --- Account --------------------------------------------------------------

/** Permanently delete the authenticated user's account and all their data. */
export function deleteAccount(): Promise<void> {
  return request<void>("/api/account", { method: "DELETE" });
}
