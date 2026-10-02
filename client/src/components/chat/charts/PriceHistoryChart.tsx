import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { Area, AreaChart, CartesianGrid, Tooltip, XAxis, YAxis } from "recharts";

import { ChartData } from "@/components/chat/charts/ChartData";
import type { ChartTooltipProps } from "@/components/chat/charts/tooltip";
import type { PriceChart } from "@/lib/chatApi";
import {
  dateLabel,
  dateTick,
  isLongRange,
  periodLabel,
  priceLabel,
  priceTick,
} from "@/lib/chartFormat";
import { changeColor, formatSignedPercent } from "@/lib/format";

const HEIGHT = 200;

function PriceTooltip({
  active,
  payload,
  currency,
}: ChartTooltipProps<PriceChart["points"][number]>) {
  const point = active ? payload?.[0]?.payload : undefined;
  if (!point) return null;
  return (
    <div className="rounded-md border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-sm">
      <div className="text-muted-foreground">{dateLabel(point.date)}</div>
      <div className="font-medium tabular-nums">
        {priceLabel(point.close, currency)}
      </div>
    </div>
  );
}

/** Closing prices over the period, with the period change as the headline. */
export function PriceHistoryChart({ chart }: { chart: PriceChart }) {
  const longRange = isLongRange(chart.points);
  const up = chart.change >= 0;
  const Arrow = up ? ArrowUpRight : ArrowDownRight;
  const title = `${chart.ticker} · ${periodLabel(chart.period)}`;

  return (
    <figure className="w-full">
      <figcaption className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="text-sm font-medium">{title}</span>
        <span className="flex items-center gap-1.5 text-xs tabular-nums">
          <span className="text-foreground">
            {priceLabel(chart.lastClose, chart.currency)}
          </span>
          <span className={`inline-flex items-center ${changeColor(chart.change)}`}>
            <Arrow aria-hidden="true" className="size-3.5" />
            {formatSignedPercent(chart.changePercent)}
            <span className="sr-only">{up ? " (up)" : " (down)"}</span>
          </span>
        </span>
      </figcaption>
      <AreaChart
        responsive
        style={{ width: "100%", height: HEIGHT }}
        data={chart.points}
        margin={{ top: 4, right: 4, bottom: 0, left: 0 }}
        title={`${title} closing prices`}
        desc={`From ${priceLabel(chart.firstClose, chart.currency)} to ${priceLabel(
          chart.lastClose,
          chart.currency,
        )} (${formatSignedPercent(chart.changePercent)}); high ${priceLabel(
          chart.high,
          chart.currency,
        )}, low ${priceLabel(chart.low, chart.currency)}.`}
      >
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis
          dataKey="date"
          tickFormatter={(value: string) => dateTick(value, longRange)}
          interval="preserveStartEnd"
          minTickGap={28}
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
        />
        <YAxis
          domain={["auto", "auto"]}
          tickFormatter={(value: number) => priceTick(value, chart.currency)}
          width={52}
          tickLine={false}
          axisLine={false}
          tickCount={4}
          tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
        />
        <Tooltip
          content={({ active, payload }) => (
            <PriceTooltip active={active} payload={payload} currency={chart.currency} />
          )}
          cursor={{ stroke: "var(--muted-foreground)", strokeWidth: 1 }}
        />
        <Area
          type="monotone"
          dataKey="close"
          name="Close"
          stroke="var(--chart-1)"
          strokeWidth={2}
          fill="var(--chart-1)"
          fillOpacity={0.1}
          dot={false}
          activeDot={{ r: 4, stroke: "var(--card)", strokeWidth: 2 }}
          isAnimationActive={false}
        />
      </AreaChart>
      <ChartData
        caption={`${title} closing prices`}
        columns={["Date", "Close"]}
        rows={chart.points.map((p) => [
          dateLabel(p.date),
          priceLabel(p.close, chart.currency),
        ])}
      />
    </figure>
  );
}
