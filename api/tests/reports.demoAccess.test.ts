import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

// Demo report access end to end through the api: the real report service
// behind real routes, with only the database and token check mocked.
vi.mock("../src/db/prisma.js", () => ({
  prisma: {
    ragTicker: { findUnique: vi.fn(), findMany: vi.fn() },
    researchReport: { findMany: vi.fn(), findUnique: vi.fn() },
    chatUsageEvent: { count: vi.fn(), aggregate: vi.fn() },
  },
}));
vi.mock("../src/auth/verifyToken.js", () => ({ verifySupabaseToken: vi.fn() }));

import { createApp } from "../src/app.js";
import { verifySupabaseToken } from "../src/auth/verifyToken.js";
import { prisma } from "../src/db/prisma.js";
import { reportContent } from "./reportFixtures.js";

const app = createApp();
const db = vi.mocked(prisma, true);
const USER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function ticker(symbol: string) {
  return {
    ticker: symbol,
    companyName: `${symbol} Inc`,
    status: "indexed",
    chunkCount: 100,
    quarters: ["FY2027Q2", "FY2027Q1"],
    lastError: null,
    lastJobId: null,
    indexedAt: new Date("2026-10-01"),
    latestCallDate: new Date("2026-08-26"),
    freshnessCheckedAt: null,
    createdAt: new Date("2026-10-01"),
    updatedAt: new Date("2026-10-01"),
  } as never;
}

function report(symbol: string) {
  return {
    id: `r-${symbol}`,
    ticker: symbol,
    fiscalYear: 2027,
    fiscalQuarter: 2,
    companyName: `${symbol} Inc`,
    content: reportContent(),
    generatedAt: new Date("2026-10-05"),
    generatingSince: null,
    generationId: null,
    traceId: null,
    createdAt: new Date("2026-10-05"),
    updatedAt: new Date("2026-10-05"),
  } as never;
}

const get = (path: string) =>
  request(app).get(path).set("Authorization", "Bearer test-token");

function signIn(isAnonymous: boolean) {
  vi.mocked(verifySupabaseToken).mockResolvedValue({ userId: USER, isAnonymous });
}

beforeEach(() => {
  vi.clearAllMocks();
  db.ragTicker.findUnique.mockImplementation((async ({ where }: never) =>
    ticker((where as { ticker: string }).ticker)) as never);
  db.researchReport.findMany.mockImplementation((async ({ where }: never) => [
    report((where as { ticker: string }).ticker),
  ]) as never);
  db.chatUsageEvent.count.mockResolvedValue(0);
  db.chatUsageEvent.aggregate.mockResolvedValue({ _sum: { weight: 0 } } as never);
});

describe("demo users", () => {
  beforeEach(() => signIn(true));

  it("can view a report on the demo list", async () => {
    const res = await get("/api/reports/AAPL");

    expect(res.status).toBe(200);
    expect(res.body.report).not.toBeNull();
    expect(res.body.blockedReason).toBe("demo");
  });

  it("get a 403 for any other report, and nothing is read", async () => {
    const res = await get("/api/reports/COST");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: "demo_report_locked",
      message: "Sign up to view or generate this report.",
    });
    expect(db.ragTicker.findUnique).not.toHaveBeenCalled();
    expect(db.researchReport.findMany).not.toHaveBeenCalled();
  });

  it("still can't generate, on the list or off it", async () => {
    for (const symbol of ["AAPL", "COST"]) {
      const res = await request(app)
        .post(`/api/reports/${symbol}`)
        .set("Authorization", "Bearer test-token");
      expect(res.status).toBe(403);
    }
  });

  it("see every company, with the locked ones marked", async () => {
    db.ragTicker.findMany.mockResolvedValue([ticker("AAPL"), ticker("COST")]);
    db.researchReport.findMany.mockResolvedValue([report("AAPL"), report("COST")]);

    const res = await get("/api/reports");

    expect(res.status).toBe(200);
    expect(
      res.body.tickers.map((t: { ticker: string; demoLocked: boolean }) => [
        t.ticker,
        t.demoLocked,
      ]),
    ).toEqual([
      ["AAPL", false],
      ["COST", true],
    ]);
  });
});

describe("signed-in users", () => {
  beforeEach(() => signIn(false));

  it("can view any cached report, unchanged", async () => {
    const res = await get("/api/reports/COST");

    expect(res.status).toBe(200);
    expect(res.body.report).not.toBeNull();
    expect(res.body.usage).toMatchObject({ limit: 2, isDemo: false });
  });

  it("see nothing locked in the list", async () => {
    db.ragTicker.findMany.mockResolvedValue([ticker("AAPL"), ticker("COST")]);
    db.researchReport.findMany.mockResolvedValue([]);

    const res = await get("/api/reports");

    expect(res.body.tickers.every((t: { demoLocked: boolean }) => !t.demoLocked)).toBe(
      true,
    );
  });
});
