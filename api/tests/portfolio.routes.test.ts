import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

// Mock the service layer so route tests exercise validation and status codes
// without a database or the ai-service.
vi.mock("../src/services/performance.service.js", () => ({
  getPortfolioPerformance: vi.fn(),
}));
vi.mock("../src/services/portfolio.service.js", () => ({
  getPortfolioSummary: vi.fn(),
}));
vi.mock("../src/services/holdings.service.js", () => ({
  ensureDemoHoldings: vi.fn(),
}));
vi.mock("../src/auth/verifyToken.js", () => ({
  verifySupabaseToken: vi.fn(),
}));

import { createApp } from "../src/app.js";
import { getPortfolioPerformance } from "../src/services/performance.service.js";
import { ensureDemoHoldings } from "../src/services/holdings.service.js";
import { verifySupabaseToken } from "../src/auth/verifyToken.js";
import { UpstreamError } from "../src/errors.js";
import type { PortfolioPerformance } from "../src/types.js";

const app = createApp();
const performanceMock = vi.mocked(getPortfolioPerformance);
const verifyTokenMock = vi.mocked(verifySupabaseToken);

const USER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const get = (path: string) =>
  request(app).get(path).set("Authorization", "Bearer test-token");

const performance: PortfolioPerformance = {
  range: "1Y",
  status: "empty",
  benchmark: { ticker: "SPY", available: false },
  startDate: null,
  endDate: null,
  startClamped: false,
  portfolioReturnPercent: null,
  benchmarkReturnPercent: null,
  points: [],
  excluded: [],
  lotsWithoutDate: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  verifyTokenMock.mockResolvedValue({ userId: USER_ID, isAnonymous: false });
  performanceMock.mockResolvedValue({ ...performance });
});

describe("GET /api/portfolio/performance", () => {
  it("defaults to the 1Y range", async () => {
    const res = await get("/api/portfolio/performance");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("empty");
    expect(performanceMock).toHaveBeenCalledWith(USER_ID, "1Y");
    expect(ensureDemoHoldings).not.toHaveBeenCalled();
  });

  it("accepts a range in any case", async () => {
    await get("/api/portfolio/performance?range=all");

    expect(performanceMock).toHaveBeenCalledWith(USER_ID, "ALL");
  });

  it("returns 422 for an unknown range", async () => {
    const res = await get("/api/portfolio/performance?range=5Y");

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("validation_error");
    expect(performanceMock).not.toHaveBeenCalled();
  });

  it("seeds the demo portfolio first for an anonymous user", async () => {
    verifyTokenMock.mockResolvedValue({ userId: USER_ID, isAnonymous: true });

    await get("/api/portfolio/performance?range=3M");

    expect(ensureDemoHoldings).toHaveBeenCalledWith(USER_ID);
  });

  it("returns 502 when price history is unavailable", async () => {
    performanceMock.mockRejectedValue(
      new UpstreamError("Price history is unavailable."),
    );

    const res = await get("/api/portfolio/performance");

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("upstream_error");
  });

  it("returns 401 without a token", async () => {
    const res = await request(app).get("/api/portfolio/performance");

    expect(res.status).toBe(401);
  });
});
