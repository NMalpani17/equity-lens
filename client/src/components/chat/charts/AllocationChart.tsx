import { Bar, BarChart, LabelList, Tooltip, XAxis, YAxis } from "recharts";

import { ChartData } from "@/components/chat/charts/ChartData";
import type { ChartTooltipProps } from "@/components/chat/charts/tooltip";
import type { AllocationChart as AllocationChartData } from "@/lib/chatApi";
import { priceLabel } from "@/lib/chartFormat";

const ROW_HEIGHT = 30;
const BAR_SIZE = 16;

type Slice = AllocationChartData["slices"][number];

function SliceTooltip({ active, payload, currency }: ChartTooltipProps<Slice>) {
  const slice = active ? payload?.[0]?.payload : undefined;
  if (!slice) return null;
  return (
    <div className="rounded-md border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-sm">
      <div className="font-medium">
        {slice.ticker}
        {slice.name && (
          <span className="font-normal text-muted-foreground"> · {slice.name}</span>
        )}
      </div>
      <div className="tabular-nums">
        {priceLabel(slice.marketValue, currency)} · {slice.weightPercent.toFixed(1)}%
      </div>
    </div>
  );
}

/** Holdings by share of market value, largest first. */
export function AllocationChart({ chart }: { chart: AllocationChartData }) {
  const height = chart.slices.length * ROW_HEIGHT + 8;
  return (
    <figure className="w-full">
      <figcaption className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="text-sm font-medium">Portfolio allocation</span>
        <span className="text-xs tabular-nums text-muted-foreground">
          {priceLabel(chart.totalMarketValue, chart.currency)} by market value
        </span>
      </figcaption>
      <BarChart
        layout="vertical"
        responsive
        style={{ width: "100%", height }}
        data={chart.slices}
        margin={{ top: 0, right: 44, bottom: 0, left: 0 }}
        title="Portfolio allocation by market value"
        desc={chart.slices
          .map((s) => `${s.ticker} ${s.weightPercent.toFixed(1)}%`)
          .join(", ")}
      >
        <XAxis type="number" domain={[0, "dataMax"]} hide />
        <YAxis
          type="category"
          dataKey="ticker"
          width={52}
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 12, fill: "var(--foreground)" }}
        />
        <Tooltip
          content={({ active, payload }) => (
            <SliceTooltip active={active} payload={payload} currency={chart.currency} />
          )}
          cursor={{ fill: "var(--muted)" }}
        />
        <Bar
          dataKey="weightPercent"
          name="Weight"
          fill="var(--chart-1)"
          barSize={BAR_SIZE}
          radius={[0, 4, 4, 0]}
          isAnimationActive={false}
        >
          <LabelList
            dataKey="weightPercent"
            position="right"
            formatter={(value) => `${Number(value).toFixed(1)}%`}
            style={{ fontSize: 11, fill: "var(--muted-foreground)" }}
          />
        </Bar>
      </BarChart>
      {chart.partial && (
        <p className="mt-1 text-xs text-muted-foreground">
          Holdings without a current price aren't shown.
        </p>
      )}
      <ChartData
        caption="Portfolio allocation data"
        columns={["Holding", "Value", "Weight"]}
        rows={chart.slices.map((s) => [
          s.name ? `${s.ticker} (${s.name})` : s.ticker,
          priceLabel(s.marketValue, chart.currency),
          `${s.weightPercent.toFixed(1)}%`,
        ])}
      />
    </figure>
  );
}
