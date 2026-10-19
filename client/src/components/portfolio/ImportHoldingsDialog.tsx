import { useEffect, useId, useRef, useState, type ChangeEvent } from "react";
import { Download, Loader2, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  IMPORT_MAX_FILE_BYTES,
  importHoldings,
  previewHoldingsImport,
  type ImportPreview,
} from "@/lib/api";
import { formatCurrency, formatDate, formatShares } from "@/lib/format";
import { cn } from "@/lib/utils";

interface ImportHoldingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the number of lots saved, so the parent can refresh. */
  onImported: (count: number) => void;
}

const TEMPLATE_URL = "/holdings-template.csv";

/** A file's text (UTF-8). */
function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("The file couldn't be read."));
    reader.readAsText(file);
  });
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
}

/**
 * Import holdings from a CSV: choose a file, review the valid rows and the
 * row-level errors, then confirm. Nothing is saved before the confirmation,
 * and the save is all or nothing.
 */
export function ImportHoldingsDialog({
  open,
  onOpenChange,
  onImported,
}: ImportHoldingsDialogProps) {
  const fileInputId = useId();
  const fileNameId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [skipErrors, setSkipErrors] = useState(false);
  const [busy, setBusy] = useState<"reading" | "saving" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setFileName(null);
      setPreview(null);
      setSkipErrors(false);
      setBusy(null);
      setError(null);
    }
  }, [open]);

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = ""; // choosing the same file again still fires
    if (!file) return;
    setFileName(file.name);
    setPreview(null);
    setSkipErrors(false);
    setError(null);
    if (file.size > IMPORT_MAX_FILE_BYTES) {
      setError(`The file is larger than ${IMPORT_MAX_FILE_BYTES / 1000} KB.`);
      return;
    }
    setBusy("reading");
    try {
      setPreview(await previewHoldingsImport(await readText(file)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  async function handleImport() {
    if (!preview) return;
    setBusy("saving");
    setError(null);
    try {
      const { imported } = await importHoldings(preview.rows);
      onImported(imported);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  const hasErrors = (preview?.errorRowCount ?? 0) > 0;
  const validCount = preview?.rows.length ?? 0;
  const canImport =
    preview !== null && validCount > 0 && (!hasErrors || skipErrors) && busy === null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import holdings from CSV</DialogTitle>
          <DialogDescription>
            Columns: ticker, quantity, price, purchase_date (2024-03-15 or 3/15/2024).
            Up to 500 rows and 100 KB. Nothing is saved until you confirm.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor={fileInputId}>CSV file</Label>
            {/* The native input is cleared after each pick (so the same file can
                be chosen again), so its own "No file chosen" text would be
                wrong; a button and the file's name stand in for it. */}
            <input
              ref={fileInputRef}
              id={fileInputId}
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => void handleFile(e)}
              disabled={busy !== null}
              tabIndex={-1}
              className="sr-only"
            />
            <div className="flex min-w-0 items-center gap-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={busy !== null}
                aria-describedby={fileNameId}
              >
                <Upload />
                Choose file
              </Button>
              <span
                id={fileNameId}
                className={cn(
                  "truncate text-sm",
                  fileName ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {fileName ?? "No file chosen"}
              </span>
            </div>
          </div>
          <a
            href={TEMPLATE_URL}
            download="holdings-template.csv"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-strong underline-offset-4 hover:underline"
          >
            <Download className="size-4" aria-hidden="true" />
            Download template
          </a>
        </div>

        {busy === "reading" && (
          <p
            role="status"
            className="flex items-center gap-2 text-sm text-muted-foreground"
          >
            <Loader2 className="size-4 animate-spin" /> Checking {fileName}…
          </p>
        )}

        {preview && <PreviewDetails preview={preview} />}

        {preview && hasErrors && validCount > 0 && (
          <label className="flex items-start gap-2 rounded-md border bg-muted p-3 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={skipErrors}
              onChange={(e) => setSkipErrors(e.target.checked)}
            />
            <span>
              Skip {plural(preview.errorRowCount, "row")} with errors and import the
              other {plural(validCount, "row")}.
            </span>
          </label>
        )}
        {preview && validCount === 0 && (
          <p className="text-sm">
            No rows can be imported. Fix the file and choose it again.
          </p>
        )}

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy === "saving"}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void handleImport()}
            disabled={!canImport}
          >
            {busy === "saving" && <Loader2 className="animate-spin" />}
            {validCount > 0 ? `Import ${plural(validCount, "holding")}` : "Import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PreviewDetails({ preview }: { preview: ImportPreview }) {
  const warningsByLine = new Map(preview.warnings.map((w) => [w.line, w.message]));
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">
        <span className="font-medium">
          {plural(preview.rows.length, "row")} of{" "}
          {preview.totalRows.toLocaleString("en-US")} ready to import.
        </span>
        {preview.errorRowCount > 0 && (
          <span className="text-destructive">
            {" "}
            {plural(preview.errorRowCount, "row")}{" "}
            {preview.errorRowCount === 1 ? "has" : "have"} errors.
          </span>
        )}
      </p>

      {preview.errors.length > 0 && (
        <section aria-labelledby="import-errors" className="flex flex-col gap-1">
          <h3 id="import-errors" className="text-sm font-medium text-destructive">
            Rows with errors
          </h3>
          <ul className="max-h-36 overflow-y-auto rounded-md border text-sm">
            {preview.errors.map((e) => (
              <li
                key={`${e.line}-${e.field}`}
                className="border-t px-3 py-1.5 first:border-t-0"
              >
                <span className="font-medium tabular-nums">Line {e.line}</span>
                <span className="text-muted-foreground"> · {e.field}: </span>
                {e.message}
              </li>
            ))}
          </ul>
        </section>
      )}

      {preview.rows.length > 0 && (
        <div className="max-h-64 overflow-auto rounded-md border">
          <table className="w-full text-sm tabular-nums">
            <caption className="sr-only">Rows ready to import</caption>
            <thead className="sticky top-0 bg-muted text-left text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-1.5 font-medium">
                  Line
                </th>
                <th scope="col" className="px-3 py-1.5 font-medium">
                  Ticker
                </th>
                <th scope="col" className="px-3 py-1.5 text-right font-medium">
                  Quantity
                </th>
                <th scope="col" className="px-3 py-1.5 text-right font-medium">
                  Price
                </th>
                <th scope="col" className="px-3 py-1.5 font-medium">
                  Purchase date
                </th>
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((row) => (
                <tr key={row.line} className="border-t">
                  <td className="px-3 py-1.5 text-muted-foreground">{row.line}</td>
                  <td className="px-3 py-1.5 font-medium">
                    {row.ticker}
                    {warningsByLine.has(row.line) && (
                      <div className="text-xs font-normal text-warning-foreground">
                        {warningsByLine.get(row.line)}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-right">{formatShares(row.shares)}</td>
                  <td className="px-3 py-1.5 text-right">
                    {formatCurrency(row.buyPrice)}
                  </td>
                  <td className="px-3 py-1.5">{formatDate(row.purchaseDate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
