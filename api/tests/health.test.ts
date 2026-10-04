import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

vi.mock("../src/auth/verifyToken.js", () => ({ verifySupabaseToken: vi.fn() }));

import { createApp } from "../src/app.js";
import { verifySupabaseToken } from "../src/auth/verifyToken.js";

const app = createApp();
const verify = vi.mocked(verifySupabaseToken);

beforeEach(() => {
  verify.mockReset();
  verify.mockImplementation(async (token: string) => {
    if (token !== "valid-token") throw new Error("invalid token");
    return { userId: "user-1", isAnonymous: false };
  });
});

/** GET /api/health as a signed-in user. */
const signedIn = () =>
  request(app).get("/api/health").set("Authorization", "Bearer valid-token");

describe("GET /api/health", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("gives anonymous callers only the API's status, without pinging the AI service", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("down"));

    const res = await request(app).get("/api/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "ok",
      service: "equity-lens-api",
      version: "0.1.0",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("treats an invalid token like no token (no AI service ping)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("down"));

    const res = await request(app)
      .get("/api/health")
      .set("Authorization", "Bearer forged");

    expect(res.status).toBe(200);
    expect(res.body.dependencies).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("checks the AI service for anonymous demo users too", async () => {
    verify.mockResolvedValue({ userId: "demo-1", isAnonymous: true });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("down"));

    const res = await signedIn();

    expect(res.status).toBe(503);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("returns 200 and ok to a signed-in user when the AI service is healthy", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "ok",
          service: "equity-lens-ai-service",
          version: "0.1.0",
          environment: "test",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const res = await signedIn();

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.dependencies.aiService.status).toBe("ok");
  });

  it("returns 503 and degraded to a signed-in user when the AI service is unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    const res = await signedIn();

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("degraded");
    expect(res.body.dependencies.aiService.status).toBe("unreachable");
  });
});

describe("GET /api/live", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 200 without calling the AI service, even when it is down", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("ECONNREFUSED"));

    const res = await request(app).get("/api/live");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", service: "equity-lens-api" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
