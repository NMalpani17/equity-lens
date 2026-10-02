/**
 * The single way this gateway calls the ai-service.
 *
 * Every request carries the shared internal token, which the ai-service
 * requires on all routes except /health (and accepts there too).
 */
import { config } from "../config.js";

export const INTERNAL_TOKEN_HEADER = "X-Internal-Token";

/** Absolute ai-service URL for a path such as "/quotes". */
export function aiServiceUrl(path: string): URL {
  return new URL(path, config.aiServiceUrl);
}

/** fetch() against the ai-service with the internal token attached. */
export function aiServiceFetch(url: URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set(INTERNAL_TOKEN_HEADER, config.aiServiceInternalToken);
  return fetch(url, { ...init, headers });
}
