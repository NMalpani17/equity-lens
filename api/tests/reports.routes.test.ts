import type { AddressInfo } from "node:net";

import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

// Route tests: auth, validation, status codes and the SSE relay, with the
// report service and the ai-service stream mocked.
vi.mock("../src/services/reports.service.js", () => ({
  listReports: vi.fn(),
  getReport: vi.fn(),
  getReportUsage: vi.fn(),
  startGeneration: vi.fn(),
  refundGeneration: vi.fn(),
}));
vi.mock("../src/services/reportStream.service.js", () => ({
  openReportStream: vi.fn(),
}));
vi.mock("../src/auth/verifyToken.js", () => ({ verifySupabaseToken: vi.fn() }));

import { createApp } from "../src/app.js";
import { verifySupabaseToken } from "../src/auth/verifyToken.js";
import {
  ForbiddenError,
  ReportConflictError,
  ReportLimitError,
  ServiceUnavailableError,
} from "../src/errors.js";
import * as reportsService from "../src/services/reports.service.js";
import {
  openReportStream,
  type AiReportEvent,
} from "../src/services/reportStream.service.js";

const app = createApp();
const service = vi.mocked(reportsService);
const openStream = vi.mocked(openReportStream);
const verifyToken = vi.mocked(verifySupabaseToken);

const USER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const AUTH = "Bearer test-token";
const QUARTER = { fiscalYear: 2027, fiscalQuarter: 2, label: "Q2 FY2027" };
const START = { usageEventId: "ev-1", latestQuarter: QUARTER, regenerateAfterDays: 7 };
const REPORT = { ticker: "NVDA", sections: [] } as never;

async function* stream(...events: AiReportEvent[]) {
  for (const event of events) yield event;
}

const agent = (
  name: "transcripts" | "market" | "writer",
  state: "running" | "done" | "failed",
): AiReportEvent => ({ type: "agent", agent: name, state, label: `${name}…` });

function parseSse(text: string) {
  return text
    .trim()
    .split("\n\n")
    .filter((frame) => frame.startsWith("event:"))
    .map((frame) => {
      const [event, data] = frame.split("\n");
      return {
        event: event!.replace("event: ", ""),
        data: JSON.parse(data!.replace("data: ", "")) as Record<string, unknown>,
      };
    });
}

beforeEach(() => {
  vi.clearAllMocks();
  verifyToken.mockResolvedValue({ userId: USER, isAnonymous: false });
  service.startGeneration.mockResolvedValue(START);
});

describe("auth", () => {
  it.each([
    ["get", "/api/reports"],
    ["get", "/api/reports/NVDA"],
    ["post", "/api/reports/NVDA"],
  ] as const)("%s %s needs a signed-in user", async (method, path) => {
    const res = await request(app)[method](path);

    expect(res.status).toBe(401);
  });
});

describe("GET /api/reports", () => {
  it("lists tickers with the caller's allowance (demo users too)", async () => {
    verifyToken.mockResolvedValue({ userId: USER, isAnonymous: true });
    service.listReports.mockResolvedValue([]);
    service.getReportUsage.mockResolvedValue({
      used: 0,
      limit: 0,
      remaining: 0,
      resetsAt: "2026-10-08T00:00:00.000Z",
      isDemo: true,
    });

    const res = await request(app).get("/api/reports").set("Authorization", AUTH);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      tickers: [],
      usage: expect.objectContaining({ isDemo: true }),
    });
    expect(service.getReportUsage).toHaveBeenCalledWith(USER, true);
  });
});

describe("GET /api/reports/:ticker", () => {
  it("returns the report view for a normalized ticker", async () => {
    service.getReport.mockResolvedValue({ ticker: "NVDA" } as never);

    const res = await request(app).get("/api/reports/nvda").set("Authorization", AUTH);

    expect(res.status).toBe(200);
    expect(service.getReport).toHaveBeenCalledWith("NVDA", USER, false);
  });

  it("rejects an invalid ticker with 422", async () => {
    const res = await request(app)
      .get("/api/reports/not%20a%20ticker")
      .set("Authorization", AUTH);

    expect(res.status).toBe(422);
    expect(service.getReport).not.toHaveBeenCalled();
  });
});

