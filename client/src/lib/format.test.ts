import { describe, expect, it } from "vitest";

import {
  changeColor,
  describeReset,
  formatCurrency,
  formatSignedCurrency,
  formatSignedPercent,
  formatTimestampDate,
} from "./format";

describe("format helpers", () => {
  it("formats currency", () => {
    expect(formatCurrency(1234.5)).toBe("$1,234.50");
  });

  it("prefixes signed currency with + / -", () => {
    expect(formatSignedCurrency(12)).toBe("+$12.00");
    expect(formatSignedCurrency(-12)).toBe("-$12.00");
    expect(formatSignedCurrency(0)).toBe("$0.00");
  });

  it("prefixes gains with + in percent", () => {
    expect(formatSignedPercent(4.756)).toBe("+4.76%");
    expect(formatSignedPercent(-1.2)).toBe("-1.20%");
  });

  it("formats an ISO timestamp as a calendar day", () => {
    expect(formatTimestampDate("2024-02-12T10:30:00.000Z")).toBe("Feb 12, 2024");
  });

  it("returns a dash for missing or invalid timestamps", () => {
    expect(formatTimestampDate(null)).toBe("—");
    expect(formatTimestampDate(undefined)).toBe("—");
    expect(formatTimestampDate("not-a-date")).toBe("—");
  });

  it("colors by sign", () => {
    expect(changeColor(5)).toBe("text-emerald-600");
    expect(changeColor(-5)).toBe("text-destructive");
    expect(changeColor(0)).toBe("text-muted-foreground");
  });
});

describe("describeReset", () => {
  // The chat allowance resets at midnight UTC; users see their own clock.
  const RESET = "2026-10-02T00:00:00.000Z";
  const NOW = new Date("2026-10-01T15:00:00.000Z");

  it.each([
    ["America/New_York", "at 8:00 PM EDT"], // still Oct 1 locally
    ["America/Los_Angeles", "at 5:00 PM PDT"],
    ["Asia/Kolkata", "tomorrow at 5:30 AM GMT+5:30"], // already Oct 2 locally
    ["Europe/Berlin", "tomorrow at 2:00 AM GMT+2"],
    ["UTC", "tomorrow at 12:00 AM UTC"],
  ])("shows the reset in %s local time", (timeZone, expected) => {
    expect(describeReset(RESET, { now: NOW, timeZone })).toBe(expected);
  });

  it("uses the browser's zone by default and survives bad input", () => {
    // The run's zone is pinned to America/New_York in vitest.config.ts.
    expect(describeReset(RESET, { now: NOW })).toBe("at 8:00 PM EDT");
    expect(describeReset("not a date")).toBe("at midnight");
  });
});
