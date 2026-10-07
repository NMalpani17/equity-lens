/**
 * Upstream (ai-service) shapes shared by chat and research reports: transcript
 * citations and inline charts, validated with Zod and mapped to camelCase.
 */
import { z } from "zod";

export const citationSchema = z.object({
  id: z.number().int(),
  ticker: z.string(),
  company_name: z.string(),
  fiscal_year: z.number().int(),
  fiscal_quarter: z.number().int(),
  call_date: z.string().nullable(),
  speaker: z.string(),
  role: z.string().nullable(),
  section: z.string(),
  text: z.string(),
});

const pricePointSchema = z.object({ date: z.string(), close: z.number() });

export const chartSchema = z.discriminatedUnion("kind", [
  z.object({
    id: z.string(),
    kind: z.literal("price_history"),
    ticker: z.string(),
    period: z.string(),
    currency: z.string(),
    points: z.array(pricePointSchema).min(2).max(400),
    first_close: z.number(),
    last_close: z.number(),
    change: z.number(),
    change_percent: z.number(),
    high: z.number(),
    low: z.number(),
    as_of: z.string().nullable().optional(),
  }),
  z.object({
    id: z.string(),
    kind: z.literal("portfolio_allocation"),
    currency: z.string(),
    slices: z
      .array(
        z.object({
          ticker: z.string(),
          name: z.string().nullable().optional(),
          market_value: z.number(),
          weight_percent: z.number(),
        }),
      )
      .min(1)
      .max(20),
    total_market_value: z.number(),
    partial: z.boolean(),
    as_of: z.string().nullable().optional(),
  }),
]);

export interface CitationDto {
  id: number;
  ticker: string;
  companyName: string;
  fiscalYear: number;
  fiscalQuarter: number;
  callDate: string | null;
  speaker: string;
  role: string | null;
  section: string;
  text: string;
}

export type ChartDto =
  | {
      id: string;
      kind: "price_history";
      ticker: string;
      period: string;
      currency: string;
      points: { date: string; close: number }[];
      firstClose: number;
      lastClose: number;
      change: number;
      changePercent: number;
      high: number;
      low: number;
      asOf: string | null;
    }
  | {
      id: string;
      kind: "portfolio_allocation";
      currency: string;
      slices: {
        ticker: string;
        name: string | null;
        marketValue: number;
        weightPercent: number;
      }[];
      totalMarketValue: number;
      partial: boolean;
      asOf: string | null;
    };

export function toCitation(c: z.infer<typeof citationSchema>): CitationDto {
  return {
    id: c.id,
    ticker: c.ticker,
    companyName: c.company_name,
    fiscalYear: c.fiscal_year,
    fiscalQuarter: c.fiscal_quarter,
    callDate: c.call_date,
    speaker: c.speaker,
    role: c.role,
    section: c.section,
    text: c.text,
  };
}

/** Chart from upstream (snake_case) to the API's camelCase shape. */
export function toChart(c: z.infer<typeof chartSchema>): ChartDto {
  if (c.kind === "price_history") {
    return {
      id: c.id,
      kind: c.kind,
      ticker: c.ticker,
      period: c.period,
      currency: c.currency,
      points: c.points.map((p) => ({ date: p.date, close: p.close })),
      firstClose: c.first_close,
      lastClose: c.last_close,
      change: c.change,
      changePercent: c.change_percent,
      high: c.high,
      low: c.low,
      asOf: c.as_of ?? null,
    };
  }
  return {
    id: c.id,
    kind: c.kind,
    currency: c.currency,
    slices: c.slices.map((s) => ({
      ticker: s.ticker,
      name: s.name ?? null,
      marketValue: s.market_value,
      weightPercent: s.weight_percent,
    })),
    totalMarketValue: c.total_market_value,
    partial: c.partial,
    asOf: c.as_of ?? null,
  };
}
