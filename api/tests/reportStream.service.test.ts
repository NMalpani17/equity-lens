import { afterEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config.js";
import { ServiceUnavailableError } from "../src/errors.js";
import {
  mapReportEvent,
  openReportStream,
} from "../src/services/reportStream.service.js";
import { reportContent } from "./reportFixtures.js";

const REQUEST = { userId: "user-1", ticker: "NVDA", regenerateAfterDays: 7 };

function sse(...frames: [string, unknown][]): Response {
  const body = frames
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

async function collect(events: AsyncIterable<unknown>) {
  const out: unknown[] = [];
  for await (const event of events) out.push(event);
  return out;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("mapReportEvent", () => {
  it("validates agent progress", () => {
    expect(
      mapReportEvent("agent", {
        agent: "market",
        state: "done",
        label: "Analyzing price data…",
        summary: "2 data sources",
      }),
    ).toEqual({
      type: "agent",
      agent: "market",
      state: "done",
      label: "Analyzing price data…",
      summary: "2 data sources",
    });
    expect(
      mapReportEvent("agent", { agent: "supervisor", state: "done", label: "x" }),
    ).toBeNull();
  });

  it("maps the saved report to the camelCase DTO without agent stats", () => {
    const event = mapReportEvent("done", {
      report: reportContent(),
      fiscal_year: 2027,
      fiscal_quarter: 2,
      generated_at: "2026-10-07T12:00:00.123456Z",
      usage: { cost_usd: 0.05 },
      trace_id: "t1",
    });

    expect(event).toMatchObject({
      type: "done",
      report: {
        companyName: "NVIDIA Corporation",
        quarter: { label: "Q2 FY2027" },
        generatedAt: "2026-10-07T12:00:00.123Z",
        sections: [{ key: "summary" }, {}, {}, {}, {}, {}],
      },
    });
    expect(JSON.stringify(event)).not.toMatch(/cost_usd|trace_id|agents/);
  });

  it("drops a done event whose report is malformed", () => {
    expect(
      mapReportEvent("done", {
        report: reportContent({
          sections: [{ key: "intro", title: "x", markdown: "" }],
        }),
        generated_at: "2026-10-07T12:00:00Z",
      }),
    ).toBeNull();
  });
});

describe("openReportStream", () => {
  it("posts the request with the internal token and yields valid events", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        sse(
          ["agent", { agent: "transcripts", state: "running", label: "Researching…" }],
          ["agent", { nonsense: true }],
          ["error", { code: "research_failed", message: "m", retryable: true }],
        ),
      );

    const events = await collect(
      await openReportStream(REQUEST, new AbortController().signal),
    );

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe(`${config.aiServiceUrl}/reports/stream`);
    expect(new Headers(init!.headers).get("X-Internal-Token")).toBe(
      config.aiServiceInternalToken,
    );
    expect(JSON.parse(String(init!.body))).toEqual({
      user_id: "user-1",
      is_anonymous: false,
      ticker: "NVDA",
      regenerate_after_days: 7,
    });
    expect(events).toEqual([
      { type: "agent", agent: "transcripts", state: "running", label: "Researching…" },
      { type: "error", code: "research_failed", message: "m", retryable: true },
    ]);
  });

  it("maps an unreachable or refusing ai-service to report_unavailable", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockRejectedValueOnce(new TypeError("fetch failed"));
    fetchSpy.mockResolvedValueOnce(new Response("{}", { status: 503 }));
    const signal = new AbortController().signal;

    for (let i = 0; i < 2; i++) {
      const error = await openReportStream(REQUEST, signal).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ServiceUnavailableError);
      expect(error).toMatchObject({ status: 503, code: "report_unavailable" });
    }
  });

  it("refuses to call upstream when the internal token is not configured", async () => {
    const original = config.aiServiceInternalToken;
    (config as { aiServiceInternalToken: string }).aiServiceInternalToken = "";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      await expect(
        openReportStream(REQUEST, new AbortController().signal),
      ).rejects.toMatchObject({ status: 503, code: "report_not_configured" });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      (config as { aiServiceInternalToken: string }).aiServiceInternalToken = original;
    }
  });
});
