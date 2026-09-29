import { describe, expect, it } from "vitest";

import {
  changeColor,
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
