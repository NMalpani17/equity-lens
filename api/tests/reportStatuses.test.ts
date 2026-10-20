import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/db/prisma.js", () => ({
  prisma: {
    ragTicker: { findMany: vi.fn() },
    researchReport: { findMany: vi.fn() },
  },
}));

import { prisma } from "../src/db/prisma.js";
import { reportStatuses } from "../src/services/reports.service.js";

const mockPrisma = vi.mocked(prisma, true);

function indexed(ticker: string, quarters: string[]) {
  return {
    ticker,
    companyName: null,
    status: "indexed",
    chunkCount: 10,
    quarters,
    lastError: null,
    lastJobId: null,
    indexedAt: new Date("2026-10-01T00:00:00.000Z"),
    latestCallDate: null,
    freshnessCheckedAt: null,
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
    updatedAt: new Date("2026-10-01T00:00:00.000Z"),
  };
}

function generated(ticker: string, fiscalYear: number, fiscalQuarter: number) {
  return {
    ticker,
    fiscalYear,
    fiscalQuarter,
    generatedAt: new Date("2026-10-10T00:00:00.000Z"),
    generatingSince: null,
    generationId: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.ragTicker.findMany.mockResolvedValue([
    indexed("AMD", ["FY2026Q3", "FY2026Q2"]),
    indexed("JPM", ["FY2026Q3", "FY2026Q2"]),
    indexed("NVDA", ["FY2027Q2", "FY2027Q1"]),
    indexed("TSLA", ["FY2026Q3"]),
  ] as never);
  mockPrisma.researchReport.findMany.mockResolvedValue([
    generated("AMD", 2026, 3), // current quarter
    generated("AMD", 2026, 2),
    generated("JPM", 2026, 2), // an older quarter than the newest call
    generated("NVDA", 2027, 2),
    generated("ORCL", 2026, 1), // a report, but no indexed call
  ] as never);
});

describe("reportStatuses", () => {
  it("is ready, outdated or none by the Reports page's rules", async () => {
    const statuses = await reportStatuses(["AMD", "JPM", "TSLA", "ORCL", "VOO"], false);

    expect(statuses.get("AMD")?.status).toBe("ready");
    expect(statuses.get("JPM")?.status).toBe("outdated");
    expect(statuses.get("TSLA")?.status).toBe("none"); // indexed, never generated
    expect(statuses.get("ORCL")?.status).toBe("none"); // nothing to show
    expect(statuses.get("VOO")?.status).toBe("none");
  });

  it("only reads generated reports", async () => {
    await reportStatuses(["AMD"], false);

    expect(mockPrisma.researchReport.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { ticker: { in: ["AMD"] }, generatedAt: { not: null } },
      }),
    );
  });

  it("locks reports outside the demo list for demo users only", async () => {
    const demo = await reportStatuses(["AMD", "JPM", "ORCL"], true);
    const signedIn = await reportStatuses(["AMD", "JPM", "ORCL"], false);

    expect(demo.get("AMD")?.demoLocked).toBe(false);
    expect(demo.get("JPM")?.demoLocked).toBe(false);
    expect(demo.get("ORCL")?.demoLocked).toBe(true);
    expect([...signedIn.values()].every((s) => !s.demoLocked)).toBe(true);
  });

  it("skips the queries for no tickers", async () => {
    expect((await reportStatuses([], true)).size).toBe(0);
    expect(mockPrisma.ragTicker.findMany).not.toHaveBeenCalled();
  });
});
