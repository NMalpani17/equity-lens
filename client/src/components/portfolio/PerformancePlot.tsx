import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { PerformancePoint, PortfolioPerformance } from "@/lib/api";
import { dateLabel, dateTick, isLongRange } from "@/lib/chartFormat";
import { formatCurrency, formatSignedPercent } from "@/lib/format";
import { LineSwatch } from "./LineSwatch";

// Matches the loading placeholder in PerformanceChart.
const PLOT_HEIGHT = 240;
const BENCHMARK_LABEL = "S&P 500";

/** Axis tick for a percent return, e.g. "+12%" or "-3.5%". */
function percentTick(value: number): string {
  const rounded = Math.abs(value) >= 10 ? Math.round(value) : Number(value.toFixed(1));
  return `${rounded > 0 ? "+" : ""}${rounded}%`;
}

function returnLabel(value: number | null): string {
  return value === null ? "—" : formatSignedPercent(value);
}

function PerformanceTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: PerformancePoint }>;
}) {
  const point = active ? payload?.[0]?.payload : undefined;
  if (!point) return null;
  return (
    <div className="rounded-md border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-sm">
      <div className="text-muted-foreground">{dateLabel(point.date)}</div>
      <div className="mt-1 grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 tabular-nums">
        <span className="flex items-center gap-1.5">
          <LineSwatch /> Portfolio
        </span>
        <span className="text-right font-medium">
          {formatSignedPercent(point.portfolioPercent)}
        </span>
        <span className="flex items-center gap-1.5">
          <LineSwatch benchmark /> {BENCHMARK_LABEL}
        </span>
        <span className="text-right font-medium">
          {returnLabel(point.benchmarkPercent)}
        </span>
        <span className="text-muted-foreground">Value</span>
        <span className="text-right">{formatCurrency(point.portfolioValue)}</span>
      </div>
    </div>
  );
}

/** The two return lines on one % axis (Recharts; loaded on demand). */
export default function PerformancePlot({
  performance,
}: {
  performance: PortfolioPerformance;
}) {
  const longRange = isLongRange(performance.points);
  return (
    <LineChart
      responsive
      style={{ width: "100%", height: PLOT_HEIGHT }}
      data={performance.points}
      margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
      title="Portfolio vs S&P 500 return"
      desc={`From ${dateLabel(performance.startDate ?? "")} to ${dateLabel(
        performance.endDate ?? "",
      )}: portfolio ${returnLabel(performance.portfolioReturnPercent)}, ${BENCHMARK_LABEL} ${returnLabel(
        performance.benchmarkReturnPercent,
      )}.`}
    >
      <CartesianGrid vertical={false} stroke="var(--border)" />
      <ReferenceLine y={0} stroke="var(--input)" strokeWidth={1} />
      <XAxis
        dataKey="date"
        tickFormatter={(value: string) => dateTick(value, longRange)}
        interval="preserveStartEnd"
        minTickGap={32}
        tickLine={false}
        axisLine={false}
        tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
      />
      <YAxis
        domain={["auto", "auto"]}
        tickFormatter={percentTick}
        width={48}
        tickLine={false}
        axisLine={false}
        tickCount={5}
        tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
      />
      <Tooltip
        content={({ active, payload }) => (
          <PerformanceTooltip active={active} payload={payload} />
        )}
        cursor={{ stroke: "var(--muted-foreground)", strokeWidth: 1 }}
      />
      <Line
        type="monotone"
        dataKey="benchmarkPercent"
        name={BENCHMARK_LABEL}
        stroke="var(--chart-benchmark)"
        strokeWidth={2}
        strokeDasharray="5 3"
        dot={false}
        activeDot={{ r: 4, stroke: "var(--card)", strokeWidth: 2 }}
        connectNulls
        isAnimationActive={false}
      />
      <Line
        type="monotone"
        dataKey="portfolioPercent"
        name="Portfolio"
        stroke="var(--chart-1)"
        strokeWidth={2}
        dot={false}
        activeDot={{ r: 4, stroke: "var(--card)", strokeWidth: 2 }}
        isAnimationActive={false}
      />
    </LineChart>
  );
}
