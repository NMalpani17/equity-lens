import { lazy, Suspense, useState } from "react";
import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { usePortfolioInsight } from "@/hooks/usePortfolioInsight";
import { getSectorAllocation, type SectorAllocation as Allocation } from "@/lib/api";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

// Recharts is downloaded only once there is something to plot.
const SectorBars = lazy(() => import("./SectorBars"));

const ROW_HEIGHT = 28;

/** The portfolio's market value by sector: a bar chart plus the list. */
export function SectorAllocation({ version }: { version: number }) {
  const [attempt, setAttempt] = useState(0);
  // Holdings changed (`version`) or a retry (`attempt`): load again.
  const { state, updating } = usePortfolioInsight(
    getSectorAllocation,
    `${version}:${attempt}`,
  );

  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle className="text-base">Sector allocation</CardTitle>
        <p className="mt-1 text-xs text-muted-foreground">Share of market value</p>
      </CardHeader>
      <CardContent>
        {state.kind === "loading" && <Placeholder rows={4} label="Loading sectors" />}
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
            <SectorBody allocation={state.data} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Placeholder({ rows, label }: { rows: number; label: string }) {
  return (
    <div
      className="w-full animate-pulse rounded-md bg-muted"
      style={{ height: rows * ROW_HEIGHT + 8 }}
      role="status"
      aria-label={label}
    />
  );
}

function SectorBody({ allocation }: { allocation: Allocation }) {
  const notes = <SectorNotes allocation={allocation} />;
  if (allocation.sectors.length === 0) {
    return (
      <div className="flex flex-col gap-2 py-8 text-center">
        <p className="text-sm font-medium">No priced holdings to group yet.</p>
        {notes}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <Suspense
        fallback={
          <Placeholder rows={allocation.sectors.length} label="Loading chart" />
        }
      >
        <SectorBars sectors={allocation.sectors} />
      </Suspense>
      <table className="w-full text-sm">
        <caption className="sr-only">Sector allocation by market value</caption>
        <thead className="sr-only">
          <tr>
            <th scope="col">Sector</th>
            <th scope="col">Value</th>
            <th scope="col">Share</th>
          </tr>
        </thead>
        <tbody>
          {allocation.sectors.map((slice) => (
            <tr key={slice.sector} className="border-t first:border-t-0">
              <th scope="row" className="py-2 pr-2 text-left font-normal">
                <div className="font-medium">{slice.sector}</div>
                <div className="break-words text-xs text-muted-foreground">
                  {slice.holdings.map((h) => h.ticker).join(", ")}
                </div>
              </th>
              <td className="py-2 pr-2 text-right tabular-nums">
                {formatCurrency(slice.marketValue)}
              </td>
              <td className="w-16 py-2 text-right font-medium tabular-nums">
                {slice.weightPercent.toFixed(1)}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {notes}
    </div>
  );
}

function SectorNotes({ allocation }: { allocation: Allocation }) {
  const notes: string[] = [];
  if (allocation.unpricedTickers.length > 0) {
    notes.push(
      `Not included (no current price): ${allocation.unpricedTickers.join(", ")}.`,
    );
  }
  if (allocation.pendingTickers.length > 0) {
    notes.push(
      `Still looking up sectors for ${allocation.pendingTickers.join(", ")}; shown under Other for now.`,
    );
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
