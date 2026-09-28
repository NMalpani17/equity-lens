import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { HoldingFormDialog } from "./HoldingFormDialog";
import { todayISODate } from "@/lib/format";

afterEach(() => {
  vi.restoreAllMocks();
});

function renderAdd(onSaved = vi.fn(), onOpenChange = vi.fn()) {
  render(
    <HoldingFormDialog open onOpenChange={onOpenChange} lot={null} onSaved={onSaved} />,
  );
  return { onSaved, onOpenChange };
}

describe("HoldingFormDialog", () => {
  it("validates input before calling the API", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    renderAdd();

    fireEvent.change(screen.getByLabelText("Ticker"), {
      target: { value: "AAPL" },
    });
    // Leave shares empty.
    fireEvent.click(screen.getByRole("button", { name: "Add holding" }));

    expect(
      await screen.findByText("Shares must be a number greater than 0."),
    ).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("submits a valid holding and notifies the parent", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "1",
          ticker: "AAPL",
          shares: 10,
          buyPrice: 150,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
        { status: 201 },
      ),
    );
    const { onSaved } = renderAdd();

    fireEvent.change(screen.getByLabelText("Ticker"), {
      target: { value: "aapl" },
    });
    fireEvent.change(screen.getByLabelText("Shares"), {
      target: { value: "10" },
    });
    fireEvent.change(screen.getByLabelText("Buy price (USD)"), {
      target: { value: "150" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add holding" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());

    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toMatchObject({
      ticker: "AAPL", // normalized to uppercase
      shares: 10,
      buyPrice: 150,
      purchaseDate: todayISODate(), // pre-filled with today by default
    });
  });

  it("pre-fills the purchase date with today when adding", () => {
    renderAdd();

    const input = screen.getByLabelText<HTMLInputElement>("Purchase date (optional)");
    expect(input.value).toBe(todayISODate());
    // Future dates are capped by the input's max attribute.
    expect(input.max).toBe(todayISODate());
  });

  it("does not allow submitting a future purchase date", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    renderAdd();

    const future = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    const dateInput = screen.getByLabelText<HTMLInputElement>(
      "Purchase date (optional)",
    );
    fireEvent.change(screen.getByLabelText("Ticker"), { target: { value: "AAPL" } });
    fireEvent.change(screen.getByLabelText("Shares"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("Buy price (USD)"), {
      target: { value: "150" },
    });
    fireEvent.change(dateInput, { target: { value: future } });

    // A future date is out of range (max=today), so the field is invalid and
    // the form will not submit — the holding never reaches the API.
    expect(dateInput.validity.rangeOverflow).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Add holding" }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("submits an optional purchase date when provided", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "1",
          ticker: "AAPL",
          shares: 10,
          buyPrice: 150,
          purchaseDate: "2026-01-15",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
        { status: 201 },
      ),
    );
    renderAdd();

    fireEvent.change(screen.getByLabelText("Ticker"), { target: { value: "AAPL" } });
    fireEvent.change(screen.getByLabelText("Shares"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("Buy price (USD)"), {
      target: { value: "150" },
    });
    fireEvent.change(screen.getByLabelText("Purchase date (optional)"), {
      target: { value: "2026-01-15" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add holding" }));

    await waitFor(() => expect(vi.mocked(globalThis.fetch)).toHaveBeenCalled());
    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toMatchObject({
      purchaseDate: "2026-01-15",
    });
  });

  it("surfaces the API's error message when the ticker is rejected", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "invalid_ticker",
          message: "'ASDASD' is not a recognized ticker symbol.",
        }),
        { status: 422, headers: { "Content-Type": "application/json" } },
      ),
    );
    renderAdd();

    fireEvent.change(screen.getByLabelText("Ticker"), {
      target: { value: "ASDASD" },
    });
    fireEvent.change(screen.getByLabelText("Shares"), {
      target: { value: "10" },
    });
    fireEvent.change(screen.getByLabelText("Buy price (USD)"), {
      target: { value: "150" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add holding" }));

    expect(
      await screen.findByText("'ASDASD' is not a recognized ticker symbol."),
    ).toBeInTheDocument();
  });
});
