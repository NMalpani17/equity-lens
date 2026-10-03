import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

import { createApp } from "../src/app.js";
import {
  WARMUP_REUSE_MS,
  WARMUP_TIMEOUT_MS,
  resetWarmup,
  warmAiService,
} from "../src/services/aiService.js";

const app = createApp();

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

beforeEach(() => resetWarmup());
afterEach(() => vi.restoreAllMocks());

describe("POST /api/warmup", () => {
  it("pings the ai-service health with a cold-start timeout", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(healthy());

    const res = await request(app).post("/api/warmup");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ aiService: "ok" });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe("http://localhost:8000/health");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(WARMUP_TIMEOUT_MS).toBeGreaterThanOrEqual(15_000);
  });

  it("answers 200 'waking' (never an error) when the ai-service isn't up yet", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    const res = await request(app).post("/api/warmup");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ aiService: "waking" });
  });

  it("needs no authentication", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(healthy());

    const res = await request(app).post("/api/warmup");

    expect(res.status).toBe(200);
  });
});

describe("warmAiService", () => {
  it("shares one ping between concurrent page loads", async () => {
    let answer: (r: Response) => void = () => {};
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockReturnValue(new Promise<Response>((resolve) => (answer = resolve)));

    const both = Promise.all([warmAiService(), warmAiService()]);
    answer(healthy());

    expect((await both).map((h) => h.status)).toEqual(["ok", "ok"]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("reuses a recent success and pings again after it expires", async () => {
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
