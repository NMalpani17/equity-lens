import { useEffect, useState } from "react";

import { getUpcomingEarnings, type UpcomingEarnings } from "@/lib/marketApi";

export type UpcomingEarningsState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; data: UpcomingEarnings };

/**
 * Upcoming earnings for the user's holdings and watchlist. Reloads whenever
 * `version` changes (the watchlist or the holdings changed); the previous
 * answer stays visible meanwhile.
 */
export function useUpcomingEarnings(version: number): UpcomingEarningsState {
  const [state, setState] = useState<UpcomingEarningsState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    getUpcomingEarnings()
      .then((data) => {
        if (!cancelled) setState({ kind: "loaded", data });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            kind: "error",
            message: error instanceof Error ? error.message : "Something went wrong.",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [version]);

  return state;
}
