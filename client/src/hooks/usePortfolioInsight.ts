import { useEffect, useState } from "react";

export type InsightState<T> =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; data: T };

interface UsePortfolioInsightResult<T> {
  state: InsightState<T>;
  /** True while a newer request runs; the previous data stays on screen. */
  updating: boolean;
}

/**
 * Loads one portfolio insight (performance, sectors). It loads again when
 * `load` changes (memoize it on its inputs, e.g. a range) or `reloadKey` does
 * (holdings changed, or a retry). Earlier data stays visible during a reload,
 * so the chart never flashes.
 */
export function usePortfolioInsight<T>(
  load: () => Promise<T>,
  reloadKey: string | number,
): UsePortfolioInsightResult<T> {
  const [state, setState] = useState<InsightState<T>>({ kind: "loading" });
  // The request that last finished.
  const [settled, setSettled] = useState<{
    load: () => Promise<T>;
    reloadKey: string | number;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    load()
      .then((data) => {
        if (!cancelled) setState({ kind: "loaded", data });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : "Unknown error";
        setState({ kind: "error", message });
      })
      .finally(() => {
        if (!cancelled) setSettled({ load, reloadKey });
      });
    return () => {
      cancelled = true;
    };
  }, [load, reloadKey]);

  const updating = settled?.load !== load || settled.reloadKey !== reloadKey;
  return { state, updating };
}
