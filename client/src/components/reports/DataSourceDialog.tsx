import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { changeColor, formatDate, formatSignedPercent } from "@/lib/format";
import type { DataSource } from "@/lib/reportsApi";

type Kind = "price" | "percent" | "date" | "change" | "changePercent";

const FIELDS: { key: string; label: string; kind: Kind }[] = [
  { key: "price", label: "Price", kind: "price" },
  { key: "previous_close", label: "Previous close", kind: "price" },
  { key: "change", label: "Change", kind: "change" },
  { key: "change_percent", label: "Change %", kind: "changePercent" },
  { key: "start_date", label: "From", kind: "date" },
  { key: "end_date", label: "To", kind: "date" },
  { key: "first_close", label: "First close", kind: "price" },
  { key: "last_close", label: "Last close", kind: "price" },
  { key: "high", label: "High", kind: "price" },
  { key: "high_date", label: "High on", kind: "date" },
  { key: "low", label: "Low", kind: "price" },
  { key: "low_date", label: "Low on", kind: "date" },
];

function money(value: number, currency: string): string {
  return value.toLocaleString("en-US", { style: "currency", currency });
}

function show(value: unknown, kind: Kind, currency: string) {
  if (kind === "date") return formatDate(typeof value === "string" ? value : null);
  if (typeof value !== "number") return String(value);
  if (kind === "percent") return `${value.toFixed(2)}%`;
  // Changes carry their direction, as on the price chart: "+$3.04", "-0.77%".
  if (kind === "changePercent") return formatSignedPercent(value);
  if (kind === "change") {
    const sign = value > 0 ? "+" : value < 0 ? "-" : "";
    return `${sign}${money(Math.abs(value), currency)}`;
  }
  return money(value, currency);
}

function valueColor(value: unknown, kind: Kind): string {
  const signed = kind === "change" || kind === "changePercent";
  return signed && typeof value === "number" ? changeColor(value) : "";
}

/** The market-data tool result behind a [Dn] reference in a report. */
export function DataSourceDialog({
  source,
  onOpenChange,
}: {
  source: DataSource | null;
  onOpenChange: (open: boolean) => void;
}) {
  const currency =
    typeof source?.data.currency === "string" ? source.data.currency : "USD";
  return (
    <Dialog open={source !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        {source && (
          <>
            <DialogHeader>
              <DialogTitle>
                [{source.id}] {source.label}
              </DialogTitle>
              <DialogDescription>
                {source.kind === "quote" ? "Market quote" : "Price history"}
                {source.asOf ? ` · as of ${source.asOf}` : ""}
              </DialogDescription>
            </DialogHeader>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              {FIELDS.filter((f) => source.data[f.key] !== undefined).map((field) => (
                <div key={field.key} className="contents">
                  <dt className="text-muted-foreground">{field.label}</dt>
                  <dd
                    className={`tabular-nums ${valueColor(source.data[field.key], field.kind)}`}
                  >
                    {show(source.data[field.key], field.kind, currency)}
                  </dd>
                </div>
              ))}
            </dl>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
