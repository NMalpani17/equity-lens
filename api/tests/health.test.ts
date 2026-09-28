import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

import { createApp } from "../src/app.js";

const app = createApp();

describe("GET /api/health", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 200 and ok when the AI service is healthy", async () => {
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

    const res = await request(app).get("/api/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.dependencies.aiService.status).toBe("ok");
  });

  it("returns 503 and degraded when the AI service is unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    const res = await request(app).get("/api/health");

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("degraded");
    expect(res.body.dependencies.aiService.status).toBe("unreachable");
  });
});
