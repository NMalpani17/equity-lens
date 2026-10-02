import { describe, expect, it } from "vitest";

import type { ChatMessage, Citation } from "@/lib/chatApi";
import { fallbackText, linkCitations } from "@/lib/chatFormat";

const citation = (id: number): Citation => ({
  id,
  ticker: "NVDA",
  companyName: "Nvidia Corp",
  fiscalYear: 2027,
  fiscalQuarter: 2,
  callDate: "2026-08-26",
  speaker: "Colette Kress",
  role: "CFO",
  section: "prepared_remarks",
  text: "Data center revenue grew.",
});

const message = (overrides: Partial<ChatMessage>): ChatMessage => ({
  id: "m",
  role: "assistant",
  content: "",
  status: "complete",
  citations: [],
  toolCalls: [],
  errorCode: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  ...overrides,
});

describe("linkCitations", () => {
  it("links known citations and leaves other brackets alone", () => {
    const out = linkCitations("Growth [1] and margins [2]. In [2026] [3].", [
      citation(1),
      citation(2),
    ]);

    expect(out).toBe(
      "Growth [\\[1\\]](#cite-1) and margins [\\[2\\]](#cite-2). In [2026] [3].",
    );
  });

  it("does not double-link existing markdown links", () => {
    expect(linkCitations("[1](https://x.test)", [citation(1)])).toBe(
      "[1](https://x.test)",
    );
  });
});

describe("fallbackText", () => {
  it("never leaves a finished assistant bubble blank", () => {
    expect(fallbackText(message({ status: "interrupted" }))).toMatch(/Stopped/);
    expect(fallbackText(message({ status: "error" }))).toMatch(/failed/);
    expect(fallbackText(message({ status: "blocked" }))).toMatch(
      /couldn't be answered/,
    );
    expect(fallbackText(message({ status: "empty" }))).toMatch(/No answer/);
    expect(fallbackText(message({ status: "complete", content: "Hi" }))).toBeNull();
  });
});
