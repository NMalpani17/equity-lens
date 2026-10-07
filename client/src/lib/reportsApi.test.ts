import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: { access_token: "t" } } }) },
  },
}));

import { API_URL, ApiError } from "@/lib/api";
import { linkDataRefs } from "@/lib/chatFormat";
import { blockedMessage } from "@/lib/reportFormat";
import {
  streamReport,
  type ReportStreamEvent,
  type ReportView,
} from "@/lib/reportsApi";

afterEach(() => {
  vi.restoreAllMocks();
});

function sse(...frames: [string, unknown][]): Response {
  return new Response(
    frames.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(""),
    { status: 200 },
  );
}

describe("streamReport", () => {
  it("posts to the ticker's report route and delivers each event", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        sse(
          ["start", { ticker: "NVDA", quarter: { label: "Q2 FY2027" } }],
          ["agent", { agent: "writer", state: "running", label: "Writing report…" }],
          ["keepalive-ish", { ignored: true }],
          ["error", { code: "research_failed", message: "m", retryable: true }],
        ),
      );
    const events: ReportStreamEvent[] = [];

    await streamReport("NVDA", (e) => events.push(e));

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(`${API_URL}/api/reports/NVDA`);
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer t");
    expect(events.map((e) => e.type)).toEqual(["start", "agent", "error"]);
  });

  it("rejects with the API's error before streaming", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ error: "demo_read_only", message: "Demo accounts can view." }),
        { status: 403 },
      ),
    );

    const error = await streamReport("NVDA", () => {}).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 403, code: "demo_read_only" });
  });
});

describe("linkDataRefs", () => {
  it("links known market-data refs and leaves others alone", () => {
    expect(linkDataRefs("Up 20% [D2] and [D9].", ["D2"])).toBe(
      "Up 20% [\\[D2\\]](#data-D2) and [D9].",
    );
  });
});

describe("blockedMessage", () => {
  const base = {
    blockedReason: null,
    regenerateAvailableAt: null,
    usage: { limit: 2, resetsAt: "2026-10-08T00:00:00.000Z" },
  } as unknown as ReportView;

  it("explains each reason, or nothing when generating is allowed", () => {
    expect(blockedMessage(base)).toBeNull();
    expect(blockedMessage({ ...base, blockedReason: "demo" })).toMatch(/Sign up/);
    expect(
      blockedMessage({
        ...base,
        blockedReason: "fresh",
        regenerateAvailableAt: "2026-10-12T12:00:00.000Z",
      }),
    ).toBe("This report is up to date. You can regenerate it on Oct 12, 2026.");
    expect(blockedMessage({ ...base, blockedReason: "daily_limit" })).toMatch(
      /^You've generated today's 2 reports\. More (tomorrow )?at /,
    );
  });
});
