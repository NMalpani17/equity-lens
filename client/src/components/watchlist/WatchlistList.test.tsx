import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("@/context/auth-context", () => ({
  useAuth: () => ({ isDemo: false, signOut: vi.fn() }),
}));

import { WatchlistList } from "./WatchlistList";
import type { WatchlistRow } from "@/lib/marketApi";

const row: WatchlistRow = {
  ticker: "AMD",
  name: "Advanced Micro Devices",
  price: 165,
  change: 5,
  changePercent: 3.13,
  priceStatus: "ok",
  addedAt: "2026-10-01T14:00:00.000Z",
  addedPrice: 150,
  addedPriceAt: "2026-10-01T14:00:00.000Z",
  changeSinceAdded: 15,
  changeSinceAddedPercent: 10,
  nextEarnings: { date: "2026-11-03", hour: "amc", epsEstimate: 1.97 },
  report: { status: "ready", demoLocked: false },
  inPortfolio: false,
};

function renderList(
  rows: WatchlistRow[] = [row, { ...row, ticker: "JPM", name: null }],
) {
  render(
    <MemoryRouter>
      <WatchlistList rows={rows} onRemove={vi.fn()} />
    </MemoryRouter>,
  );
}

const RIGHT = ["price", "today", "sinceAdded", "actions"];
const LEFT = ["company", "nextEarnings", "report"];

function alignment(element: Element): "right" | "left" {
  return element.className.split(/\s+/).includes("md:text-right") ? "right" : "left";
}

describe("WatchlistList columns", () => {
  it("has one header cell per column, in order", () => {
    renderList();

    const header = screen.getByTestId("watchlist-header");
    expect([...header.children].map((c) => c.getAttribute("data-column"))).toEqual([
      "company",
      "price",
      "today",
      "sinceAdded",
      "nextEarnings",
      "report",
      "actions",
    ]);
    expect(header).toHaveTextContent(
      "CompanyPriceTodaySince addedNext earningsReportActions",
    );
  });

  it("aligns numbers right and text left, the same in the header and every row", () => {
    renderList();

    const header = screen.getByTestId("watchlist-header");
    for (const item of screen.getAllByRole("listitem")) {
      for (const key of [...RIGHT, ...LEFT]) {
        const head = header.querySelector(`[data-column="${key}"]`)!;
        const cell = item.querySelector(`[data-column="${key}"]`)!;
        expect(cell, key).not.toBeNull();
        expect(alignment(cell), key).toBe(alignment(head));
        expect(alignment(head), key).toBe(RIGHT.includes(key) ? "right" : "left");
      }
    }
  });

  it("puts each value in its own column, in header order", () => {
    renderList([row]);

    const item = screen.getByRole("listitem");
    const order = [...item.querySelectorAll("[data-column]")].map((c) =>
      c.getAttribute("data-column"),
    );
    expect(order).toEqual([
      "company",
      "price",
      "today",
      "sinceAdded",
      "nextEarnings",
      "report",
      "actions",
    ]);
    const cell = (key: string) => item.querySelector(`[data-column="${key}"]`)!;
    expect(
      within(cell("price") as HTMLElement).getByText("$165.00"),
    ).toBeInTheDocument();
    expect(
      within(cell("today") as HTMLElement).getByText("+$5.00"),
    ).toBeInTheDocument();
    expect(
      within(cell("sinceAdded") as HTMLElement).getByText("+10.00%"),
    ).toBeInTheDocument();
    expect(
      within(cell("nextEarnings") as HTMLElement).getByText("Nov 3, 2026"),
    ).toBeInTheDocument();
    expect(
      within(cell("report") as HTMLElement).getByRole("link", {
        name: "View AMD report",
      }),
    ).toBeInTheDocument();
  });

  it("shares one set of column tracks: the header and rows are subgrids", () => {
    renderList();

    expect(screen.getByTestId("watchlist-grid").className).toMatch(/md:grid-cols-\[/);
    const subgrid = /md:grid-cols-subgrid/;
    expect(screen.getByTestId("watchlist-header").className).toMatch(subgrid);
    expect(screen.getByRole("list", { name: "Watchlist" }).className).toMatch(subgrid);
    for (const item of screen.getAllByRole("listitem")) {
      expect(item.className).toMatch(subgrid);
      expect((item.firstElementChild as HTMLElement).className).toMatch(subgrid);
    }
  });
});
