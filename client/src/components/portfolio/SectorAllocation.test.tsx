import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import type { SectorAllocation as Allocation } from "@/lib/api";
import { SectorAllocation } from "./SectorAllocation";

const allocation: Allocation = {
  totalMarketValue: 10_000,
  sectors: [
    {
      sector: "Information Technology",
      marketValue: 6000,
      weightPercent: 60,
      holdings: [
        { ticker: "AAPL", name: "Apple Inc", marketValue: 4000 },
        { ticker: "NVDA", name: null, marketValue: 2000 },
      ],
    },
    {
      sector: "Funds",
      marketValue: 3000,
      weightPercent: 30,
      holdings: [{ ticker: "VOO", name: null, marketValue: 3000 }],
    },
    {
      sector: "Other",
      marketValue: 1000,
      weightPercent: 10,
      holdings: [{ ticker: "ODD", name: null, marketValue: 1000 }],
    },
  ],
  unpricedTickers: ["DOWN"],
  pendingTickers: ["ODD"],
};

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

beforeAll(async () => {
  await import("./SectorBars");
}, 60_000);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SectorAllocation", () => {
  it("lists each sector with its value, share and holdings", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(respond(allocation));

    render(<SectorAllocation version={0} />);

    const table = await screen.findByRole("table", {
      name: "Sector allocation by market value",
    });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => within(row).getByRole("rowheader").textContent)).toEqual([
      "Information TechnologyAAPL, NVDA",
      "FundsVOO",
      "OtherODD",
    ]);
    expect(within(rows[0]!).getByText("$6,000.00")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("60.0%")).toBeInTheDocument();
  });

  it("notes unpriced holdings and sectors still being looked up", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(respond(allocation));

    render(<SectorAllocation version={0} />);

    expect(
      await screen.findByText("Not included (no current price): DOWN."),
    ).toBeInTheDocument();
    expect(screen.getByText(/Still looking up sectors for ODD/)).toBeInTheDocument();
  });

  it("has an empty state", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      respond({ ...allocation, sectors: [], pendingTickers: [] }),
    );

    render(<SectorAllocation version={0} />);

    expect(
      await screen.findByText("No priced holdings to group yet."),
    ).toBeInTheDocument();
  });

  it("shows an error with a retry", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(respond({ message: "Sector data is unavailable." }, 502))
      .mockResolvedValueOnce(respond(allocation));

    render(<SectorAllocation version={0} />);
    expect(await screen.findByText("Sector data is unavailable.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(
      await screen.findByRole("table", { name: "Sector allocation by market value" }),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
