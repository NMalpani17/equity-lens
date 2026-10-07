/**
 * Usage accounting and report reads against a real Postgres (see
 * vitest.integration.config.ts). The unit tests mock Prisma, which is how a
 * `$queryRaw` of `pg_advisory_xact_lock` (a void column Prisma can't
 * deserialize) reached production; here every query really runs.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { reportContent } from "../reportFixtures.js";

const enabled = Boolean(process.env.API_TEST_DATABASE_URL);

describe.skipIf(!enabled)("usage and reports on real Postgres", () => {
  let prisma: typeof import("../../src/db/prisma.js").prisma;
  let reports: typeof import("../../src/services/reports.service.js");
  let chat: typeof import("../../src/services/chat.service.js");
  let errors: typeof import("../../src/errors.js");

  beforeAll(async () => {
    ({ prisma } = await import("../../src/db/prisma.js"));
    reports = await import("../../src/services/reports.service.js");
    chat = await import("../../src/services/chat.service.js");
    errors = await import("../../src/errors.js");
    await prisma.ragTicker.upsert({
      where: { ticker: "NVDA" },
      create: {
        ticker: "NVDA",
        companyName: "Nvidia Corp",
        status: "indexed",
        quarters: ["FY2027Q2", "FY2027Q1"],
        indexedAt: new Date(),
      },
      update: {},
    });
  });

  beforeEach(async () => {
    await prisma.chatUsageEvent.deleteMany({});
    await prisma.researchReport.deleteMany({});
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  const events = (userId: string) =>
    prisma.chatUsageEvent.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
    });

  it("takes the usage lock and records a report event weighing 3", async () => {
    const user = randomUUID();

    const start = await reports.startGeneration(user, false, "NVDA");

    expect(start.latestQuarter.label).toBe("Q2 FY2027");
    const rows = await events(user);
    expect(rows.map((r) => [r.kind, r.weight, r.id])).toEqual([
      ["report", 3, start.usageEventId],
    ]);
  });

  it("allows 2 reports per user per day; the third is refused", async () => {
    const user = randomUUID();
    await reports.startGeneration(user, false, "NVDA");
    await reports.startGeneration(user, false, "NVDA");

    const third = await reports
      .startGeneration(user, false, "NVDA")
      .catch((e: unknown) => e);

    expect(third).toBeInstanceOf(errors.ReportLimitError);
    expect(third).toMatchObject({ details: { scope: "user", limit: 2 } });
    expect(await events(user)).toHaveLength(2);
  });

  it("serializes concurrent starts so they can't all slip under the cap", async () => {
    const user = randomUUID();
    await reports.startGeneration(user, false, "NVDA"); // 1 of 2 used

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => reports.startGeneration(user, false, "NVDA")),
    );

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      results.filter(
        (r) => r.status === "rejected" && r.reason instanceof errors.ReportLimitError,
      ),
    ).toHaveLength(4);
    expect(await events(user)).toHaveLength(2);
  });

  it("needs 3 free units of the global cap, summing every event's weight", async () => {
    const others = Array.from({ length: 19 }, () => ({
      userId: randomUUID(),
      kind: "report",
      weight: 3,
    }));
    await prisma.chatUsageEvent.createMany({ data: others }); // 57 units
    await prisma.chatUsageEvent.create({
      data: { userId: randomUUID(), kind: "message" }, // 58
    });

    await expect(
      reports.startGeneration(randomUUID(), false, "NVDA"),
    ).rejects.toMatchObject({
      code: "report_limit_reached",
      details: { scope: "global" },
    });
    await prisma.chatUsageEvent.deleteMany({ where: { kind: "message" } }); // 57
    await expect(
      reports.startGeneration(randomUUID(), false, "NVDA"),
    ).resolves.toMatchObject({ latestQuarter: { label: "Q2 FY2027" } });
  });

  it("refunds by deleting the usage event", async () => {
    const user = randomUUID();
    const { usageEventId } = await reports.startGeneration(user, false, "NVDA");

    await reports.refundGeneration(usageEventId);

    expect(await events(user)).toEqual([]);
  });

  it("refuses a fresh report and reads stored content back as a DTO", async () => {
    const generatedAt = new Date(Date.now() - 60_000);
    await prisma.researchReport.create({
      data: {
        ticker: "NVDA",
        fiscalYear: 2027,
        fiscalQuarter: 2,
        companyName: "Nvidia Corp",
        content: reportContent(),
        generatedAt,
      },
    });
    const user = randomUUID();

    await expect(reports.startGeneration(user, false, "NVDA")).rejects.toMatchObject({
      status: 409,
      code: "report_fresh",
    });
    const view = await reports.getReport("NVDA", user, false);
    expect(view.report).toMatchObject({
      companyName: "Nvidia Corp",
      quarter: { label: "Q2 FY2027" },
      generatedAt: generatedAt.toISOString(),
    });
    expect(view).toMatchObject({ canGenerate: false, blockedReason: "fresh" });
    const [item] = await reports.listReports();
    expect(item).toMatchObject({ ticker: "NVDA", report: { outdated: false } });
  });

  it("chat counts only its own turns per user, but every weight globally", async () => {
    const user = randomUUID();
    await prisma.chatUsageEvent.createMany({
      data: [
        { userId: user, kind: "message" },
        { userId: user, kind: "retry" },
        { userId: user, kind: "report", weight: 3 },
      ],
    });

    const usage = await chat.getUsage(user, false);
    expect(usage.used).toBe(2); // the report has its own cap

    await prisma.chatUsageEvent.createMany({
      data: Array.from({ length: 55 }, () => ({
        userId: randomUUID(),
        kind: "message",
      })),
    }); // 2 + 3 + 55 = 60 units
    await expect(chat.assertWithinLimits(user, false)).rejects.toMatchObject({
      code: "chat_limit_reached",
      details: { scope: "global" },
    });
  });
});
