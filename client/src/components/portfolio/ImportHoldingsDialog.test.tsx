import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { ImportPreview } from "@/lib/api";
import { ImportHoldingsDialog } from "./ImportHoldingsDialog";

const CSV =
  "ticker,quantity,price,purchase_date\nAAPL,10,172.40,2024-02-12\nMSFT,x,1,2024-01-02";

const previewWithErrors: ImportPreview = {
  rows: [
    {
      line: 2,
      ticker: "AAPL",
      shares: 10,
      buyPrice: 172.4,
      purchaseDate: "2024-02-12",
    },
    { line: 4, ticker: "NEWCO", shares: 1, buyPrice: 5, purchaseDate: "2024-01-02" },
  ],
  errors: [{ line: 3, field: "quantity", message: "quantity must be a number" }],
  warnings: [{ line: 4, message: "NEWCO couldn't be checked right now." }],
  totalRows: 3,
  errorRowCount: 1,
};

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function renderDialog() {
  const onImported = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <ImportHoldingsDialog open onOpenChange={onOpenChange} onImported={onImported} />,
  );
  return { onImported, onOpenChange };
}

function chooseFile(contents = CSV, name = "holdings.csv") {
  const file = new File([contents], name, { type: "text/csv" });
  fireEvent.change(screen.getByLabelText("CSV file"), { target: { files: [file] } });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ImportHoldingsDialog", () => {
  it("offers the template download", () => {
    renderDialog();

    expect(screen.getByRole("link", { name: "Download template" })).toHaveAttribute(
      "href",
      "/holdings-template.csv",
    );
  });

  it("previews the file, then imports the valid rows after the skip confirmation", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(respond(previewWithErrors))
      .mockResolvedValueOnce(respond({ imported: 2 }, 201));
    const { onImported, onOpenChange } = renderDialog();

    chooseFile();

    expect(await screen.findByText("2 rows of 3 ready to import.")).toBeInTheDocument();
    expect(screen.getByText("quantity must be a number")).toBeInTheDocument();
    expect(
      screen.getByText("NEWCO couldn't be checked right now."),
    ).toBeInTheDocument();
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({ csv: CSV });

    const importButton = screen.getByRole("button", { name: "Import 2 holdings" });
    expect(importButton).toBeDisabled();
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Skip 1 row with errors and import the other 2 rows.",
      }),
    );
    fireEvent.click(importButton);

    await waitFor(() => expect(onImported).toHaveBeenCalledWith(2));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(String(url)).toContain("/api/holdings/import");
    expect(JSON.parse(String(init?.body))).toEqual({
      rows: [
        { ticker: "AAPL", shares: 10, buyPrice: 172.4, purchaseDate: "2024-02-12" },
        { ticker: "NEWCO", shares: 1, buyPrice: 5, purchaseDate: "2024-01-02" },
      ],
    });
  });

  it("imports right away when every row is valid", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      respond({ ...previewWithErrors, errors: [], warnings: [], errorRowCount: 0 }),
    );
    renderDialog();

    chooseFile();

    expect(
      await screen.findByRole("button", { name: "Import 2 holdings" }),
    ).toBeEnabled();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("can't import when no row is valid", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      respond({ ...previewWithErrors, rows: [], warnings: [], errorRowCount: 3 }),
    );
    renderDialog();

    chooseFile();

    expect(
      await screen.findByText(
        "No rows can be imported. Fix the file and choose it again.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import" })).toBeDisabled();
  });

  it("rejects a file over the size limit without uploading it", () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    renderDialog();

    chooseFile("x".repeat(100_001));

    expect(screen.getByRole("alert")).toHaveTextContent("larger than 100 KB");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows a file-level error from the server", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      respond(
        {
          error: "invalid_csv_header",
          message: "The file is missing the price column.",
        },
        422,
      ),
    );
    renderDialog();

    chooseFile();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The file is missing the price column.",
    );
  });

  it("keeps the dialog open when the save fails", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        respond({ ...previewWithErrors, errors: [], warnings: [], errorRowCount: 0 }),
      )
      .mockResolvedValueOnce(
        respond(
          {
            error: "holding_limit_reached",
            message: "You can have up to 1,000 holdings.",
          },
          409,
        ),
      );
    const { onImported, onOpenChange } = renderDialog();

    chooseFile();
    fireEvent.click(await screen.findByRole("button", { name: "Import 2 holdings" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "You can have up to 1,000 holdings.",
    );
    expect(onImported).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
