import { useCallback, useEffect, useState } from "react";

import {
  addToWatchlist,
  getWatchlist,
  removeFromWatchlist,
  type Watchlist,
} from "@/lib/marketApi";

export type WatchlistState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; data: Watchlist };

export interface UseWatchlistResult {
  state: WatchlistState;
  refreshing: boolean;
  /** Reload, keeping the current rows visible. */
  refresh: () => Promise<void>;
  /** Add a ticker, then reload. Rejects with the API's message (e.g. limit). */
  add: (ticker: string) => Promise<void>;
  /** Remove a ticker (hidden at once), then reload. */
  remove: (ticker: string) => Promise<void>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

export function useWatchlist(): UseWatchlistResult {
  const [state, setState] = useState<WatchlistState>({ kind: "loading" });
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (silent: boolean) => {
    if (silent) setRefreshing(true);
    else setState({ kind: "loading" });
    try {
      setState({ kind: "loaded", data: await getWatchlist() });
    } catch (error) {
      setState({ kind: "error", message: messageOf(error) });
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const refresh = useCallback(() => load(true), [load]);

  const add = useCallback(
    async (ticker: string) => {
      await addToWatchlist(ticker);
      await load(true);
    },
    [load],
  );

  const remove = useCallback(
    async (ticker: string) => {
      setState((current) =>
        current.kind === "loaded"
          ? {
              kind: "loaded",
              data: {
                ...current.data,
                items: current.data.items.filter((row) => row.ticker !== ticker),
              },
            }
          : current,
      );
      try {
        await removeFromWatchlist(ticker);
      } finally {
        await load(true);
      }
    },
    [load],
  );

  return { state, refreshing, refresh, add, remove };
}
