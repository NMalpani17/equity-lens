import { useCallback, useEffect, useState } from "react";

import { getPortfolioSummary, type PortfolioSummary } from "@/lib/api";

export type PortfolioState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; data: PortfolioSummary };

interface UsePortfolioResult {
  state: PortfolioState;
  /** Background refresh that keeps the current data visible while fetching. */
  refresh: () => Promise<void>;
  /** Whether a background refresh is currently in flight. */
  refreshing: boolean;
}

/** Loads the portfolio summary and exposes loading / error / loaded states. */
export function usePortfolio(): UsePortfolioResult {
  const [state, setState] = useState<PortfolioState>({ kind: "loading" });
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (silent: boolean) => {
    if (silent) {
      setRefreshing(true);
    } else {
      setState({ kind: "loading" });
    }
    try {
      const data = await getPortfolioSummary();
      setState({ kind: "loaded", data });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      setState({ kind: "error", message });
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const refresh = useCallback(() => load(true), [load]);

  return { state, refresh, refreshing };
}
