import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import type { PortfolioPerformance } from "@/lib/api";
import { PerformanceChart } from "./PerformanceChart";

const performance: PortfolioPerformance = {
  range: "1Y",
  status: "ok",
  benchmark: { ticker: "SPY", available: true },
  startDate: "2026-01-02",
  endDate: "2026-10-16",
  startClamped: false,
  portfolioReturnPercent: 12.5,
  benchmarkReturnPercent: -3.25,
  points: [
    {
      date: "2026-01-02",
      portfolioPercent: 0,
      benchmarkPercent: 0,
      portfolioValue: 1000,
    },
    {
      date: "2026-10-16",
      portfolioPercent: 12.5,
      benchmarkPercent: -3.25,
      portfolioValue: 1125,
    },
  ],
  excluded: [],
  lotsWithoutDate: 0,
};

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function mockPerformance(body: Partial<PortfolioPerformance> = {}) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => respond({ ...performance, ...body }));
}

beforeAll(async () => {
  // Load the lazy Recharts chunk up front (slow on a busy runner).
  await import("./PerformancePlot");
}, 60_000);

/** The legend, which carries each series' return. */
function legend() {
  return screen.findByRole("group", { name: "Returns over the range" });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PerformanceChart", () => {
  it("shows both returns, colored as gain and loss, labeled as price return", async () => {
    mockPerformance();

    render(<PerformanceChart version={0} />);

    const returns = await legend();
    const gain = within(returns).getByText("+12.50%");
    expect(gain).toHaveClass("text-gain");
    expect(within(returns).getByText("-3.25%")).toHaveClass("text-loss");
    expect(screen.getByText("Your portfolio")).toBeInTheDocument();
    expect(screen.getByText("S&P 500 (SPY)")).toBeInTheDocument();
    expect(screen.getByText(/Dividends aren't included/)).toBeInTheDocument();
    // The table view carries every value.
    expect(screen.getByText("View data")).toBeInTheDocument();
  });

  it("requests the 1Y range first and another range when picked", async () => {
    const fetchMock = mockPerformance();

    render(<PerformanceChart version={0} />);
    await legend();
    fireEvent.click(screen.getByRole("button", { name: "All" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(String(fetchMock.mock.calls[0]![0])).toContain("range=1Y");
    expect(String(fetchMock.mock.calls[1]![0])).toContain("range=ALL");
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("reloads when the holdings version changes", async () => {
    const fetchMock = mockPerformance();

    const { rerender } = render(<PerformanceChart version={0} />);
    await legend();
    rerender(<PerformanceChart version={1} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("explains what is left out and where the chart starts", async () => {
    mockPerformance({
      startClamped: true,
      startDate: "2026-03-02",
      excluded: [
        { ticker: "GONE", reason: "no_history" },
        { ticker: "NEW", reason: "no_close_yet" },
      ],
      lotsWithoutDate: 2,
    });

    render(<PerformanceChart version={0} />);

    expect(
      await screen.findByText(
        /Starts Mar 2, 2026, the first close after your first purchase/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Not included (no price history): GONE."),
    ).toBeInTheDocument();
    expect(screen.getByText(/first close after purchase: NEW/)).toBeInTheDocument();
    expect(
      screen.getByText(/2 lots have no purchase date and aren't included/),
    ).toBeInTheDocument();
  });

  it("asks for purchase dates when no lot has one", async () => {
    mockPerformance({ status: "no_dates", points: [], lotsWithoutDate: 3 });

    render(<PerformanceChart version={0} />);

    expect(
      await screen.findByText(
        "Add purchase dates to your holdings to see performance.",
      ),
    ).toBeInTheDocument();
  });

  it("shows an error with a retry", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        respond(
          { error: "upstream_error", message: "Price history is unavailable." },
          502,
        ),
      )
      .mockResolvedValueOnce(respond(performance));

    render(<PerformanceChart version={0} />);
    expect(
      await screen.findByText("Price history is unavailable."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(within(await legend()).getByText("+12.50%")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
