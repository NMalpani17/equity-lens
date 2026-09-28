/** Display formatting helpers for money and percentages. */

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

/** Format a number as USD currency, e.g. 1234.5 -> "$1,234.50". */
export function formatCurrency(value: number): string {
  return currencyFormatter.format(value);
}

/** Format a signed currency value with a leading + or -, e.g. "+$12.00". */
export function formatSignedCurrency(value: number): string {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${currencyFormatter.format(Math.abs(value))}`;
}

/** Format a percentage with a sign and two decimals, e.g. "+4.76%". */
export function formatSignedPercent(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

/** Format a plain number with up to the given decimals, trimming zeros. */
export function formatShares(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 8 });
}

/** Tailwind text color reflecting gain (green), loss (red), or neutral. */
export function changeColor(value: number): string {
  if (value > 0) return "text-emerald-600";
  if (value < 0) return "text-destructive";
  return "text-muted-foreground";
}
