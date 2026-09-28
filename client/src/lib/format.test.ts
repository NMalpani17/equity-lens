import { describe, expect, it } from "vitest";

import {
  changeColor,
  formatCurrency,
  formatSignedCurrency,
  formatSignedPercent,
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

  it("colors by sign", () => {
    expect(changeColor(5)).toBe("text-emerald-600");
    expect(changeColor(-5)).toBe("text-destructive");
    expect(changeColor(0)).toBe("text-muted-foreground");
  });
});
