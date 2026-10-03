import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

vi.mock("../src/auth/verifyToken.js", () => ({ verifySupabaseToken: vi.fn() }));

import { createApp } from "../src/app.js";
import { verifySupabaseToken } from "../src/auth/verifyToken.js";
import {
  WARMUP_REUSE_MS,
  WARMUP_TIMEOUT_MS,
  resetWarmup,
  warmAiService,
} from "../src/services/aiService.js";
import { createKeyedRateLimiter } from "../src/services/rateLimit.js";

const app = createApp();
const verify = vi.mocked(verifySupabaseToken);

function healthy() {
  return new Response(
    JSON.stringify({
      status: "ok",
      service: "equity-lens-ai-service",
      version: "0.1.0",
      environment: "test",
    }),
    { status: 200 },
  );
}

/** Signed in as `user` (a real or anonymous demo account). */
function warmup(user = "user-1") {
  verify.mockImplementation(async (token: string) => ({
    userId: token.replace("token-", ""),
    isAnonymous: token.includes("demo"),
  }));
  return request(app).post("/api/warmup").set("Authorization", `Bearer token-${user}`);
}

beforeEach(() => {
  resetWarmup();
  vi.clearAllMocks();
});
afterEach(() => vi.restoreAllMocks());

describe("POST /api/warmup", () => {
  it("requires a session", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(healthy());

    const res = await request(app).post("/api/warmup");

    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects an invalid token", async () => {
    verify.mockRejectedValue(new Error("bad signature"));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(healthy());

    const res = await request(app)
      .post("/api/warmup")
      .set("Authorization", "Bearer forged");

    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("pings the ai-service health with a cold-start timeout for a signed-in user", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(healthy());

    const res = await warmup("user-1");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ aiService: "ok" });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe("http://localhost:8000/health");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(WARMUP_TIMEOUT_MS).toBeGreaterThanOrEqual(15_000);
  });

  it("works for anonymous demo users too", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(healthy());

    const res = await warmup("demo-7");

    expect(res.status).toBe(200);
  });

  it("answers 200 'waking' (never an error) when the ai-service isn't up yet", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    const res = await warmup();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ aiService: "waking" });
  });

  it("limits each user to one warm-up per minute", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(healthy());

    expect((await warmup("user-1")).status).toBe(200);
    const again = await warmup("user-1");
    const otherUser = await warmup("user-2");

    expect(again.status).toBe(429);
    expect(again.body).toMatchObject({ error: "warmup_rate_limited" });
    expect(Number(again.headers["retry-after"])).toBeGreaterThan(0);
    expect(Number(again.headers["retry-after"])).toBeLessThanOrEqual(60);
    expect(otherUser.status).toBe(200);
  });
});

describe("createKeyedRateLimiter", () => {
  it("allows one attempt per key per window", () => {
    let clock = 0;
    const limiter = createKeyedRateLimiter(60_000, () => clock);

    expect(limiter.take("a")).toBe(0);
    clock = 59_000;
    expect(limiter.take("a")).toBe(1_000);
    expect(limiter.take("b")).toBe(0);
    clock = 60_000;
    expect(limiter.take("a")).toBe(0);
  });
});

describe("warmAiService", () => {
  it("shares one ping between concurrent warm-ups", async () => {
    let answer: (r: Response) => void = () => {};
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockReturnValue(new Promise<Response>((resolve) => (answer = resolve)));

    const both = Promise.all([warmAiService(), warmAiService()]);
    answer(healthy());

    expect((await both).map((h) => h.status)).toEqual(["ok", "ok"]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("reuses a recent success for 60s, then pings again", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => healthy());
    let clock = 1_000_000;
    const now = () => clock;

    await warmAiService(now);
    clock += WARMUP_REUSE_MS - 1;
    await warmAiService(now);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    clock += 2;
    await warmAiService(now);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("doesn't cache a failed ping", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockImplementation(async () => healthy());

    expect((await warmAiService()).status).toBe("unreachable");
    expect((await warmAiService()).status).toBe("ok");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
