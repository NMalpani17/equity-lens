/** Typed client for the Equity Lens API gateway. */

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3001";

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
 * A 503 (degraded) still returns a parsed body, so we read JSON either way.
 */
export async function getApiHealth(): Promise<HealthResponse> {
  const response = await fetch(`${API_URL}/api/health`);
  if (!response.ok && response.status !== 503) {
    throw new Error(`API health request failed: ${response.status}`);
  }
  return (await response.json()) as HealthResponse;
}
