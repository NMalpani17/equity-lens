/** Typed client for the Equity Lens API gateway. */
import { supabase } from "./supabase";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3001";

/** Error thrown for non-OK API responses, carrying the HTTP status. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** The Authorization header for the current session, or empty when signed out. */
async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
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
    let message = `Request failed (${response.status})`;
    try {
      const body = (await response.json()) as { message?: unknown };
      if (typeof body?.message === "string" && body.message.length > 0) {
        message = body.message;
      }
    } catch {
      // Non-JSON or empty body: keep the generic message.
    }
    throw new ApiError(response.status, message);
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
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
  dependencies: {
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
  const response = await fetch(`${API_URL}/api/health`);
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
