/** Props our custom tooltips read from Recharts (the hovered data row). */
export interface ChartTooltipProps<Row> {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: Row }>;
  currency: string;
}
