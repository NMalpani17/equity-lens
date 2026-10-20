import { useEffect, useState } from "react";

import { searchSymbols, type SymbolMatch } from "@/lib/marketApi";

/** Wait this long after the last keystroke before searching. */
export const SEARCH_DEBOUNCE_MS = 250;

export interface CompanySearchState {
  results: SymbolMatch[];
  /** False while the company list isn't loaded (or search failed). */
  ready: boolean;
  /** The query the results are for (they lag the input by the debounce). */
  resultsFor: string;
  loading: boolean;
}

const IDLE: CompanySearchState = {
  results: [],
  ready: true,
  resultsFor: "",
  loading: false,
};

/**
 * Debounced company search. Each new query aborts the previous request, so a
 * slow answer for "mic" can never replace the one for "micro". Errors read as
 * "not ready": the field still accepts an exact ticker.
 */
export function useCompanySearch(query: string, enabled = true): CompanySearchState {
  const [state, setState] = useState<CompanySearchState>(IDLE);
  const trimmed = query.trim();

  useEffect(() => {
    if (!enabled || !trimmed) {
      setState(IDLE);
      return;
    }
    const controller = new AbortController();
    setState((current) => ({ ...current, loading: true }));
    const timer = window.setTimeout(() => {
      searchSymbols(trimmed, controller.signal)
        .then(({ results, ready }) => {
          if (!controller.signal.aborted) {
            setState({ results, ready, resultsFor: trimmed, loading: false });
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setState({
              results: [],
              ready: false,
              resultsFor: trimmed,
              loading: false,
            });
          }
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [trimmed, enabled]);

  return state;
}
