/** Typed client for the Equity Lens API gateway. */

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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      headers: { "Content-Type": "application/json" },
      ...init,
    });
  } catch {
    throw new ApiError(0, "Could not reach the API. Is it running?");
  }

  if (!response.ok) {
    throw new ApiError(response.status, `Request failed (${response.status})`);
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
  createdAt: string;
  updatedAt: string;
}

export interface HoldingInput {
  ticker: string;
  shares: number;
  buyPrice: number;
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

// --- Portfolio summary ----------------------------------------------------

export type PriceStatus = "ok" | "not_found" | "unavailable";

export interface PortfolioHolding {
  id: string;
  ticker: string;
  name: string | null;
  shares: number;
  buyPrice: number;
  costBasis: number;
  currentPrice: number | null;
  marketValue: number | null;
  gainLoss: number | null;
  gainLossPercent: number | null;
  dailyChange: number | null;
  dailyChangePercent: number | null;
  priceStatus: PriceStatus;
}

export interface PortfolioTotals {
  marketValue: number;
  costBasis: number;
  gainLoss: number;
  gainLossPercent: number;
  dailyChange: number;
}

export interface PortfolioSummary {
  holdings: PortfolioHolding[];
  totals: PortfolioTotals;
}

export function getPortfolioSummary(): Promise<PortfolioSummary> {
  return request<PortfolioSummary>("/api/portfolio/summary");
}
