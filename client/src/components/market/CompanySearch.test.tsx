import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/marketApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/marketApi")>()),
  searchSymbols: vi.fn(),
}));

import { CompanySearch } from "./CompanySearch";
import { searchSymbols, type SymbolMatch } from "@/lib/marketApi";

const searchMock = vi.mocked(searchSymbols);

const MSFT: SymbolMatch = {
  ticker: "MSFT",
  name: "Microsoft Corp",
  type: "stock",
  exchange: "XNAS",
};
const MCHP: SymbolMatch = {
  ticker: "MCHP",
  name: "Microchip Technology Inc",
  type: "stock",
  exchange: "XNAS",
};
const FNGU: SymbolMatch = {
  ticker: "FNGU",
  name: "MicroSectors FANG+ 3X Leveraged ETN",
  type: "etf",
  exchange: "OOTC",
};

function Harness({
  onSelect = vi.fn(),
  onSubmit = vi.fn(),
}: {
  onSelect?: (match: SymbolMatch) => void;
  onSubmit?: () => void;
}) {
  const [value, setValue] = useState("");
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <label htmlFor="company">Company</label>
      <CompanySearch
        id="company"
        value={value}
        onChange={setValue}
        onSelect={onSelect}
      />
      <span data-testid="value">{value}</span>
    </form>
  );
}

function setup(props: Parameters<typeof Harness>[0] = {}) {
  render(<Harness {...props} />);
  const input = screen.getByRole("combobox", { name: "Company" });
  input.focus();
  return input;
}

function type(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } });
}

beforeEach(() => {
  vi.clearAllMocks();
  searchMock.mockResolvedValue({ results: [MSFT, MCHP, FNGU], ready: true });
});

describe("CompanySearch", () => {
  it("is an ARIA combobox controlling a labelled listbox", () => {
    const input = setup();

    expect(input).toHaveAttribute("aria-autocomplete", "list");
    expect(input).toHaveAttribute("aria-expanded", "false");
    const listbox = document.getElementById(input.getAttribute("aria-controls")!);
    expect(listbox).toHaveAttribute("role", "listbox");
    expect(listbox).toHaveAttribute("aria-label", "Company suggestions");
  });

  it("suggests companies as you type, searching once after typing stops", async () => {
    const input = setup();

    for (const partial of ["m", "mi", "mic", "micr", "micro"]) type(input, partial);

    expect(
      await screen.findByRole("option", { name: "Microsoft Corp (MSFT)" }),
    ).toBeInTheDocument();
    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(searchMock.mock.calls[0]![0]).toBe("micro");
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("status")).toHaveTextContent("3 suggestions");
  });

  it("labels ETFs and over-the-counter listings", async () => {
    type(setup(), "micro");

    const option = await screen.findByRole("option", {
      name: /MicroSectors FANG\+ 3X Leveraged ETN \(FNGU\)/,
    });
    expect(option).toHaveTextContent("ETF · OTC");
  });

  it("moves with the arrow keys and picks with Enter", async () => {
    const onSelect = vi.fn();
    const input = setup({ onSelect });
    type(input, "micro");
    await screen.findAllByRole("option");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const second = screen.getByRole("option", { name: /MCHP/ });
    expect(second).toHaveAttribute("aria-selected", "true");
    expect(input).toHaveAttribute("aria-activedescendant", second.id);

    // false: Enter was prevented, so it picks rather than submitting the form.
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false);

    expect(onSelect).toHaveBeenCalledWith(MCHP);
    expect(screen.getByTestId("value")).toHaveTextContent("MCHP");
    expect(input).toHaveAttribute("aria-expanded", "false");
  });

  it("wraps from the top with ArrowUp", async () => {
    const input = setup();
    type(input, "micro");
    await screen.findAllByRole("option");

    fireEvent.keyDown(input, { key: "ArrowUp" });

    expect(screen.getByRole("option", { name: /FNGU/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("closes with Escape without picking", async () => {
    const onSelect = vi.fn();
    const input = setup({ onSelect });
    type(input, "micro");
    await screen.findAllByRole("option");

    fireEvent.keyDown(input, { key: "Escape" });

    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
    // Typing again reopens it.
    type(input, "micros");
    expect(await screen.findAllByRole("option")).toHaveLength(3);
  });

  it("picks a suggestion with a click", async () => {
    const onSelect = vi.fn();
    const input = setup({ onSelect });
    type(input, "micro");

    fireEvent.click(await screen.findByRole("option", { name: /MSFT/ }));

    expect(onSelect).toHaveBeenCalledWith(MSFT);
    expect(screen.getByTestId("value")).toHaveTextContent("MSFT");
  });

  it("leaves Enter to the form when nothing is highlighted (exact ticker)", async () => {
    const onSelect = vi.fn();
    const input = setup({ onSelect });
    type(input, "BRK.B");
    await screen.findAllByRole("option"); // suggestions open, none highlighted

    // fireEvent returns false only if a handler called preventDefault; here
    // it's left alone, so the browser submits the form with "BRK.B".
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(true);
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByTestId("value")).toHaveTextContent("BRK.B");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false); // picked instead
  });

  it("says when nothing matches", async () => {
    searchMock.mockResolvedValue({ results: [], ready: true });
    type(setup(), "zzzzqqq");

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "No matching companies. You can still enter an exact ticker.",
      ),
    );
  });

  it("says when suggestions are unavailable", async () => {
    searchMock.mockRejectedValue(new Error("offline"));
    type(setup(), "msft");

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Suggestions are unavailable. Enter the exact ticker.",
      ),
    );
  });

  it("never shows results for an older query", async () => {
    let resolveFirst: (value: {
      results: SymbolMatch[];
      ready: boolean;
    }) => void = () => {};
    searchMock
      .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
      .mockResolvedValueOnce({ results: [MSFT], ready: true });
    const input = setup();

    type(input, "mic");
    await waitFor(() => expect(searchMock).toHaveBeenCalledTimes(1));
    type(input, "microsoft");
    await screen.findByRole("option", { name: /MSFT/ });
    resolveFirst({ results: [MCHP], ready: true }); // the slow, stale answer

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("option", { name: /MCHP/ })).not.toBeInTheDocument();
    expect(searchMock.mock.calls[0]![1]?.aborted).toBe(true);
  });
});
