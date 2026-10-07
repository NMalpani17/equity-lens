import type { ReportSummary } from "@/lib/reportsApi";

function status(item: ReportSummary): string {
  if (item.generating) return "generating";
  if (!item.report) return "no report yet";
  return item.report.outdated ? "older quarter" : "report ready";
}

/**
 * The company to show. A native select: it works with any screen reader and
 * opens the phone's own picker on mobile.
 */
export function TickerPicker({
  tickers,
  value,
  onChange,
  disabled,
}: {
  tickers: ReportSummary[];
  value: string | undefined;
  onChange: (ticker: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex w-full flex-col gap-1.5 sm:w-80">
      <label htmlFor="report-ticker" className="text-sm font-medium">
        Company
      </label>
      <select
        id="report-ticker"
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
      >
        {!value && (
          <option value="" disabled>
            Choose a company
          </option>
        )}
        {tickers.map((item) => (
          <option key={item.ticker} value={item.ticker}>
            {item.ticker} · {item.companyName} ({status(item)})
          </option>
        ))}
      </select>
    </div>
  );
}
