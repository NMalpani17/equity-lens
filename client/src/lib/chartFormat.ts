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

/** Round steps for a percent axis: 1, 2, 2.5 and 5 times a power of ten. */
const PERCENT_STEP_BASES = [1, 2, 2.5, 5];
/** Intervals aimed for on a percent axis (so about five labels). */
const PERCENT_TARGET_INTERVALS = 4;

/** The smallest round step (at least 1%) giving about the target interval count. */
function percentStep(span: number): number {
  const rough = span / PERCENT_TARGET_INTERVALS;
  for (let power = 1; ; power *= 10) {
    const step = PERCENT_STEP_BASES.map((base) => base * power).find((s) => s >= rough);
    if (step !== undefined) return step;
  }
}

/**
 * Domain and ticks for a percent-return axis on round steps (1, 2, 2.5, 5, 10,
 * 20, 25, 50, ...), always including 0, so labels read +1%, +2% or +10%, +20%.
 */
export function percentAxis(values: number[]): {
  domain: [number, number];
  ticks: number[];
} {
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const step = percentStep(max - min);
  const low = Math.floor(min / step) * step;
  let high = Math.ceil(max / step) * step;
  if (high === low) high = low + step;
  const count = Math.round((high - low) / step);
  // Rounded to cents so float steps (0.1 + 0.2) never print as 2.4999%.
  const ticks = Array.from(
    { length: count + 1 },
    (_, i) => Math.round((low + i * step) * 100) / 100,
  );
  return { domain: [ticks[0]!, ticks.at(-1)!], ticks };
}

/** Axis label for a percent return, e.g. "+10%", "-2.5%", "0%". */
export function percentTick(value: number): string {
  const label = Number.isInteger(value) ? String(value) : value.toFixed(1);
  return `${value > 0 ? "+" : ""}${label}%`;
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
