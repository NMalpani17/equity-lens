/** Typed client for the research report endpoints. */
import { postEventStream, request } from "./api";
import type { Citation, PriceChart } from "./chatApi";

export interface Quarter {
  fiscalYear: number;
  fiscalQuarter: number;
  /** e.g. "Q2 FY2027" */
  label: string;
}

export interface ReportPeriod extends Quarter {
  callDate: string | null;
}

export type SectionKey =
  "summary" | "drivers" | "guidance" | "changes" | "stock" | "risks";

export interface ReportSection {
  key: SectionKey;
  title: string;
  markdown: string;
}

/** A market-data tool result the report cites as [D1], [D2], ... */
export interface DataSource {
  id: string;
  kind: "quote" | "price_history";
  ticker: string;
  label: string;
  asOf: string | null;
  data: Record<string, unknown>;
}

export interface Report {
  ticker: string;
  companyName: string;
  quarter: ReportPeriod;
  priorQuarter: ReportPeriod | null;
  sections: ReportSection[];
  citations: Citation[];
  dataSources: DataSource[];
  chart: PriceChart | null;
  marketDataAvailable: boolean;
  comparisonAvailable: boolean;
  asOf: { latestCall: string | null; quote: string | null; prices: string | null };
  disclaimer: string;
  generatedAt: string;
}

export interface ReportUsage {
  used: number;
  limit: number;
  remaining: number;
  resetsAt: string;
  isDemo: boolean;
}

export interface ReportSummary {
  ticker: string;
  companyName: string;
  latestQuarter: Quarter;
  report: { generatedAt: string; quarter: Quarter; outdated: boolean } | null;
  generating: boolean;
}

export type BlockedReason =
  "demo" | "in_progress" | "fresh" | "daily_limit" | "global_limit";

export interface ReportView {
  ticker: string;
  companyName: string;
  latestQuarter: Quarter;
  report: Report | null;
  outdated: boolean;
  generating: boolean;
  canGenerate: boolean;
  blockedReason: BlockedReason | null;
  regenerateAvailableAt: string | null;
  usage: ReportUsage;
}

export type ReportAgent = "transcripts" | "market" | "writer";
export type AgentState = "running" | "done" | "failed";

export interface ReportErrorPayload {
  code: string;
  message: string;
  retryable: boolean;
}

export type ReportStreamEvent =
  | { type: "start"; ticker: string; quarter: Quarter }
  | {
      type: "agent";
      agent: ReportAgent;
      state: AgentState;
      label: string;
      summary?: string;
    }
  | { type: "done"; report: Report }
  | ({ type: "error" } & ReportErrorPayload);

const STREAM_EVENTS = new Set(["start", "agent", "done", "error"]);

export function listReports(): Promise<{
  tickers: ReportSummary[];
  usage: ReportUsage;
}> {
  return request("/api/reports");
}

export function getReport(ticker: string): Promise<ReportView> {
  return request(`/api/reports/${encodeURIComponent(ticker)}`);
}

/**
 * Generate (or regenerate) a ticker's report, streaming per-agent progress.
 * Rejects with an ApiError for rule violations before streaming starts (403
 * demo, 409 in progress or fresh, 429 caps). Aborting `signal` cancels the
 * generation (it still counts toward the daily allowance).
 */
export function streamReport(
  ticker: string,
  onEvent: (event: ReportStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  return postEventStream(
    `/api/reports/${encodeURIComponent(ticker)}`,
    {},
    STREAM_EVENTS,
    (type, data) => onEvent({ type, ...data } as ReportStreamEvent),
    signal,
  );
}
