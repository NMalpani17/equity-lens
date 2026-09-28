import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

import { Dashboard } from "./Dashboard";
import type { PortfolioSummary } from "@/lib/api";

const summary: PortfolioSummary = {
  holdings: [
    {
      id: "1",
      ticker: "AAPL",
      name: "Apple Inc",
      shares: 10,
      buyPrice: 100,
      costBasis: 1000,
      currentPrice: 110,
      marketValue: 1100,
      gainLoss: 100,
      gainLossPercent: 10,
      dailyChange: 50,
      dailyChangePercent: 4.76,
      priceStatus: "ok",
    },
  ],
  totals: {
    marketValue: 1100,
    costBasis: 1000,
    gainLoss: 100,
    gainLossPercent: 10,
    dailyChange: 50,
    pricedCount: 1,
    unpricedCount: 0,
    partial: false,
  },
};

function mockFetchOnce(body: unknown, status = 200) {
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    new Response(JSON.stringify(body), { status }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Dashboard", () => {
  it("renders totals and holdings when loaded", async () => {
    mockFetchOnce(summary);

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByText("AAPL")).toBeInTheDocument();
    });
    // $1,100.00 appears as both the total value and the holding's market value.
    expect(screen.getAllByText("$1,100.00").length).toBeGreaterThan(0);
    expect(screen.getByText("Total value")).toBeInTheDocument();
    expect(screen.getByText("Apple Inc")).toBeInTheDocument();
  });

  it("shows an empty state when there are no holdings", async () => {
    mockFetchOnce({ holdings: [], totals: summary.totals });

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByText("No holdings yet")).toBeInTheDocument();
    });
  });

  it("shows an error state when the request fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("boom"));

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByText("Couldn't load your portfolio.")).toBeInTheDocument();
    });
  });
});
