import { Bar, BarChart, LabelList, Tooltip, XAxis, YAxis } from "recharts";

import type { SectorSlice } from "@/lib/api";
import { formatCurrency } from "@/lib/format";

const ROW_HEIGHT = 28;
const BAR_SIZE = 14;

function SectorTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: SectorSlice }>;
}) {
  const slice = active ? payload?.[0]?.payload : undefined;
  if (!slice) return null;
  return (
    <div className="rounded-md border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-sm">
      <div className="font-medium">{slice.sector}</div>
      <div className="tabular-nums">
        {formatCurrency(slice.marketValue)} · {slice.weightPercent.toFixed(1)}%
      </div>
      <div className="text-muted-foreground">
        {slice.holdings.map((h) => h.ticker).join(", ")}
      </div>
    </div>
  );
}

/** Sectors by share of market value, one bar each (Recharts; loaded on demand). */
export default function SectorBars({ sectors }: { sectors: SectorSlice[] }) {
  return (
    <BarChart
      layout="vertical"
      responsive
      style={{ width: "100%", height: sectors.length * ROW_HEIGHT + 8 }}
      data={sectors}
      margin={{ top: 0, right: 48, bottom: 0, left: 0 }}
      title="Sector allocation by market value"
      desc={sectors.map((s) => `${s.sector} ${s.weightPercent.toFixed(1)}%`).join(", ")}
    >
      <XAxis type="number" domain={[0, "dataMax"]} hide />
      <YAxis
        type="category"
        dataKey="sector"
        width={136}
        tickLine={false}
        axisLine={false}
        tick={{ fontSize: 12, fill: "var(--foreground)" }}
      />
      <Tooltip
        content={({ active, payload }) => (
          <SectorTooltip active={active} payload={payload} />
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
  );
}
