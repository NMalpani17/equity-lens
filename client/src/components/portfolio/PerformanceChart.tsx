import { lazy, Suspense, useCallback, useState, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

import { ChartData } from "@/components/chat/charts/ChartData";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { usePortfolioInsight } from "@/hooks/usePortfolioInsight";
import {
  PERFORMANCE_RANGES,
  getPortfolioPerformance,
  type PerformanceRange,
  type PortfolioPerformance,
} from "@/lib/api";
import { dateLabel } from "@/lib/chartFormat";
import { changeColor, formatCurrency, formatSignedPercent } from "@/lib/format";
import { cn } from "@/lib/utils";
import { LineSwatch } from "./LineSwatch";

// Recharts is downloaded only once there is a series to plot.
const PerformancePlot = lazy(() => import("./PerformancePlot"));

const PLOT_HEIGHT = 240;
const BENCHMARK_LABEL = "S&P 500";
const RANGE_LABELS: Record<PerformanceRange, string> = {
  "1M": "1M",
  "3M": "3M",
  "6M": "6M",
  "1Y": "1Y",
  ALL: "All",
};
const RANGE_NAMES: Record<PerformanceRange, string> = {
  "1M": "1 month",
  "3M": "3 months",
  "6M": "6 months",
  "1Y": "1 year",
  ALL: "All time",
};

function returnLabel(value: number | null): string {
  return value === null ? "—" : formatSignedPercent(value);
}

/** Portfolio value over time vs the S&P 500, both as % price return. */
export function PerformanceChart({ version }: { version: number }) {
  const [range, setRange] = useState<PerformanceRange>("1Y");
  const [attempt, setAttempt] = useState(0);
  const load = useCallback(() => getPortfolioPerformance(range), [range]);
  // Holdings changed (`version`) or a retry (`attempt`): reload the same range.
  const { state, updating } = usePortfolioInsight(load, `${version}:${attempt}`);

  return (
    <Card className="min-w-0">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="text-base">Performance</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            Price return vs the {BENCHMARK_LABEL} (SPY). Dividends aren't included.
          </p>
        </div>
        <RangePicker value={range} onChange={setRange} />
      </CardHeader>
      <CardContent>
        {state.kind === "loading" && <PlotPlaceholder label="Loading performance" />}
        {state.kind === "error" && (
          <div className="flex items-center gap-3 py-8 text-sm text-destructive">
            <AlertTriangle className="size-4 shrink-0" />
            <span>{state.message}</span>
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              onClick={() => setAttempt((n) => n + 1)}
            >
              Try again
            </Button>
          </div>
        )}
        {state.kind === "loaded" && (
          <div
            className={cn("transition-opacity", updating && "opacity-60")}
            aria-busy={updating}
          >
            <PerformanceBody performance={state.data} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PlotPlaceholder({ label }: { label: string }) {
  return (
    <div
      className="w-full animate-pulse rounded-md bg-muted"
      style={{ height: PLOT_HEIGHT }}
      role="status"
      aria-label={label}
    />
  );
}

function RangePicker({
  value,
  onChange,
}: {
  value: PerformanceRange;
  onChange: (range: PerformanceRange) => void;
}) {
  return (
    <div role="group" aria-label="Time range" className="flex rounded-md border p-0.5">
      {PERFORMANCE_RANGES.map((range) => (
        <button
          key={range}
          type="button"
          aria-pressed={value === range}
          title={RANGE_NAMES[range]}
          onClick={() => onChange(range)}
          className={cn(
            "min-w-9 rounded px-2 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            value === range
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          {RANGE_LABELS[range]}
        </button>
      ))}
    </div>
  );
}

function PerformanceBody({ performance }: { performance: PortfolioPerformance }) {
  const notes = <PerformanceNotes performance={performance} />;
  if (performance.status !== "ok") {
    return (
      <div className="flex flex-col gap-2 py-8 text-center">
        <p className="text-sm font-medium">{emptyMessage(performance.status)}</p>
        {notes}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <Legend performance={performance} />
      <Suspense fallback={<PlotPlaceholder label="Loading chart" />}>
        <PerformancePlot performance={performance} />
      </Suspense>
      {notes}
      <ChartData
        caption="Portfolio and S&P 500 returns"
        columns={["Date", "Portfolio", BENCHMARK_LABEL, "Value"]}
        rows={performance.points.map((p) => [
          dateLabel(p.date),
          formatSignedPercent(p.portfolioPercent),
          returnLabel(p.benchmarkPercent),
          formatCurrency(p.portfolioValue),
        ])}
      />
    </div>
  );
}

function emptyMessage(status: PortfolioPerformance["status"]): string {
  switch (status) {
    case "empty":
      return "Add holdings to see how your portfolio has performed.";
    case "no_dates":
      return "Add purchase dates to your holdings to see performance.";
    default:
      return "There are no closing prices for your holdings yet.";
  }
}

/** Series key with each series' return over the range (identity is not color-only). */
function Legend({ performance }: { performance: PortfolioPerformance }) {
  return (
    <div
      role="group"
      aria-label="Returns over the range"
      className="flex flex-wrap gap-x-6 gap-y-2"
    >
      <LegendItem swatch={<LineSwatch />} label="Your portfolio">
        <ReturnValue value={performance.portfolioReturnPercent} />
      </LegendItem>
      <LegendItem swatch={<LineSwatch benchmark />} label={`${BENCHMARK_LABEL} (SPY)`}>
        <ReturnValue value={performance.benchmarkReturnPercent} />
      </LegendItem>
    </div>
  );
}

function LegendItem({
  swatch,
  label,
  children,
}: {
  swatch: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      {swatch}
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function ReturnValue({ value }: { value: number | null }) {
  return (
    <span
      className={cn(
        "text-lg font-semibold",
        value === null ? "text-muted-foreground" : changeColor(value),
      )}
    >
      {returnLabel(value)}
    </span>
  );
}

/** Why the chart starts where it does, or leaves something out. */
function PerformanceNotes({ performance }: { performance: PortfolioPerformance }) {
  const notes: string[] = [];
  if (performance.startClamped && performance.startDate) {
    notes.push(
      `Starts ${dateLabel(performance.startDate)}, the first close after your first purchase.`,
    );
  }
  const noHistory = performance.excluded.filter((e) => e.reason === "no_history");
  if (noHistory.length > 0) {
    notes.push(
      `Not included (no price history): ${noHistory.map((e) => e.ticker).join(", ")}.`,
    );
  }
  const noCloseYet = performance.excluded.filter((e) => e.reason === "no_close_yet");
  if (noCloseYet.length > 0) {
    notes.push(
      `Counted from their first close after purchase: ${noCloseYet.map((e) => e.ticker).join(", ")}.`,
    );
  }
  const undated = performance.lotsWithoutDate;
  if (undated > 0) {
    notes.push(
      undated === 1
        ? "1 lot has no purchase date and isn't included. Edit it to add a date."
        : `${undated} lots have no purchase date and aren't included. Edit them to add a date.`,
    );
  }
  if (performance.status === "ok" && !performance.benchmark.available) {
    notes.push(`${BENCHMARK_LABEL} prices are unavailable right now.`);
  }
  if (notes.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
      {notes.map((note) => (
        <li key={note}>{note}</li>
      ))}
    </ul>
  );
}
