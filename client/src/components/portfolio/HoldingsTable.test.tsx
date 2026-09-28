import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { HoldingsTable } from "./HoldingsTable";
import type { PortfolioLot, PortfolioPosition } from "@/lib/api";

function lot(overrides: Partial<PortfolioLot> = {}): PortfolioLot {
  return {
    id: "lot-1",
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
    ...overrides,
  };
}

const position: PortfolioPosition = {
  ticker: "AAPL",
  name: "Apple Inc",
  totalShares: 30,
  avgBuyPrice: 120,
  costBasis: 3600,
  currentPrice: 110,
  marketValue: 3300,
  gainLoss: -300,
  gainLossPercent: -8.33,
  dailyChange: 150,
  dailyChangePercent: 4.76,
  priceStatus: "ok",
  lots: [
    lot({ id: "a", shares: 10, buyPrice: 100, marketValue: 1100 }),
    lot({ id: "b", shares: 20, buyPrice: 130, marketValue: 2200 }),
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("HoldingsTable", () => {
  it("shows one aggregated row per ticker with a lot count", () => {
    render(
      <HoldingsTable positions={[position]} onEdit={vi.fn()} onDelete={vi.fn()} />,
    );

    expect(screen.getByText("AAPL")).toBeInTheDocument();
    expect(screen.getByText("2 lots")).toBeInTheDocument();
    // Aggregated total shares and weighted average are shown.
    expect(screen.getByText("30")).toBeInTheDocument();
    expect(screen.getByText("$120.00")).toBeInTheDocument();
    // Lots are hidden until expanded.
    expect(screen.queryByLabelText("Edit AAPL lot")).not.toBeInTheDocument();
  });

  it("reveals individual lots with edit/delete when expanded", () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    render(
      <HoldingsTable positions={[position]} onEdit={onEdit} onDelete={onDelete} />,
    );

    fireEvent.click(screen.getByText("AAPL"));

    const editButtons = screen.getAllByLabelText("Edit AAPL lot");
    const deleteButtons = screen.getAllByLabelText("Delete AAPL lot");
    expect(editButtons).toHaveLength(2);
    expect(deleteButtons).toHaveLength(2);

    fireEvent.click(editButtons[1]!);
    expect(onEdit).toHaveBeenCalledWith(position.lots[1]);

    fireEvent.click(deleteButtons[0]!);
    expect(onDelete).toHaveBeenCalledWith(position.lots[0]);
  });

  it("renders an unavailable badge when a position has no price", () => {
    const unpriced: PortfolioPosition = {
      ...position,
      currentPrice: null,
      marketValue: null,
      gainLoss: null,
      gainLossPercent: null,
      dailyChange: null,
      dailyChangePercent: null,
      priceStatus: "not_found",
      lots: [
        lot({
          id: "a",
          currentPrice: null,
          marketValue: null,
          priceStatus: "not_found",
        }),
      ],
    };
    render(
      <HoldingsTable positions={[unpriced]} onEdit={vi.fn()} onDelete={vi.fn()} />,
    );

    const rows = screen.getAllByRole("row");
    // Header + one position row.
    expect(within(rows[1]!).getByText("unknown ticker")).toBeInTheDocument();
  });
});