describe("POST /api/reports/:ticker", () => {
  const post = () => request(app).post("/api/reports/NVDA").set("Authorization", AUTH);

  it.each([
    [new ForbiddenError("demo_read_only", "Demo accounts can view reports."), 403],
    [
      new ReportConflictError("report_fresh", "Fresh.", { regenerateAvailableAt: "x" }),
      409,
    ],
    [new ReportLimitError("user", 2, "2026-10-08T00:00:00.000Z", "Limit."), 429],
  ])("returns rule violations as JSON before streaming (%#)", async (error, status) => {
    service.startGeneration.mockRejectedValue(error);

    const res = await post();

    expect(res.status).toBe(status);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body.error).toBe((error as { code: string }).code);
    expect(openStream).not.toHaveBeenCalled();
  });

  it("streams agent progress, then the saved report", async () => {
    openStream.mockResolvedValue(
      stream(
        agent("transcripts", "running"),
        agent("market", "running"),
        { ...agent("market", "done"), summary: "2 data sources" } as AiReportEvent,
        agent("transcripts", "done"),
        agent("writer", "running"),
        agent("writer", "done"),
        { type: "done", report: REPORT },
      ),
    );

    const res = await post();

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    const events = parseSse(res.text);
    expect(events[0]).toEqual({
      event: "start",
      data: { ticker: "NVDA", quarter: QUARTER },
    });
    expect(events.slice(1, -1).map((e) => `${e.data.agent}:${e.data.state}`)).toEqual([
      "transcripts:running",
      "market:running",
      "market:done",
      "transcripts:done",
      "writer:running",
      "writer:done",
    ]);
    expect(events[3]!.data.summary).toBe("2 data sources");
    expect(events.at(-1)).toEqual({ event: "done", data: { report: REPORT } });
    expect(openStream).toHaveBeenCalledWith(
      { userId: USER, ticker: "NVDA", regenerateAfterDays: 7 },
      expect.any(AbortSignal),
    );
    expect(service.refundGeneration).not.toHaveBeenCalled();
  });

  it("relays a failed generation and keeps it counted", async () => {
    openStream.mockResolvedValue(
      stream(agent("transcripts", "running"), agent("transcripts", "failed"), {
        type: "error",
        code: "research_failed",
        message: "No citable passages.",
        retryable: true,
      }),
    );

    const events = parseSse((await post()).text);

    expect(events.at(-1)).toEqual({
      event: "error",
      data: {
        code: "research_failed",
        message: "No citable passages.",
        retryable: true,
      },
    });
    expect(service.refundGeneration).not.toHaveBeenCalled();
  });

  it.each(["report_in_progress", "report_fresh"])(
    "refunds the usage event when the ai-service refuses with %s before generating",
    async (code) => {
      openStream.mockResolvedValue(
        stream({ type: "error", code, message: "Busy.", retryable: true }),
      );

      const events = parseSse((await post()).text);

      expect(events.at(-1)!.data.code).toBe(code);
      expect(service.refundGeneration).toHaveBeenCalledWith("ev-1");
    },
  );

  it("reports an unreachable ai-service as an error event (still counted)", async () => {
    openStream.mockRejectedValue(
      new ServiceUnavailableError(
        "report_unavailable",
        "Report generation is unavailable.",
      ),
    );

    const events = parseSse((await post()).text);

    expect(events.at(-1)).toEqual({
      event: "error",
      data: {
        code: "report_unavailable",
        message: "Report generation is unavailable.",
        retryable: true,
      },
    });
    expect(service.refundGeneration).not.toHaveBeenCalled();
  });

  it("reports a stream that ends without a result", async () => {
    openStream.mockResolvedValue(stream(agent("transcripts", "running")));

    const events = parseSse((await post()).text);

    expect(events.at(-1)!.data.code).toBe("incomplete_response");
  });

  it("cancels the generation upstream when the client disconnects", async () => {
    let upstreamSignal: AbortSignal | undefined;
    openStream.mockImplementation(async (_req, signal) => {
      upstreamSignal = signal;
      return (async function* () {
        yield agent("transcripts", "running");
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve()),
        );
        throw new Error("upstream aborted");
      })();
    });
    const server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    const controller = new AbortController();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/reports/NVDA`, {
        method: "POST",
        headers: { Authorization: AUTH },
        signal: controller.signal,
      });
      const reader = res.body!.getReader();
      let received = "";
      while (!received.includes("transcripts")) {
        const { value } = await reader.read();
        received += new TextDecoder().decode(value);
      }
      controller.abort(); // the user closed the tab

      await vi.waitFor(() => expect(upstreamSignal?.aborted).toBe(true), {
        timeout: 2000,
      });
    } finally {
      server.close();
    }
    expect(service.refundGeneration).not.toHaveBeenCalled(); // cancelled still counts
  });
});
