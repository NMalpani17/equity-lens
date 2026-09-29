import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";

// Mock token verification so the middleware can be tested without contacting
// Supabase's JWKS endpoint.
vi.mock("../src/auth/verifyToken.js", () => ({
  verifySupabaseToken: vi.fn(),
}));

import { verifySupabaseToken } from "../src/auth/verifyToken.js";
import { getUserId, isAnonymousRequest, requireAuth } from "../src/middleware/auth.js";
import { UnauthorizedError } from "../src/errors.js";

const verifyTokenMock = vi.mocked(verifySupabaseToken);

const USER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function makeReq(authorization?: string): Request {
  return { headers: authorization ? { authorization } : {} } as Request;
}

function makeNext(): NextFunction & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  const next = ((...args: unknown[]) => {
    calls.push(args);
  }) as NextFunction & { calls: unknown[][] };
  next.calls = calls;
  return next;
}

const res = {} as Response;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("requireAuth", () => {
  it("accepts a valid bearer token and sets req.userId", async () => {
    verifyTokenMock.mockResolvedValue({ userId: USER_ID, isAnonymous: false });
    const req = makeReq("Bearer valid-token");
    const next = makeNext();

    await requireAuth(req, res, next);

    expect(verifyTokenMock).toHaveBeenCalledWith("valid-token");
    expect(req.userId).toBe(USER_ID);
    expect(req.isAnonymous).toBe(false);
    // next() called with no error argument.
    expect(next.calls).toEqual([[]]);
  });

  it("flags anonymous demo users via req.isAnonymous", async () => {
    verifyTokenMock.mockResolvedValue({ userId: USER_ID, isAnonymous: true });
    const req = makeReq("Bearer demo-token");
    const next = makeNext();

    await requireAuth(req, res, next);

    expect(req.isAnonymous).toBe(true);
    expect(isAnonymousRequest(req)).toBe(true);
  });

  it("rejects a request with no Authorization header (401)", async () => {
    const req = makeReq();
    const next = makeNext();

    await requireAuth(req, res, next);

    expect(verifyTokenMock).not.toHaveBeenCalled();
    expect(req.userId).toBeUndefined();
    expect(next.calls[0]![0]).toBeInstanceOf(UnauthorizedError);
  });

  it("rejects a malformed Authorization header (non-Bearer scheme)", async () => {
    const req = makeReq("Basic abc123");
    const next = makeNext();

    await requireAuth(req, res, next);

    expect(verifyTokenMock).not.toHaveBeenCalled();
    expect(next.calls[0]![0]).toBeInstanceOf(UnauthorizedError);
  });

  it("rejects an invalid or expired token (401)", async () => {
    verifyTokenMock.mockRejectedValue(new Error("signature verification failed"));
    const req = makeReq("Bearer bad-token");
    const next = makeNext();

    await requireAuth(req, res, next);

    expect(req.userId).toBeUndefined();
    expect(next.calls[0]![0]).toBeInstanceOf(UnauthorizedError);
  });
});

describe("getUserId", () => {
  it("returns the id set by requireAuth", () => {
    const req = { userId: USER_ID } as Request;
    expect(getUserId(req)).toBe(USER_ID);
  });

  it("throws when no user id is present (route not guarded)", () => {
    const req = {} as Request;
    expect(() => getUserId(req)).toThrow(UnauthorizedError);
  });
});
