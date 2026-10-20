import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { FileText, Loader2, Lock, ShoppingCart, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useDemoSignUp } from "@/hooks/useDemoSignUp";
import type { PriceStatus } from "@/lib/api";
import {
  changeColor,
  formatCurrency,
  formatDate,
  formatSignedCurrency,
  formatSignedPercent,
  formatTimestampDate,
} from "@/lib/format";
import { earningsHourLabel, type WatchlistRow } from "@/lib/marketApi";

const PRICE_STATUS_LABEL: Record<PriceStatus, string> = {
  ok: "",
  not_found: "unknown ticker",
  unavailable: "price unavailable",
};

type Align = "left" | "right";
type ColumnKey =
  "company" | "price" | "today" | "sinceAdded" | "nextEarnings" | "report" | "actions";

/**
 * The columns, in order, with one alignment each: the header cell and every
 * value under it use it, so they can't disagree. Numbers right, text left.
 */
const COLUMNS: readonly { key: ColumnKey; label: string; align: Align }[] = [
  { key: "company", label: "Company", align: "left" },
  { key: "price", label: "Price", align: "right" },
  { key: "today", label: "Today", align: "right" },
  { key: "sinceAdded", label: "Since added", align: "right" },
  { key: "nextEarnings", label: "Next earnings", align: "left" },
  { key: "report", label: "Report", align: "left" },
  { key: "actions", label: "Actions", align: "right" },
];

const column = (key: ColumnKey) => COLUMNS.find((c) => c.key === key)!;

/** From md up: right-aligned text (and flex content) for right columns. */
function alignClass(align: Align): string {
  return align === "right" ? "md:text-right md:justify-end" : "md:text-left";
}

// One grid for the whole list (column tracks defined once); the header and
// every row are subgrids of it, so each value sits under its own header even
// though the actions column sizes to its content.
const LIST_GRID =
  "md:grid md:grid-cols-[minmax(0,2fr)_repeat(5,minmax(0,1fr))_auto] md:gap-x-4";
const ROW_GRID = "md:col-span-full md:grid md:grid-cols-subgrid md:items-center";

interface WatchlistListProps {
  rows: WatchlistRow[];
  onRemove: (row: WatchlistRow) => Promise<void>;
  onBought: (row: WatchlistRow) => void;
  /** Extra per-row actions (e.g. Ask AI), placed before "I bought it". */
  renderActions?: (row: WatchlistRow) => ReactNode;
}

/**
 * Watchlist rows. One markup for every width: on phones each company is a
 * card with labelled values; from md up the same rows line up as columns
 * under a header (the labels become screen-reader only).
 */
export function WatchlistList({
  rows,
  onRemove,
  onBought,
  renderActions,
}: WatchlistListProps) {
  return (
    <div className={LIST_GRID} data-testid="watchlist-grid">
      <div
        aria-hidden="true"
        data-testid="watchlist-header"
        className={`hidden border-b px-4 py-2 text-xs font-medium text-muted-foreground ${ROW_GRID}`}
      >
        {COLUMNS.map((c) => (
          <span key={c.key} data-column={c.key} className={alignClass(c.align)}>
            {c.label}
          </span>
        ))}
      </div>
      <ul aria-label="Watchlist" className={`divide-y ${ROW_GRID}`}>
        {rows.map((row) => (
          <WatchlistItem
            key={row.ticker}
            row={row}
            onRemove={onRemove}
            onBought={onBought}
            extraActions={renderActions?.(row)}
          />
        ))}
      </ul>
    </div>
  );
}

