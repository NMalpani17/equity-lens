import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import type { DataSource } from "@/lib/reportsApi";
import { DataSourceDialog } from "./DataSourceDialog";

function quote(data: Record<string, unknown>): DataSource {
  return {
    id: "D1",
    kind: "quote",
    ticker: "NVDA",
    label: "NVDA quote",
    asOf: "2026-10-06 4:00 PM EDT",
    data: { price: 181.5, previous_close: 178.46, currency: "USD", ...data },
  };
}

describe("DataSourceDialog", () => {
  it("shows a rise with a plus sign, in green", () => {
    render(
      <DataSourceDialog
        source={quote({ change: 3.04, change_percent: 1.7 })}
        onOpenChange={vi.fn()}
      />,
    );

    expect(screen.getByText("+$3.04")).toHaveClass("text-emerald-600");
    expect(screen.getByText("+1.70%")).toHaveClass("text-emerald-600");
    // Prices themselves stay unsigned and uncolored.
    expect(screen.getByText("$181.50").className).not.toMatch(/emerald|destructive/);
  });

  it("shows a fall with a minus sign, in red", () => {
    render(
      <DataSourceDialog
        source={quote({ change: -1.84, change_percent: -0.77 })}
        onOpenChange={vi.fn()}
      />,
    );

    expect(screen.getByText("-$1.84")).toHaveClass("text-destructive");
    expect(screen.getByText("-0.77%")).toHaveClass("text-destructive");
  });
});
