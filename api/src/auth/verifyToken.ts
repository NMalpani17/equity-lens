/**
 * Verifies Supabase-issued access tokens against the project's JWKS.
 *
 * Supabase signs access tokens with asymmetric keys published at the project's
 * JWKS endpoint. `jose` fetches and caches that key set lazily and refetches it
 * automatically when it encounters an unknown key id (key rotation). We verify
 * the token's signature, issuer, and audience; downstream only needs the user
 * id (`sub`).
 */
import { createRemoteJWKSet, jwtVerify } from "jose";

import { config } from "../config.js";

// Supabase serves its auth endpoints (including JWKS) under `/auth/v1`.
const authBaseUrl = `${config.supabaseUrl}/auth/v1`;

// Remote key set, cached by jose across verifications.
const jwks = createRemoteJWKSet(new URL(`${authBaseUrl}/.well-known/jwks.json`));

export interface VerifiedUser {
  /** The authenticated user's id (the token's `sub` claim). */
  userId: string;
  /** True when the token belongs to an anonymous ("Try demo") user. */
  isAnonymous: boolean;
}

/**
 * Verify a Supabase access token and return the authenticated user. Throws when
 * the token is malformed, expired, or fails signature/claim verification.
 */
export async function verifySupabaseToken(token: string): Promise<VerifiedUser> {
  const { payload } = await jwtVerify(token, jwks, {
    issuer: authBaseUrl,
    audience: "authenticated",
  });

  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new Error("token is missing a subject (sub) claim");
  }

  // Supabase marks anonymous sign-ins with an `is_anonymous` claim.
  return { userId: payload.sub, isAnonymous: payload.is_anonymous === true };
}