function WatchlistItem({
  row,
  onRemove,
  onBought,
  extraActions,
}: {
  row: WatchlistRow;
  onRemove: (row: WatchlistRow) => Promise<void>;
  onBought: (row: WatchlistRow) => void;
  extraActions?: ReactNode;
}) {
  const [removing, setRemoving] = useState(false);
  const label = row.name ?? row.ticker;
  return (
    <li
      aria-label={label === row.ticker ? row.ticker : `${label} (${row.ticker})`}
      className={`px-4 py-3 ${ROW_GRID}`}
    >
      <div className={`flex flex-col gap-3 ${ROW_GRID}`}>
        <div
          data-column="company"
          className={`min-w-0 ${alignClass(column("company").align)}`}
        >
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold">{row.ticker}</h3>
            {row.inPortfolio && (
              <span className="rounded bg-secondary px-1.5 py-0.5 text-xs text-secondary-foreground">
                In portfolio
              </span>
            )}
          </div>
          {row.name && (
            <p className="truncate text-xs text-muted-foreground">{row.name}</p>
          )}
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3 md:contents">
          <Field column="price">
            {row.price !== null ? (
              formatCurrency(row.price)
            ) : (
              <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                {PRICE_STATUS_LABEL[row.priceStatus]}
              </span>
            )}
          </Field>
          <Field column="today">
            {row.change !== null && row.changePercent !== null ? (
              <span className={changeColor(row.change)}>
                {formatSignedCurrency(row.change)}
                <span className="ml-1 text-xs">
                  ({formatSignedPercent(row.changePercent)})
                </span>
              </span>
            ) : (
              "—"
            )}
          </Field>
          <Field column="sinceAdded">
            {row.changeSinceAddedPercent !== null && row.changeSinceAdded !== null ? (
              <span>
                <span className={changeColor(row.changeSinceAdded)}>
                  {formatSignedPercent(row.changeSinceAddedPercent)}
                </span>
                <span className="block text-xs text-muted-foreground">
                  since {formatTimestampDate(row.addedPriceAt)}
                </span>
              </span>
            ) : (
              "—"
            )}
          </Field>
          <Field column="nextEarnings">
            {row.nextEarnings ? (
              <span>
                {formatDate(row.nextEarnings.date)}
                {earningsHourLabel(row.nextEarnings.hour) && (
                  <span className="block text-xs text-muted-foreground">
                    {earningsHourLabel(row.nextEarnings.hour)}
                  </span>
                )}
              </span>
            ) : (
              <span className="text-muted-foreground">None scheduled</span>
            )}
          </Field>
          <Field column="report">
            <ReportCell row={row} />
          </Field>
        </dl>

        <div
          data-column="actions"
          className={`flex flex-wrap items-center gap-1 ${alignClass(column("actions").align)}`}
        >
          {extraActions}
          <Button variant="outline" size="sm" onClick={() => onBought(row)}>
            <ShoppingCart />I bought it
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Remove ${row.ticker} from watchlist`}
            disabled={removing}
            onClick={() => {
              setRemoving(true);
              void onRemove(row).finally(() => setRemoving(false));
            }}
          >
            {removing ? <Loader2 className="animate-spin" /> : <Trash2 />}
          </Button>
        </div>
      </div>
    </li>
  );
}

/** One value, labelled on phones; from md up it's a cell under its header. */
function Field({ column: key, children }: { column: ColumnKey; children: ReactNode }) {
  const { label, align } = column(key);
  return (
    <div data-column={key} className={alignClass(align)}>
      <dt className="text-xs text-muted-foreground md:sr-only">{label}</dt>
      <dd className="tabular-nums">{children}</dd>
    </div>
  );
}

const REPORT_LABEL = {
  ready: "Report ready",
  outdated: "Older quarter",
  none: "No report",
};

const LINK_CLASS =
  "inline-flex items-center gap-1 rounded-sm font-medium text-brand-strong underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function ReportCell({ row }: { row: WatchlistRow }) {
  const { signUp, busy } = useDemoSignUp();
  const { status, demoLocked } = row.report;
  if (status === "none") {
    return <span className="text-muted-foreground">{REPORT_LABEL.none}</span>;
  }
  if (demoLocked) {
    return (
      <button
        type="button"
        onClick={() => void signUp()}
        disabled={busy}
        aria-label={`Sign up to view the ${row.ticker} report`}
        className={`${LINK_CLASS} disabled:opacity-50`}
      >
        <Lock aria-hidden="true" className="size-4" />
        Sign up to view
      </button>
    );
  }
  return (
    <span className="flex flex-col items-start">
      <Link
        to={`/reports/${encodeURIComponent(row.ticker)}`}
        aria-label={`View ${row.ticker} report`}
        className={LINK_CLASS}
      >
        <FileText aria-hidden="true" className="size-4" />
        View report
      </Link>
      <span className="text-xs text-muted-foreground">{REPORT_LABEL[status]}</span>
    </span>
  );
}
