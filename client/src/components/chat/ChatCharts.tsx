import { lazy, Suspense } from "react";

import type { ChatChart } from "@/lib/chatApi";

// Recharts is only downloaded once a reply actually has a chart.
const ChartView = lazy(() => import("@/components/chat/charts/ChartView"));

const KNOWN_KINDS = new Set<ChatChart["kind"]>([
  "price_history",
  "portfolio_allocation",
]);

/** The reply's inline charts (built from tool results), stacked below the text. */
export function ChatCharts({ charts }: { charts: ChatChart[] }) {
  const shown = charts.filter((c) => KNOWN_KINDS.has(c.kind));
  if (shown.length === 0) return null;
  return (
    <div className="mt-3 space-y-4">
      {shown.map((chart) => (
        <Suspense
          key={chart.id}
          fallback={
            <div
              className="h-[228px] w-full animate-pulse rounded-md bg-muted"
              role="status"
              aria-label="Loading chart"
            />
          }
        >
          <ChartView chart={chart} />
        </Suspense>
      ))}
    </div>
  );
}
