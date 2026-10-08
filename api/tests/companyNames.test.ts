import { describe, expect, it } from "vitest";

import { companyDisplayName } from "../src/services/companyNames.js";

describe("companyDisplayName", () => {
  it.each([
    ["AMZN", "Amazon Com Inc", "Amazon.com, Inc."],
    ["JPM", "Jpmorgan Chase & Co", "JPMorgan Chase & Co."],
    ["nvda", null, "NVIDIA Corporation"],
    // Not curated: only a trailing abbreviation gets its period.
    ["ZZZZ", "Acme Widgets Corp", "Acme Widgets Corp."],
    ["ZZZZ", "Acme Widgets Corp.", "Acme Widgets Corp."],
    ["ZZZZ", "Coinco Holdings", "Coinco Holdings"],
    ["ZZZZ", "  ", "ZZZZ"],
  ])("%s / %s -> %s", (ticker, raw, expected) => {
    expect(companyDisplayName(ticker, raw)).toBe(expected);
  });
});
