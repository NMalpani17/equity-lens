/**
 * Research report content as the ai-service writes it (stored JSON, and the
 * stream's `done` event), validated and mapped from snake_case to the
 * camelCase DTO the client gets.
 */
import { z } from "zod";

import {
  chartSchema,
  citationSchema,
  toChart,
  toCitation,
  type ChartDto,
  type CitationDto,
} from "./aiSchemas.js";
import { companyDisplayName } from "./companyNames.js";

export const SECTION_KEYS = [
  "summary",
  "drivers",
  "guidance",
  "changes",
  "stock",
  "risks",
] as const;

const periodSchema = z.object({
  fiscal_year: z.number().int(),
  fiscal_quarter: z.number().int().min(1).max(4),
  call_date: z.string().nullable().optional(),
});

const dataSourceSchema = z.object({
  id: z.string().regex(/^D\d{1,2}$/),
  kind: z.enum(["quote", "price_history"]),
  ticker: z.string(),
  label: z.string(),
  as_of: z.string().nullable().optional(),
  data: z.record(z.unknown()).default({}),
});

/** What the ai-service stores in research_reports.content (version 1). */
export const reportContentSchema = z.object({
  version: z.literal(1),
  ticker: z.string(),
  company_name: z.string(),
  quarter: periodSchema,
  prior_quarter: periodSchema.nullable().optional(),
  sections: z
    .array(
      z.object({ key: z.enum(SECTION_KEYS), title: z.string(), markdown: z.string() }),
    )
    .min(1),
  citations: z.array(citationSchema).default([]),
  data_sources: z.array(dataSourceSchema).default([]),
  chart: chartSchema.nullable().optional(),
  market_data_available: z.boolean().default(true),
  comparison_available: z.boolean().default(true),
  as_of: z
    .object({
      latest_call: z.string().nullable().optional(),
      quote: z.string().nullable().optional(),
      prices: z.string().nullable().optional(),
    })
    .default({}),
  disclaimer: z.string(),
});

export type ReportContent = z.infer<typeof reportContentSchema>;

export interface ReportPeriodDto {
  fiscalYear: number;
  fiscalQuarter: number;
  label: string;
  callDate: string | null;
}

export interface DataSourceDto {
  id: string;
  kind: "quote" | "price_history";
  ticker: string;
  label: string;
  asOf: string | null;
  data: Record<string, unknown>;
}

/** A report as the client sees it (no per-agent token or cost stats). */
export interface ReportDto {
  ticker: string;
  companyName: string;
  quarter: ReportPeriodDto;
  priorQuarter: ReportPeriodDto | null;
  sections: { key: (typeof SECTION_KEYS)[number]; title: string; markdown: string }[];
  citations: CitationDto[];
  dataSources: DataSourceDto[];
  chart: ChartDto | null;
  marketDataAvailable: boolean;
  comparisonAvailable: boolean;
  asOf: { latestCall: string | null; quote: string | null; prices: string | null };
  disclaimer: string;
  generatedAt: string;
}

export function periodLabel(fiscalYear: number, fiscalQuarter: number): string {
  return `Q${fiscalQuarter} FY${fiscalYear}`;
}

function toPeriod(p: z.infer<typeof periodSchema>): ReportPeriodDto {
  return {
    fiscalYear: p.fiscal_year,
    fiscalQuarter: p.fiscal_quarter,
    label: periodLabel(p.fiscal_year, p.fiscal_quarter),
    callDate: p.call_date ?? null,
  };
}

export function toReportDto(content: ReportContent, generatedAt: Date): ReportDto {
  return {
    ticker: content.ticker,
    companyName: companyDisplayName(content.ticker, content.company_name),
    quarter: toPeriod(content.quarter),
    priorQuarter: content.prior_quarter ? toPeriod(content.prior_quarter) : null,
    sections: content.sections,
    citations: content.citations.map(toCitation),
    dataSources: content.data_sources.map((s) => ({
      id: s.id,
      kind: s.kind,
      ticker: s.ticker,
      label: s.label,
      asOf: s.as_of ?? null,
      data: s.data,
    })),
    chart: content.chart ? toChart(content.chart) : null,
    marketDataAvailable: content.market_data_available,
    comparisonAvailable: content.comparison_available,
    asOf: {
      latestCall: content.as_of.latest_call ?? null,
      quote: content.as_of.quote ?? null,
      prices: content.as_of.prices ?? null,
    },
    disclaimer: content.disclaimer,
    generatedAt: generatedAt.toISOString(),
  };
}
