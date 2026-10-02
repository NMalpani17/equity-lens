/** Labels and tick formatting for the inline chat charts. */

const PERIOD_LABELS: Record<string, string> = {
  "1mo": "1 month",
  "3mo": "3 months",
  "6mo": "6 months",
  ytd: "Year to date",
  "1y": "1 year",
  "2y": "2 years",
  "5y": "5 years",
};

/** "6mo" -> "6 months"; unknown periods are shown as given. */
export function periodLabel(period: string): string {
  return PERIOD_LABELS[period] ?? period;
}

function utcDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/**
 * Short x-axis label for an ISO date: "Apr 3" within a year-or-less window,
 * "Apr '26" for longer ones (the day stops being useful).
 */
export function dateTick(value: string, longRange: boolean): string {
  const date = utcDate(value);
  if (Number.isNaN(date.getTime())) return value;
  const month = date.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  if (longRange) return `${month} '${String(date.getUTCFullYear()).slice(-2)}`;
  return `${month} ${date.getUTCDate()}`;
}

/** True when the series spans more than about a year. */
export function isLongRange(points: { date: string }[]): boolean {
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last) return false;
  const span = utcDate(last.date).getTime() - utcDate(first.date).getTime();
  return span > 400 * 24 * 60 * 60 * 1000;
}

/** Axis price: no cents at or above $100, cents below (e.g. "$182", "$7.45"). */
export function priceTick(value: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: Math.abs(value) >= 100 ? 0 : 2,
    minimumFractionDigits: 0,
  }).format(value);
}

/** Full price for tooltips and tables, e.g. "$182.40". */
export function priceLabel(value: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value);
}

/** Long date for tooltips and tables, e.g. "Apr 3, 2026". */
export function dateLabel(value: string): string {
  const date = utcDate(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}
