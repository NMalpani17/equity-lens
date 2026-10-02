import { describe, expect, it } from "vitest";

import {
  dateLabel,
  dateTick,
  isLongRange,
  periodLabel,
  priceLabel,
  priceTick,
} from "./chartFormat";

describe("chartFormat", () => {
  it("labels periods", () => {
    expect(periodLabel("6mo")).toBe("6 months");
    expect(periodLabel("ytd")).toBe("Year to date");
    expect(periodLabel("10y")).toBe("10y");
  });

  it("formats date ticks by range, in UTC", () => {
    expect(dateTick("2026-04-03", false)).toBe("Apr 3");
    expect(dateTick("2026-04-03", true)).toBe("Apr '26");
    expect(dateTick("2026-01-01", false)).toBe("Jan 1"); // no time-zone shift
    expect(dateTick("not-a-date", false)).toBe("not-a-date");
    expect(dateLabel("2026-04-03")).toBe("Apr 3, 2026");
  });

  it("detects multi-year series", () => {
    expect(isLongRange([{ date: "2026-01-01" }, { date: "2026-12-31" }])).toBe(false);
    expect(isLongRange([{ date: "2024-01-01" }, { date: "2026-01-01" }])).toBe(true);
    expect(isLongRange([])).toBe(false);
  });

  it("drops cents on axis ticks for larger prices only", () => {
    expect(priceTick(182.4)).toBe("$182");
    expect(priceTick(7.45)).toBe("$7.45");
    expect(priceTick(7)).toBe("$7");
    expect(priceLabel(182.4)).toBe("$182.40");
  });
});
