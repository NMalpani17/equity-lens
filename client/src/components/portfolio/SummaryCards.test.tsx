import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { SummaryCards } from "./SummaryCards";
import type { PortfolioTotals } from "@/lib/api";

function totals(overrides: Partial<PortfolioTotals> = {}): PortfolioTotals {
  return {
    marketValue: 1100,
    costBasis: 1000,
    gainLoss: 100,
    gainLossPercent: 10,
    dailyChange: 50,
    pricedCount: 1,
    unpricedCount: 0,
    partial: false,
    ...overrides,
  };
}

describe("SummaryCards", () => {
  it("shows monetary totals when holdings are priced", () => {
    render(<SummaryCards totals={totals()} holdingsCount={1} loading={false} />);

    expect(screen.getByText("$1,100.00")).toBeInTheDocument();
    expect(screen.queryByText(/Partial/)).not.toBeInTheDocument();
  });

  it("flags partial totals when some holdings are unpriced", () => {
    render(
      <SummaryCards
        totals={totals({ partial: true, pricedCount: 1, unpricedCount: 1 })}
        holdingsCount={2}
        loading={false}
      />,
    );

    expect(screen.getByText("$1,100.00")).toBeInTheDocument();
    expect(screen.getByText("Partial · 1 of 2 holdings priced")).toBeInTheDocument();
  });

  it("does not show a misleading $0.00 when no holding is priced", () => {
    render(
      <SummaryCards
        totals={totals({
          marketValue: 0,
          costBasis: 0,
          gainLoss: 0,
          gainLossPercent: 0,
          dailyChange: 0,
          partial: true,
          pricedCount: 0,
          unpricedCount: 2,
        })}
        holdingsCount={2}
        loading={false}
      />,
    );

    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
    // The three price-dependent cards fall back to an em dash placeholder.
    expect(screen.getAllByText("—").length).toBe(3);
    // Holdings count is still shown.
    expect(screen.getByText("2")).toBeInTheDocument();
  });
});
