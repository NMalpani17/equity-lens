/**
 * Google ID tokens for calling the ai-service behind Cloud Run IAM.
 *
 * On Cloud Run the api's service account gets tokens from the metadata server
 * (google-auth-library, Application Default Credentials). A token is reused
 * until it nears expiry, concurrent callers share one fetch, and a fetch that
 * hangs gives up after FETCH_TIMEOUT_MS.
 */
import { GoogleAuth } from "google-auth-library";

/** Fetches an ID token for an audience. */
export type FetchIdToken = (audience: string) => Promise<string>;

export interface IdTokenProvider {
  /** A valid ID token (cached), or a rejection if one can't be fetched. */
  getToken(): Promise<string>;
}

/** Refresh this long before the token expires. */
export const REFRESH_MARGIN_MS = 5 * 60_000;
/** Assumed lifetime when the token's `exp` can't be read (Google: 1 hour). */
const FALLBACK_LIFETIME_MS = 55 * 60_000;
const FETCH_TIMEOUT_MS = 5000;

/** ID tokens from Application Default Credentials (the metadata server on Cloud Run). */
export function metadataIdTokenFetcher(): FetchIdToken {
  let auth: GoogleAuth | null = null;
  return async (audience) => {
    auth ??= new GoogleAuth();
    const client = await auth.getIdTokenClient(audience);
    return client.idTokenProvider.fetchIdToken(audience);
  };
}

/** The token's `exp` (ms since epoch), or null if it isn't a readable JWT. */
export function tokenExpiry(token: string): number | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const exp = (
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
        exp?: unknown;
      }
    ).exp;
    return typeof exp === "number" ? exp * 1000 : null;
  } catch {
    return null;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`ID token fetch timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function createIdTokenProvider(
  audience: string,
  fetchToken: FetchIdToken = metadataIdTokenFetcher(),
  now: () => number = Date.now,
): IdTokenProvider {
  let cached: { token: string; refreshAt: number } | null = null;
  let inflight: Promise<string> | null = null;
  return {
    getToken() {
      if (cached && now() < cached.refreshAt) return Promise.resolve(cached.token);
      inflight ??= withTimeout(fetchToken(audience), FETCH_TIMEOUT_MS)
        .then((token) => {
          const expiresAt = tokenExpiry(token) ?? now() + FALLBACK_LIFETIME_MS;
          cached = { token, refreshAt: expiresAt - REFRESH_MARGIN_MS };
          return token;
        })
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
  };
}
