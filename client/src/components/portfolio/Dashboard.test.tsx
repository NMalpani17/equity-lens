import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

import { Dashboard, NOTICE_MS } from "./Dashboard";
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

const importPreview = {
  rows: [
    { line: 2, ticker: "AAPL", shares: 1, buyPrice: 100, purchaseDate: "2024-01-02" },
    { line: 3, ticker: "MSFT", shares: 2, buyPrice: 200, purchaseDate: "2024-01-03" },
  ],
  errors: [],
  warnings: [],
  totalRows: 2,
  errorRowCount: 0,
};

/** Answer the summary with `body`; the insight endpoints get empty results. */
function mockFetchOnce(body: unknown, status = 200) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes("/performance")) {
      return new Response(JSON.stringify(emptyPerformance));
    }
    if (url.includes("/holdings/import/preview")) {
      return new Response(JSON.stringify(importPreview));
    }
    if (url.includes("/holdings/import")) {
      return new Response(JSON.stringify({ imported: 2 }), { status: 201 });
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

describe("Dashboard import notice", () => {
  beforeEach(() => {
    // Timers are faked, but time still flows so async UI updates settle.
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Import two holdings through the dialog; resolves once the notice shows. */
  async function importTwoHoldings() {
    fireEvent.click(screen.getByRole("button", { name: "Import CSV" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Import holdings from CSV",
    });
    const file = new File(["ticker,quantity,price,purchase_date"], "h.csv", {
      type: "text/csv",
    });
    fireEvent.change(within(dialog).getByLabelText("CSV file"), {
      target: { files: [file] },
    });
    fireEvent.click(
      await within(dialog).findByRole("button", { name: "Import 2 holdings" }),
    );
    return screen.findByText("Imported 2 holdings.");
  }

  async function renderLoaded() {
    mockFetchOnce(summary);
    render(<Dashboard />);
    await screen.findByText("AAPL");
  }

  it("dismisses itself after 5 seconds and keeps role=status", async () => {
    await renderLoaded();
    const notice = await importTwoHoldings();
    expect(notice).toHaveAttribute("role", "status");

    act(() => {
      vi.advanceTimersByTime(NOTICE_MS - 100);
    });
    expect(screen.getByText("Imported 2 holdings.")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(screen.queryByText("Imported 2 holdings.")).not.toBeInTheDocument();
  });

  it("closes with the dismiss button", async () => {
    await renderLoaded();
    await importTwoHoldings();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(screen.queryByText("Imported 2 holdings.")).not.toBeInTheDocument();
  });

  it("clears when another add or import starts", async () => {
    await renderLoaded();
    await importTwoHoldings();
    fireEvent.click(screen.getByRole("button", { name: "Add holding" }));
    expect(screen.queryByText("Imported 2 holdings.")).not.toBeInTheDocument();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    await importTwoHoldings();
    fireEvent.click(screen.getByRole("button", { name: "Import CSV" }));
    expect(screen.queryByText("Imported 2 holdings.")).not.toBeInTheDocument();
  });
});
