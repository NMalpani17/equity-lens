import { describe, expect, it } from "vitest";

import {
  dateLabel,
  dateTick,
  isLongRange,
  percentAxis,
  percentTick,
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

  it.each([
    [
      [0, 0.4, -0.3],
      [-1, 0, 1],
    ],
    [
      [0, 2.7, -0.9],
      [-1, 0, 1, 2, 3],
    ],
    [
      [0, 9, -9],
      [-10, -5, 0, 5, 10],
    ],
    [
      [0, 8.7],
      [0, 2.5, 5, 7.5, 10],
    ],
    [
      [0, 12.5],
      [0, 5, 10, 15],
    ],
    [
      [0, 47, -3],
      [-20, 0, 20, 40, 60],
    ],
    [
      [0, 230, -10],
      [-100, 0, 100, 200, 300],
    ],
    [[0], [0, 1]],
  ])("puts percent ticks on round steps (%j)", (values, ticks) => {
    const axis = percentAxis(values);
    expect(axis.ticks).toEqual(ticks);
    expect(axis.domain).toEqual([ticks[0], ticks.at(-1)]);
  });

  it("never labels a percent axis with an odd step", () => {
    for (let max = 0.1; max < 400; max *= 1.37) {
      for (const min of [0, -max / 3, -max]) {
        const labels = percentAxis([min, max]).ticks.map(percentTick);
        for (const label of labels) {
          // Whole numbers, or a half from a 2.5 step: never +0.9% or +2.7%.
          expect(label).toMatch(/^(0|[+-]\d+(\.5)?)%$/);
        }
      }
    }
  });

  it("labels percent ticks with a sign", () => {
    expect(percentTick(10)).toBe("+10%");
    expect(percentTick(-2.5)).toBe("-2.5%");
    expect(percentTick(0)).toBe("0%");
  });
});
