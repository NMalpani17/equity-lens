/**
 * Helpers for the auth params Supabase appends to the URL hash on redirect.
 *
 * A valid recovery link's tokens are consumed by supabase-js automatically; an
 * expired or already-used link instead leaves an error, e.g.
 * `#error=access_denied&error_code=otp_expired&error_description=...`.
 */

/** True when the URL hash carries a Supabase auth error. */
export function hashHasAuthError(hash: string): boolean {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  return params.has("error") || params.has("error_code");
}
