/**
 * The single way this gateway calls the ai-service.
 *
 * Every request carries the shared internal token as X-Internal-Token, which
 * the ai-service requires on all routes except /health. In production the
 * ai-service also sits behind Cloud Run IAM: when AI_SERVICE_ID_TOKEN_AUDIENCE
 * is set, each request adds a Google ID token as "Authorization: Bearer". If
 * that token can't be fetched, the call rejects like a network failure, so
 * every caller's existing "unavailable" handling applies.
 */
import { config } from "../config.js";
import { logger } from "../logger.js";
import { createIdTokenProvider, type IdTokenProvider } from "./idToken.js";

export const INTERNAL_TOKEN_HEADER = "X-Internal-Token";

let idTokens: IdTokenProvider | null = config.aiServiceIdTokenAudience
  ? createIdTokenProvider(config.aiServiceIdTokenAudience)
  : null;

/** Replace the ID token provider (tests); null sends no ID token. */
export function setIdTokenProvider(provider: IdTokenProvider | null): void {
  idTokens = provider;
}

/** The ai-service couldn't be authenticated to (no ID token). */
export class AiServiceAuthError extends Error {
  constructor() {
    super("could not get an ID token for the ai-service");
    this.name = "AiServiceAuthError";
  }
}

/** Absolute ai-service URL for a path such as "/quotes". */
export function aiServiceUrl(path: string): URL {
  return new URL(path, config.aiServiceUrl);
}

/** fetch() against the ai-service with the internal token (and ID token) attached. */
export async function aiServiceFetch(
  url: URL,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set(INTERNAL_TOKEN_HEADER, config.aiServiceInternalToken);
  if (idTokens) {
    let token: string;
    try {
      token = await idTokens.getToken();
    } catch (error) {
      logger.error({ err: error }, "could not get an ID token for the ai-service");
      throw new AiServiceAuthError();
    }
    headers.set("Authorization", `Bearer ${token}`);
  } else {
    // Never forward a caller's Authorization header to the ai-service.
    headers.delete("Authorization");
  }
  return fetch(url, { ...init, headers });
}
