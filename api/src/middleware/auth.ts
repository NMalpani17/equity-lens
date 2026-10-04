/**
 * Authentication middleware. Verifies the Supabase JWT sent as a bearer token
 * and attaches the resulting user id to the request. Protected routes mount
 * `requireAuth`; controllers read the id via `getUserId`.
 */
import type { NextFunction, Request, Response } from "express";

import { UnauthorizedError } from "../errors.js";
import { logger } from "../logger.js";
import { verifySupabaseToken } from "../auth/verifyToken.js";

/** Extract a bearer token from an Authorization header, or null when absent. */
function bearerToken(header: string | undefined): string | null {
  if (!header) {
    return null;
  }
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return null;
  }
  return token;
}

/**
 * Require a valid Supabase access token. On success attaches `req.userId` and
 * continues; otherwise forwards a 401 to the error handler.
 */
export async function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const token = bearerToken(req.headers.authorization);
  if (!token) {
    next(new UnauthorizedError("missing bearer token"));
    return;
  }

  try {
    const { userId, isAnonymous } = await verifySupabaseToken(token);
    req.userId = userId;
    req.isAnonymous = isAnonymous;
    next();
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.message : error },
      "token verification failed",
    );
    next(new UnauthorizedError("invalid or expired token"));
  }
}

/**
 * Identify the user when a valid token is present, but never reject: requests
 * without a token, or with an invalid one, continue unauthenticated (no
 * `req.userId`). For public routes that reveal more to signed-in users.
 */
export async function optionalAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const token = bearerToken(req.headers.authorization);
  if (token) {
    try {
      const { userId, isAnonymous } = await verifySupabaseToken(token);
      req.userId = userId;
      req.isAnonymous = isAnonymous;
    } catch (error) {
      logger.debug(
        { err: error instanceof Error ? error.message : error },
        "optional auth: ignoring invalid token",
      );
    }
  }
  next();
}

/**
 * Read the authenticated user id from a request. Throws if it is missing, which
 * indicates a route was not guarded by `requireAuth` (a programming error).
 */
export function getUserId(req: Request): string {
  if (!req.userId) {
    throw new UnauthorizedError();
  }
  return req.userId;
}

/** Whether the request is from an anonymous demo user (set by `requireAuth`). */
export function isAnonymousRequest(req: Request): boolean {
  return req.isAnonymous === true;
}
