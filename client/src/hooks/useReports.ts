/** State for the Reports page: ticker list, one ticker's report, generation. */
import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError } from "@/lib/api";
import {
  getReport,
  listReports,
  streamReport,
  type AgentState,
  type ReportAgent,
  type ReportStreamEvent,
  type ReportSummary,
  type ReportUsage,
  type ReportView,
} from "@/lib/reportsApi";

export const AGENTS: { agent: ReportAgent; label: string }[] = [
  { agent: "transcripts", label: "Researching transcripts…" },
  { agent: "market", label: "Analyzing price data…" },
  { agent: "writer", label: "Writing report…" },
];

export interface AgentProgress {
  agent: ReportAgent;
  state: "pending" | AgentState;
  label: string;
  summary?: string;
}

/** While a report is generating (not by this page's own request), check back this often. */
export const GENERATING_POLL_MS = 10_000;

function pendingAgents(): AgentProgress[] {
  return AGENTS.map(({ agent, label }) => ({ agent, label, state: "pending" }));
}

/** The report /reports opens when no company is in the address. */
export const DEFAULT_REPORT_TICKER = "NVDA";

/** NVDA if its report is ready, else the first ready report, else the first company. */
export function defaultTicker(tickers: ReportSummary[]): string | undefined {
  const ready = (t: ReportSummary) => t.report !== null && !t.report.outdated;
  const preferred = tickers.find((t) => t.ticker === DEFAULT_REPORT_TICKER);
  if (preferred && ready(preferred)) return preferred.ticker;
  return (tickers.find(ready) ?? tickers[0])?.ticker;
}

function message(error: unknown, fallback: string): string {
  return error instanceof ApiError || error instanceof Error ? error.message : fallback;
}

/**
 * ``requested`` is the company in the address. Without one, the default
 * company opens (picked once the list loads, then kept while the list
 * refreshes); the address stays /reports.
 */
export function useReports(requested: string | undefined) {
  const [tickers, setTickers] = useState<ReportSummary[] | null>(null);
  const [fallback, setFallback] = useState<string | undefined>(undefined);
  const ticker = requested ?? fallback;
  const [usage, setUsage] = useState<ReportUsage | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [view, setView] = useState<ReportView | null>(null);
  const [loadingView, setLoadingView] = useState(false);
  const [viewError, setViewError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState<AgentProgress[]>(pendingAgents);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const tickerRef = useRef(ticker);
  tickerRef.current = ticker;

  const loadList = useCallback(async () => {
    try {
      const result = await listReports();
      setTickers(result.tickers);
      setUsage(result.usage);
      setListError(null);
    } catch (error) {
      setListError(message(error, "Couldn't load the companies."));
    }
  }, []);

  const loadView = useCallback(async (symbol: string, { quiet = false } = {}) => {
    if (!quiet) setLoadingView(true);
    try {
      const next = await getReport(symbol);
      if (tickerRef.current === symbol) {
        setView(next);
        setUsage(next.usage);
        setViewError(null);
      }
    } catch (error) {
      if (tickerRef.current === symbol) {
        setView(null);
        setViewError(message(error, "Couldn't load this report."));
      }
    } finally {
      if (!quiet && tickerRef.current === symbol) setLoadingView(false);
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (!requested && fallback === undefined && tickers) {
      setFallback(defaultTicker(tickers));
    }
  }, [requested, fallback, tickers]);

  useEffect(() => {
    setView(null);
    setGenerateError(null);
    setProgress(pendingAgents());
    if (ticker) void loadView(ticker);
  }, [ticker, loadView]);

  // Refresh the list and the open report together (no loading spinners).
  const refresh = useCallback(() => {
    void loadList();
    if (tickerRef.current) void loadView(tickerRef.current, { quiet: true });
  }, [loadList, loadView]);

  // A report is generating somewhere (another tab, another user, or a run
  // started before the user left): check back until none is.
  const anyGenerating =
    !generating &&
    (Boolean(view?.generating) || Boolean(tickers?.some((t) => t.generating)));
  useEffect(() => {
    if (!anyGenerating) return;
    const timer = window.setTimeout(refresh, GENERATING_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [anyGenerating, tickers, view, refresh]);

  // Coming back to the tab (or the window) shows the current state at once.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && !generating) refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [generating, refresh]);

  // Leaving the page stops only this browser's request: the server finishes
  // and saves the report, and it's there when the user comes back.
  useEffect(() => () => abortRef.current?.abort(), []);

  const onEvent = useCallback((event: ReportStreamEvent) => {
    switch (event.type) {
      case "agent":
        setProgress((items) =>
          items.map((item) =>
            item.agent === event.agent
              ? {
                  ...item,
                  state: event.state,
                  label: event.label,
                  summary: event.summary,
                }
              : item,
          ),
        );
        break;
      case "done":
        setView((current) =>
          current ? { ...current, report: event.report, outdated: false } : current,
        );
        break;
      case "error":
        setGenerateError(event.message);
        setProgress((items) =>
          items.map((item) =>
            item.state === "running" ? { ...item, state: "failed" } : item,
          ),
        );
        break;
    }
  }, []);

  const generate = useCallback(async () => {
    if (!ticker || generating) return;
    const abort = new AbortController();
    abortRef.current = abort;
    setGenerating(true);
    setGenerateError(null);
    setProgress(pendingAgents());
    try {
      await streamReport(ticker, onEvent, abort.signal);
    } catch (error) {
      if (!abort.signal.aborted) {
        setGenerateError(message(error, "The report couldn't be generated."));
      }
    } finally {
      if (abortRef.current === abort) abortRef.current = null;
      setGenerating(false);
      if (!abort.signal.aborted) {
        // Fresh permissions and allowance (and the list's "ready" state).
        void loadView(ticker, { quiet: true });
        void loadList();
      }
    }
  }, [ticker, generating, onEvent, loadView, loadList]);

  return {
    ticker,
    tickers,
    usage,
    listError,
    view,
    loadingView,
    viewError,
    generating,
    progress,
    generateError,
    dismissGenerateError: () => setGenerateError(null),
    generate,
  };
}
