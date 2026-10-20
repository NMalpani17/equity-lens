import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

vi.mock("@/context/auth-context", () => ({ useAuth: vi.fn() }));
vi.mock("@/lib/marketApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/marketApi")>()),
  searchSymbols: vi.fn(),
  getWatchlist: vi.fn(),
  addToWatchlist: vi.fn(),
  removeFromWatchlist: vi.fn(),
  getUpcomingEarnings: vi.fn(),
}));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  createHolding: vi.fn(),
}));

import { useAuth } from "@/context/auth-context";
import { ApiError, createHolding } from "@/lib/api";
import * as marketApi from "@/lib/marketApi";
import type { UpcomingEarnings, WatchlistRow } from "@/lib/marketApi";
import { WatchlistPage } from "./WatchlistPage";

const api = vi.mocked(marketApi);

function row(overrides: Partial<WatchlistRow> = {}): WatchlistRow {
  return {
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
    ...overrides,
  };
}

const JPM = row({
  ticker: "JPM",
  name: "JPMorgan Chase & Co",
  price: 300,
  change: -3,
  changePercent: -0.99,
  changeSinceAdded: -10,
  changeSinceAddedPercent: -3.23,
  nextEarnings: null,
  report: { status: "outdated", demoLocked: false },
});

function renderPage(isDemo = false) {
  vi.mocked(useAuth).mockReturnValue({
    isDemo,
    user: isDemo ? null : { email: "a@example.com" },
    signOut: vi.fn(),
  } as never);
  return render(
    <MemoryRouter initialEntries={["/watchlist"]}>
      <Routes>
        <Route path="/watchlist" element={<WatchlistPage />} />
        <Route path="/reports/:ticker" element={<p>Report page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

const item = (name: RegExp) => screen.findByRole("listitem", { name });

beforeEach(() => {
  vi.clearAllMocks();
  api.searchSymbols.mockResolvedValue({ results: [], ready: true });
  api.getWatchlist.mockResolvedValue({ items: [row(), JPM], limit: 50 });
  api.addToWatchlist.mockResolvedValue({});
  api.removeFromWatchlist.mockResolvedValue(undefined);
  api.getUpcomingEarnings.mockResolvedValue(calendar());
});

function calendar(overrides: Partial<UpcomingEarnings> = {}): UpcomingEarnings {
  return {
    earnings: [
      {
        ticker: "MSFT",
        name: "Microsoft Corp",
        date: "2026-10-28",
        hour: "amc",
        epsEstimate: 3.6,
        source: "holding",
      },
      {
        ticker: "AMD",
        name: "Advanced Micro Devices",
        date: "2026-11-03",
        hour: null,
        epsEstimate: null,
        source: "both",
      },
    ],
    unscheduled: [
      { ticker: "VOO", name: "Vanguard S&P 500 ETF", source: "holding" },
      { ticker: "JPM", name: "JPMorgan Chase & Co", source: "watchlist" },
    ],
    windowStart: "2026-10-20",
    windowEnd: "2026-12-19",
    refreshedAt: "2026-10-20T13:00:00Z",
    refreshing: false,
    available: true,
    ...overrides,
  };
}

const earningsList = async () =>
  within(await screen.findByRole("list", { name: "Upcoming earnings" }));
const earningsSection = () =>
  within(screen.getByRole("region", { name: "Upcoming earnings" }));

describe("Upcoming earnings", () => {
  it("lists dates, sessions, estimates and where each ticker comes from", async () => {
    renderPage();

    const list = await earningsList();
    const [msft, amd] = list.getAllByRole("listitem");
    expect(msft).toHaveTextContent("Oct 28, 2026");
    expect(msft).toHaveTextContent("After close");
    expect(msft).toHaveTextContent("MSFT");
    expect(msft).toHaveTextContent("EPS est. $3.60");
    expect(msft).toHaveTextContent("Holding");
    expect(amd).toHaveTextContent("Nov 3, 2026");
    expect(amd).toHaveTextContent("No EPS estimate");
    expect(amd).toHaveTextContent("Holding · Watching");
    expect(
      earningsSection().getByText("No date in the next 60 days: VOO, JPM"),
    ).toBeInTheDocument();
  });

  it("says when nothing is scheduled", async () => {
    api.getUpcomingEarnings.mockResolvedValue(calendar({ earnings: [] }));
    renderPage();

    expect(
      await screen.findByText("No earnings scheduled in the next 60 days."),
    ).toBeInTheDocument();
  });

  it("says when the calendar is still loading for the first time", async () => {
    api.getUpcomingEarnings.mockResolvedValue(
      calendar({ earnings: [], refreshing: true, refreshedAt: null }),
    );
    renderPage();

    expect(
      await screen.findByText("Earnings dates are updating. Check back in a minute."),
    ).toBeInTheDocument();
  });

  it("says when the calendar is unavailable", async () => {
    api.getUpcomingEarnings.mockResolvedValue(
      calendar({ earnings: [], available: false }),
    );
    renderPage();

    expect(
      await screen.findByText("Earnings dates are unavailable right now."),
    ).toBeInTheDocument();
  });

  it("explains an empty calendar with nothing held or watched", async () => {
    api.getUpcomingEarnings.mockResolvedValue(
      calendar({ earnings: [], unscheduled: [] }),
    );
    renderPage();

    expect(
      await screen.findByText(
        "Add holdings or watch companies to see their earnings dates.",
      ),
    ).toBeInTheDocument();
  });

  it("reloads after the watchlist changes", async () => {
    renderPage();
    await item(/AMD/);
    await earningsList();

    fireEvent.click(screen.getByRole("button", { name: "Remove AMD from watchlist" }));

    await waitFor(() => expect(api.getUpcomingEarnings).toHaveBeenCalledTimes(2));
  });
});

describe("Ask AI", () => {
  it("opens a new chat with a question about the company ready to send", async () => {
    renderPage();

    const link = within(await item(/AMD/)).getByRole("link", {
      name: "Ask AI about AMD",
    });
    const url = new URL(link.getAttribute("href")!, "http://localhost");
    expect(url.pathname).toBe("/chat");
    expect(url.searchParams.get("ask")).toBe(
      "I'm considering Advanced Micro Devices (AMD). What did management say on the latest earnings call, and how has the stock done recently?",
    );
  });
});

describe("WatchlistPage", () => {
  it("shows each company with price, changes, earnings and report", async () => {
    renderPage();

    const amd = within(await item(/Advanced Micro Devices \(AMD\)/));
    expect(amd.getByText("$165.00")).toBeInTheDocument();
    expect(amd.getByText("+$5.00")).toHaveClass("text-gain");
    expect(amd.getByText("+10.00%")).toHaveClass("text-gain");
    expect(amd.getByText("since Oct 1, 2026")).toBeInTheDocument();
    expect(amd.getByText("Nov 3, 2026")).toBeInTheDocument();
    expect(amd.getByText("After close")).toBeInTheDocument();
    expect(amd.getByRole("link", { name: "View AMD report" })).toHaveAttribute(
      "href",
      "/reports/AMD",
    );
    expect(amd.getByText("Report ready")).toBeInTheDocument();

    const jpm = within(await item(/JPMorgan/));
    expect(jpm.getByText("-$3.00")).toHaveClass("text-loss");
    expect(jpm.getByText("-3.23%")).toHaveClass("text-loss");
    expect(jpm.getByText("None scheduled")).toBeInTheDocument();
    expect(jpm.getByText("Older quarter")).toBeInTheDocument();
  });

  it("labels each value for phones and screen readers", async () => {
    renderPage();

    const amd = within(await item(/AMD/));
    for (const label of ["Price", "Today", "Since added", "Next earnings", "Report"]) {
      expect(amd.getByText(label, { selector: "dt" })).toBeInTheDocument();
    }
  });

  it("asks demo users to sign up for reports outside the demo list", async () => {
    api.getWatchlist.mockResolvedValue({
      items: [
        row({
          ticker: "NFLX",
          name: "Netflix Inc",
          report: { status: "ready", demoLocked: true },
        }),
        row({ report: { status: "ready", demoLocked: false } }),
      ],
      limit: 50,
    });
    renderPage(true);

    const nflx = within(await item(/Netflix/));
    expect(
      nflx.getByRole("button", { name: "Sign up to view the NFLX report" }),
    ).toBeInTheDocument();
    expect(
      nflx.queryByRole("link", { name: /View NFLX report/ }),
    ).not.toBeInTheDocument();
    const amd = within(await item(/AMD/));
    expect(amd.getByRole("link", { name: "View AMD report" })).toBeInTheDocument();
  });

  it("shows no report link without a report, and price trouble plainly", async () => {
    api.getWatchlist.mockResolvedValue({
      items: [
        row({
          ticker: "ZZZZ",
          name: null,
          price: null,
          change: null,
          changePercent: null,
          priceStatus: "unavailable",
          changeSinceAdded: null,
          changeSinceAddedPercent: null,
          report: { status: "none", demoLocked: true },
        }),
      ],
      limit: 50,
    });
    renderPage(true);

    const zzzz = within(await item(/ZZZZ/));
    expect(zzzz.getByText("price unavailable")).toBeInTheDocument();
    expect(zzzz.getByText("No report")).toBeInTheDocument();
    expect(zzzz.queryByRole("link", { name: /report/ })).not.toBeInTheDocument();
    expect(zzzz.queryByRole("button", { name: /Sign up/ })).not.toBeInTheDocument();
  });

  it("adds an exact ticker and reloads", async () => {
    renderPage();
    await item(/AMD/);

    const input = screen.getByRole("combobox", { name: "Add a company" });
    fireEvent.change(input, { target: { value: "nvda" } });
    fireEvent.click(screen.getByRole("button", { name: "Add to watchlist" }));

    await waitFor(() => expect(api.addToWatchlist).toHaveBeenCalledWith("NVDA"));
    expect(
      await screen.findByText("Added NVDA to your watchlist."),
    ).toBeInTheDocument();
    expect(api.getWatchlist).toHaveBeenCalledTimes(2);
    expect(input).toHaveValue("");
  });

  it("shows the API's message when the add is refused", async () => {
    api.addToWatchlist.mockRejectedValue(
      new ApiError(409, "AMD is already on your watchlist.", "already_watching"),
    );
    renderPage();
    await item(/AMD/);

    fireEvent.change(screen.getByRole("combobox", { name: "Add a company" }), {
      target: { value: "AMD" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add to watchlist" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "AMD is already on your watchlist.",
    );
  });

  it("disables adding at the limit", async () => {
    api.getWatchlist.mockResolvedValue({ items: [row()], limit: 1 });
    renderPage();

    expect(
      await screen.findByText(/You're watching 1 companies, the most allowed/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add to watchlist" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Add a company" })).toBeDisabled();
  });

  it("removes a company", async () => {
    api.getWatchlist
      .mockResolvedValueOnce({ items: [row(), JPM], limit: 50 })
      .mockResolvedValue({ items: [JPM], limit: 50 });
    renderPage();
    await item(/AMD/);

    fireEvent.click(screen.getByRole("button", { name: "Remove AMD from watchlist" }));

    await waitFor(() =>
      expect(screen.queryByRole("listitem", { name: /AMD/ })).not.toBeInTheDocument(),
    );
    expect(api.removeFromWatchlist).toHaveBeenCalledWith("AMD");
  });

  it("opens Add holding with the ticker when you bought it", async () => {
    vi.mocked(createHolding).mockResolvedValue({} as never);
    renderPage();
    await item(/JPM/);

    fireEvent.click(
      within(await item(/JPMorgan/)).getByRole("button", { name: "I bought it" }),
    );

    const dialog = await screen.findByRole("dialog", { name: "Add holding" });
    expect(within(dialog).getByRole("combobox", { name: "Ticker" })).toHaveValue("JPM");
    fireEvent.change(within(dialog).getByLabelText("Shares"), {
      target: { value: "3" },
    });
    fireEvent.change(within(dialog).getByLabelText("Buy price (USD)"), {
      target: { value: "300" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add holding" }));

    await waitFor(() =>
      expect(createHolding).toHaveBeenCalledWith(
        expect.objectContaining({ ticker: "JPM", shares: 3, buyPrice: 300 }),
      ),
    );
    expect(await screen.findByText("Added JPM to your portfolio.")).toBeInTheDocument();
  });

  it("marks companies the user also holds", async () => {
    api.getWatchlist.mockResolvedValue({
      items: [row({ inPortfolio: true })],
      limit: 50,
    });
    renderPage();

    expect(within(await item(/AMD/)).getByText("In portfolio")).toBeInTheDocument();
  });

  it("explains an empty watchlist", async () => {
    api.getWatchlist.mockResolvedValue({ items: [], limit: 50 });
    renderPage();

    expect(await screen.findByText("No companies yet")).toBeInTheDocument();
  });

  it("offers a retry when loading fails", async () => {
    api.getWatchlist.mockRejectedValueOnce(
      new ApiError(0, "We couldn't reach Equity Lens."),
    );
    renderPage();

    expect(
      await screen.findByText("Couldn't load your watchlist."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await item(/AMD/)).toBeInTheDocument();
  });
});
