/** Shared API types. */

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
