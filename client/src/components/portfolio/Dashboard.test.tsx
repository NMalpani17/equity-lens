import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { Dashboard } from "./Dashboard";
import type { PortfolioSummary } from "@/lib/api";

const summary: PortfolioSummary = {
  positions: [
    {
      ticker: "AAPL",
      name: "Apple Inc",
      totalShares: 10,
      avgBuyPrice: 100,
      costBasis: 1000,
      currentPrice: 110,
      marketValue: 1100,
      gainLoss: 100,
      gainLossPercent: 10,
      dailyChange: 50,
      dailyChangePercent: 4.76,
      priceStatus: "ok",
      lots: [
        {
          id: "1",
          ticker: "AAPL",
          shares: 10,
          buyPrice: 100,
          purchaseDate: null,
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

const emptyPerformance = {
  range: "1Y",
  status: "no_dates",
  benchmark: { ticker: "SPY", available: false },
  startDate: null,
  endDate: null,
  startClamped: false,
  portfolioReturnPercent: null,
  benchmarkReturnPercent: null,
  points: [],
  excluded: [],
  lotsWithoutDate: 1,
};

/** Answer the summary with `body`; the insight endpoints get empty results. */
function mockFetchOnce(body: unknown, status = 200) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes("/performance")) {
      return new Response(JSON.stringify(emptyPerformance));
    }
    if (url.includes("/sectors")) {
      return new Response(
        JSON.stringify({
          totalMarketValue: 0,
          sectors: [],
          unpricedTickers: [],
          pendingTickers: [],
        }),
      );
    }
    return new Response(JSON.stringify(body), { status });
  });
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
    // The performance card loads alongside.
    expect(
      await screen.findByText(
        "Add purchase dates to your holdings to see performance.",
      ),
    ).toBeInTheDocument();
  });

  it("opens the CSV import from the header", async () => {
    mockFetchOnce(summary);

    render(<Dashboard />);
    await screen.findByText("AAPL");
    fireEvent.click(screen.getByRole("button", { name: "Import CSV" }));

    expect(
      await screen.findByRole("dialog", { name: "Import holdings from CSV" }),
    ).toBeInTheDocument();
  });

  it("shows an empty state when there are no holdings", async () => {
    mockFetchOnce({ positions: [], totals: summary.totals });

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
