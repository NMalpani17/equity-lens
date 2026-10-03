import { beforeAll, describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import type { AllocationChart, ChatChart, PriceChart } from "@/lib/chatApi";
import { ChatCharts } from "./ChatCharts";

const priceChart: PriceChart = {
  id: "chart-h1",
  kind: "price_history",
  ticker: "NVDA",
  period: "6mo",
  currency: "USD",
  points: [
    { date: "2026-04-01", close: 100 },
    { date: "2026-06-01", close: 104.5 },
    { date: "2026-08-03", close: 98.25 },
    { date: "2026-10-01", close: 120 },
  ],
  firstClose: 100,
  lastClose: 120,
  change: 20,
  changePercent: 20,
  high: 120,
  low: 98.25,
  asOf: "2026-10-01T20:00:00Z",
};

const allocationChart: AllocationChart = {
  id: "chart-p1",
  kind: "portfolio_allocation",
  currency: "USD",
  slices: [
    { ticker: "NVDA", name: "Nvidia Corp", marketValue: 3000, weightPercent: 60 },
    { ticker: "AAPL", name: null, marketValue: 2000, weightPercent: 40 },
  ],
  totalMarketValue: 5000,
  partial: false,
  asOf: null,
};

async function figure(name: string) {
  return (await screen.findByText(name)).closest("figure") as HTMLElement;
}

describe("ChatCharts", () => {
  // Load the lazy Recharts chunk once up front; on a busy runner its first
  // import can outlast findBy's default timeout, and even the default 10s
  // hook timeout, so the hook gets 60s.
  beforeAll(async () => {
    await import("./charts/ChartView");
  }, 60_000);

  it("renders a price chart with its headline, an SVG and a data table", async () => {
    render(<ChatCharts charts={[priceChart]} />);

    const chart = await figure("NVDA · 6 months");
    const caption = within(chart.querySelector("figcaption")!);
    expect(caption.getByText("$120.00")).toBeInTheDocument();
    expect(caption.getByText(/\+20\.00%/)).toBeInTheDocument();
    expect(caption.getByText("(up)", { exact: false })).toHaveClass("sr-only");
    expect(chart.querySelector("svg.recharts-surface")).not.toBeNull();

    fireEvent.click(within(chart).getByText("View data"));
    const table = within(chart).getByRole("table", { name: /NVDA · 6 months/ });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(5); // header + 4 points
    expect(within(rows[1]!).getByText("Apr 1, 2026")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("$100.00")).toBeInTheDocument();
  });

  it("shows a falling period in the down color with a down label", async () => {
    render(
      <ChatCharts
        charts={[{ ...priceChart, lastClose: 90, change: -10, changePercent: -10 }]}
      />,
    );

    const chart = await figure("NVDA · 6 months");
    const caption = within(chart.querySelector("figcaption")!);
    expect(caption.getByText(/-10\.00%/)).toHaveClass("text-destructive");
    expect(caption.getByText("(down)", { exact: false })).toBeInTheDocument();
  });

  it("renders the allocation chart with holdings, total and data table", async () => {
    render(<ChatCharts charts={[allocationChart]} />);

    const chart = await figure("Portfolio allocation");
    expect(within(chart).getByText("$5,000.00 by market value")).toBeInTheDocument();
    expect(chart.querySelector("svg.recharts-surface")).not.toBeNull();
    expect(within(chart).queryByText(/aren't shown/)).not.toBeInTheDocument();

    const table = within(chart).getByRole("table", {
      name: "Portfolio allocation data",
    });
    expect(within(table).getByText("NVDA (Nvidia Corp)")).toBeInTheDocument();
    expect(within(table).getByText("$3,000.00")).toBeInTheDocument();
    expect(within(table).getByText("40.0%")).toBeInTheDocument();
  });

  it("notes when unpriced holdings are left out", async () => {
    render(<ChatCharts charts={[{ ...allocationChart, partial: true }]} />);

    expect(
      await screen.findByText("Holdings without a current price aren't shown."),
    ).toBeInTheDocument();
  });

  it("renders several charts and skips unknown kinds", async () => {
    const unknown = { id: "x", kind: "candles" } as unknown as ChatChart;
    render(<ChatCharts charts={[priceChart, unknown, allocationChart]} />);

    await figure("NVDA · 6 months");
    await figure("Portfolio allocation");
    expect(document.querySelectorAll("figure")).toHaveLength(2);
  });

  it("renders nothing without charts", () => {
    const { container } = render(<ChatCharts charts={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
