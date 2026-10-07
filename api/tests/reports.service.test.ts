import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/db/prisma.js", () => {
  const usage = {
    count: vi.fn(),
    aggregate: vi.fn(),
    create: vi.fn(),
    deleteMany: vi.fn(),
  };
  return {
    prisma: {
      ragTicker: { findUnique: vi.fn(), findMany: vi.fn() },
      researchReport: { findMany: vi.fn(), findUnique: vi.fn() },
      chatUsageEvent: usage,
      $executeRaw: vi.fn(),
      $transaction: vi.fn(),
    },
  };
});

import { prisma } from "../src/db/prisma.js";
import {
  ForbiddenError,
  NotFoundError,
  ReportConflictError,
  ReportLimitError,
} from "../src/errors.js";
import {
  getReport,
  getReportUsage,
  latestIndexedQuarter,
  listReports,
  parseQuarterLabel,
  refundGeneration,
  startGeneration,
} from "../src/services/reports.service.js";
import { reportContent } from "./reportFixtures.js";

const db = vi.mocked(prisma, true);
const USER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const NOW = new Date("2026-10-07T15:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function ticker(overrides: Record<string, unknown> = {}) {
  return {
    ticker: "NVDA",
    companyName: "Nvidia Corp",
    status: "indexed",
    chunkCount: 205,
    quarters: ["FY2027Q2", "FY2027Q1"],
    lastError: null,
    lastJobId: null,
    indexedAt: new Date("2026-10-01"),
    latestCallDate: new Date("2026-08-26"),
    freshnessCheckedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as never;
}

function report(overrides: Record<string, unknown> = {}) {
  return {
    id: "r1",
    ticker: "NVDA",
    fiscalYear: 2027,
    fiscalQuarter: 2,
    companyName: "Nvidia Corp",
    content: reportContent(),
    generatedAt: new Date(NOW.getTime() - 2 * DAY),
    generatingSince: null,
    generationId: null,
    traceId: "t1",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as never;
}

function usage(reportsToday: number, globalUnits: number) {
  db.chatUsageEvent.count.mockResolvedValue(reportsToday);
  db.chatUsageEvent.aggregate.mockResolvedValue({
    _sum: { weight: globalUnits },
  } as never);
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  vi.clearAllMocks();
  db.$transaction.mockImplementation(((fn: (tx: unknown) => unknown) =>
    fn(prisma)) as never);
  usage(0, 0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("quarters", () => {
  it("parses indexed quarter labels and needs a searchable ticker", () => {
    expect(parseQuarterLabel("FY2027Q2")).toEqual({
      fiscalYear: 2027,
      fiscalQuarter: 2,
      label: "Q2 FY2027",
    });
    expect(parseQuarterLabel("2027-Q2")).toBeNull();
    expect(latestIndexedQuarter(ticker())?.label).toBe("Q2 FY2027");
    expect(
      latestIndexedQuarter(ticker({ status: "failed", indexedAt: null })),
    ).toBeNull();
    expect(latestIndexedQuarter(ticker({ quarters: [] }))).toBeNull();
  });
});

describe("listReports", () => {
  it("lists indexed tickers with their newest report, current or outdated", async () => {
    db.ragTicker.findMany.mockResolvedValue([
      ticker(),
      ticker({ ticker: "AAPL", companyName: "Apple Inc.", quarters: ["FY2026Q4"] }),
      ticker({ ticker: "MSFT", companyName: null, quarters: ["FY2026Q4"] }),
    ]);
    db.researchReport.findMany.mockResolvedValue([
      report(),
      // AAPL: only an older quarter's report, so it's outdated.
      report({ ticker: "AAPL", fiscalYear: 2026, fiscalQuarter: 3 }),
      // MSFT: the current quarter is being generated, never finished.
      report({
        ticker: "MSFT",
        fiscalYear: 2026,
        fiscalQuarter: 4,
        generatedAt: null,
        generatingSince: new Date(NOW.getTime() - 60_000),
        generationId: "g1",
      }),
    ]);

    const items = await listReports();

    expect(
      items.map((i) => [i.ticker, i.report?.outdated ?? null, i.generating]),
    ).toEqual([
      ["NVDA", false, false],
      ["AAPL", true, false],
      ["MSFT", null, true],
    ]);
    expect(items[2]!.companyName).toBe("MSFT");
    // Report content is never loaded for the list.
    expect(db.researchReport.findMany.mock.calls[0]![0]).toMatchObject({
      select: { ticker: true, generatedAt: true },
    });
  });
});

describe("getReport", () => {
  it("returns the current report as a DTO and lets a user generate when allowed", async () => {
    db.ragTicker.findUnique.mockResolvedValue(ticker());
    db.researchReport.findMany.mockResolvedValue([
      report({ generatedAt: new Date(NOW.getTime() - 8 * DAY) }),
    ]);

    const view = await getReport("NVDA", USER, false);

    expect(view.report).toMatchObject({
      ticker: "NVDA",
      companyName: "Nvidia Corp",
      quarter: { label: "Q2 FY2027", callDate: "2026-08-26" },
      priorQuarter: { label: "Q1 FY2027" },
      citations: [{ id: 1, companyName: "Nvidia Corp", fiscalQuarter: 2 }],
      dataSources: [{ id: "D2", asOf: "2026-10-06" }],
      asOf: { latestCall: "2026-08-26" },
    });
    expect(view.report).not.toHaveProperty("agents"); // internal stats stay internal
    expect(view).toMatchObject({
      outdated: false,
      generating: false,
      canGenerate: true,
      blockedReason: null,
      regenerateAvailableAt: null,
      usage: { used: 0, limit: 2, remaining: 2, isDemo: false },
    });
  });

  it("shows an outdated report until the newest quarter has one", async () => {
    db.ragTicker.findUnique.mockResolvedValue(
      ticker({ quarters: ["FY2027Q3", "FY2027Q2"] }),
    );
    db.researchReport.findMany.mockResolvedValue([report()]);

    const view = await getReport("NVDA", USER, false);

    expect(view.latestQuarter.label).toBe("Q3 FY2027");
    expect(view.report?.quarter.label).toBe("Q2 FY2027");
    expect(view).toMatchObject({ outdated: true, canGenerate: true });
  });

  it.each([
    ["demo", true, report(), 0, 0],
    [
      "in_progress",
      false,
      report({ generatingSince: new Date(NOW.getTime() - 60_000), generationId: "g" }),
      0,
      0,
    ],
    ["fresh", false, report(), 0, 0],
    [
      "daily_limit",
      false,
      report({ generatedAt: new Date(NOW.getTime() - 8 * DAY) }),
      2,
      0,
    ],
    [
      "global_limit",
      false,
      report({ generatedAt: new Date(NOW.getTime() - 8 * DAY) }),
      0,
      58,
    ],
  ])("blocks generating when %s", async (reason, isDemo, row, used, globalUnits) => {
    db.ragTicker.findUnique.mockResolvedValue(ticker());
    db.researchReport.findMany.mockResolvedValue([row]);
    usage(used, globalUnits);

    const view = await getReport("NVDA", USER, isDemo);

    expect(view).toMatchObject({ canGenerate: false, blockedReason: reason });
    if (reason === "fresh") {
      expect(view.regenerateAvailableAt).toBe(
        new Date(NOW.getTime() + 5 * DAY).toISOString(),
      );
    }
  });

  it("treats a stale generation as not running", async () => {
    db.ragTicker.findUnique.mockResolvedValue(ticker());
    db.researchReport.findMany.mockResolvedValue([
      report({
        generatedAt: null,
        content: null,
        generatingSince: new Date(NOW.getTime() - 11 * 60_000),
        generationId: "dead",
      }),
    ]);

    const view = await getReport("NVDA", USER, false);

    expect(view).toMatchObject({ report: null, generating: false, canGenerate: true });
  });

  it("hides stored content that doesn't match the expected shape", async () => {
    db.ragTicker.findUnique.mockResolvedValue(ticker());
    db.researchReport.findMany.mockResolvedValue([report({ content: { version: 2 } })]);

    expect((await getReport("NVDA", USER, false)).report).toBeNull();
  });

  it("is a 404 for a ticker that isn't indexed", async () => {
    db.ragTicker.findUnique.mockResolvedValue(null);

    await expect(getReport("ZZZZ", USER, false)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("usage", () => {
  it("counts only report events today; demo users have no allowance", async () => {
    usage(1, 0);

    expect(await getReportUsage(USER, false)).toMatchObject({ used: 1, remaining: 1 });
    expect(db.chatUsageEvent.count.mock.calls[0]![0]!.where).toMatchObject({
      userId: USER,
      kind: { in: ["report"] },
      createdAt: { gte: new Date("2026-10-07T00:00:00.000Z") },
    });
    expect(await getReportUsage(USER, true)).toMatchObject({ limit: 0, isDemo: true });
  });
});

describe("startGeneration", () => {
  beforeEach(() => {
    db.ragTicker.findUnique.mockResolvedValue(ticker());
    db.researchReport.findUnique.mockResolvedValue(null);
    db.chatUsageEvent.create.mockResolvedValue({ id: "ev-1" } as never);
  });

  it("records a report usage event weighing 3 under the usage lock", async () => {
    usage(1, 57);

    const start = await startGeneration(USER, false, "NVDA");

    expect(start).toEqual({
      usageEventId: "ev-1",
      latestQuarter: { fiscalYear: 2027, fiscalQuarter: 2, label: "Q2 FY2027" },
      regenerateAfterDays: 7,
    });
    expect(db.$executeRaw).toHaveBeenCalledTimes(1); // pg_advisory_xact_lock
    expect(db.chatUsageEvent.create).toHaveBeenCalledWith({
      data: { userId: USER, kind: "report", weight: 3 },
    });
  });

  it("refuses demo users and unindexed tickers before anything else", async () => {
    await expect(startGeneration(USER, true, "NVDA")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    db.ragTicker.findUnique.mockResolvedValueOnce(null);
    await expect(startGeneration(USER, false, "ZZZZ")).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(db.chatUsageEvent.create).not.toHaveBeenCalled();
  });

  it("refuses while generating and while the current report is fresh", async () => {
    db.researchReport.findUnique.mockResolvedValueOnce(
      report({ generatingSince: new Date(NOW.getTime() - 60_000), generationId: "g" }),
    );
    await expect(startGeneration(USER, false, "NVDA")).rejects.toMatchObject({
      status: 409,
      code: "report_in_progress",
    });

    db.researchReport.findUnique.mockResolvedValueOnce(report());
    const fresh = await startGeneration(USER, false, "NVDA").catch((e: unknown) => e);
    expect(fresh).toBeInstanceOf(ReportConflictError);
    expect(fresh).toMatchObject({
      code: "report_fresh",
      details: {
        regenerateAvailableAt: new Date(NOW.getTime() + 5 * DAY).toISOString(),
      },
    });
    expect(db.chatUsageEvent.create).not.toHaveBeenCalled();
  });

  it("allows regenerating a report older than 7 days", async () => {
    db.researchReport.findUnique.mockResolvedValueOnce(
      report({ generatedAt: new Date(NOW.getTime() - 7 * DAY - 1000) }),
    );

    await expect(startGeneration(USER, false, "NVDA")).resolves.toMatchObject({
      usageEventId: "ev-1",
    });
  });

  it("enforces 2 reports per user per day", async () => {
    usage(2, 0);

    const error = await startGeneration(USER, false, "NVDA").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ReportLimitError);
    expect(error).toMatchObject({ status: 429, details: { scope: "user", limit: 2 } });
    expect(db.chatUsageEvent.create).not.toHaveBeenCalled();
  });

  it("needs 3 free units of the global daily cap", async () => {
    usage(0, 58); // 58 + 3 > 60

    await expect(startGeneration(USER, false, "NVDA")).rejects.toMatchObject({
      code: "report_limit_reached",
      details: { scope: "global", limit: 60 },
    });
  });
});

describe("refundGeneration", () => {
  it("deletes the usage event and never throws", async () => {
    await refundGeneration("ev-1");
    expect(db.chatUsageEvent.deleteMany).toHaveBeenCalledWith({
      where: { id: "ev-1" },
    });

    db.chatUsageEvent.deleteMany.mockRejectedValueOnce(new Error("db down"));
    await expect(refundGeneration("ev-2")).resolves.toBeUndefined();
  });
});
