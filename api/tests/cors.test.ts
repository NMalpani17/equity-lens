import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

import { parseOrigins } from "../src/config.js";

describe("parseOrigins", () => {
  it("splits on commas, trims, drops empties and trailing slashes", () => {
    expect(
      parseOrigins(" https://equity-lens.vercel.app/ ,http://localhost:5173,, "),
    ).toEqual(["https://equity-lens.vercel.app", "http://localhost:5173"]);
    expect(parseOrigins("http://localhost:5173")).toEqual(["http://localhost:5173"]);
    expect(parseOrigins("")).toEqual([]);
  });
});

describe("CORS", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function appWithOrigins(value: string) {
    vi.stubEnv("CLIENT_ORIGIN", value);
    vi.resetModules();
    const { createApp } = await import("../src/app.js");
    return createApp();
  }

  it("allows each listed origin exactly and nothing else", async () => {
    const app = await appWithOrigins(
      "https://equity-lens.vercel.app, http://localhost:5173",
    );

    for (const origin of ["https://equity-lens.vercel.app", "http://localhost:5173"]) {
      const res = await request(app).get("/api/live").set("Origin", origin);
      expect(res.headers["access-control-allow-origin"]).toBe(origin);
    }
    for (const origin of [
      "https://evil.example",
      "https://preview.equity-lens.vercel.app",
      "https://equity-lens.vercel.app.evil.example",
    ]) {
      const res = await request(app).get("/api/live").set("Origin", origin);
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    }
  });

  it("never treats a wildcard entry as a pattern", async () => {
    const app = await appWithOrigins("*");

    const res = await request(app)
      .get("/api/live")
      .set("Origin", "https://evil.example");

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("answers preflight requests for an allowed origin", async () => {
    const app = await appWithOrigins("https://equity-lens.vercel.app");

    const res = await request(app)
      .options("/api/holdings")
      .set("Origin", "https://equity-lens.vercel.app")
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "authorization,content-type");

    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(
      "https://equity-lens.vercel.app",
    );
  });
});
