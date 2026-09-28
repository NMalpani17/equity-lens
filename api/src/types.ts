/** Shared API types. */

/** A holding as returned by the API (Decimals serialized to numbers). */
export interface HoldingDto {
  id: string;
  ticker: string;
  shares: number;
  buyPrice: number;
  createdAt: string;
  updatedAt: string;
}

export interface ServiceHealth {
  status: "ok" | "unreachable";
  service: string;
  version?: string;
  environment?: string;
}

export interface HealthResponse {
  status: "ok" | "degraded";
  service: string;
  version: string;
  /** Health of downstream dependencies. */
  dependencies: {
    aiService: ServiceHealth;
  };
}
