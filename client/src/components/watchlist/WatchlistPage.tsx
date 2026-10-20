import { useEffect, useState } from "react";
import { AlertTriangle, Eye, Loader2, RefreshCw, X } from "lucide-react";

import { DemoBanner } from "@/components/DemoBanner";
import { Header } from "@/components/Header";
import { HoldingFormDialog } from "@/components/portfolio/HoldingFormDialog";
import { NOTICE_MS } from "@/components/portfolio/Dashboard";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useAuth } from "@/context/auth-context";
import { useWatchlist } from "@/hooks/useWatchlist";
import type { WatchlistRow } from "@/lib/marketApi";
import { WatchlistAddForm } from "./WatchlistAddForm";
import { WatchlistList } from "./WatchlistList";

/**
 * Companies the user is considering (not owned): live prices, change since
 * added, next earnings date and report status, with shortcuts to research or
 * record a purchase. Watching a stock never changes the portfolio.
 */
export function WatchlistPage() {
  const { isDemo } = useAuth();
  const watchlist = useWatchlist();
  const { state } = watchlist;
  const [buying, setBuying] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const data = state.kind === "loaded" ? state.data : null;

  async function remove(row: WatchlistRow) {
    setNotice(null);
    setRemoveError(null);
    try {
      await watchlist.remove(row.ticker);
    } catch (error) {
      setRemoveError(error instanceof Error ? error.message : "Something went wrong.");
    }
  }

  async function add(ticker: string) {
    setNotice(null);
    await watchlist.add(ticker);
    setNotice(`Added ${ticker} to your watchlist.`);
  }

  return (
    <div className="min-h-screen">
      {isDemo && <DemoBanner />}
      <Header />
      <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Watchlist</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Companies you&apos;re considering. Watching a stock doesn&apos;t change
              your portfolio.
            </p>
          </div>
          <Button
            variant="outline"
            onClick={() => void watchlist.refresh()}
            disabled={state.kind === "loading" || watchlist.refreshing}
          >
            <RefreshCw className={watchlist.refreshing ? "animate-spin" : ""} />
            Refresh
          </Button>
        </header>

        {data && (
          <WatchlistAddForm count={data.items.length} limit={data.limit} onAdd={add} />
        )}

        {notice && (
          <div className="flex items-center gap-3 rounded-md bg-info px-4 py-2 text-sm text-info-foreground">
            <p role="status" className="flex-1">
              {notice}
            </p>
            <button
              type="button"
              onClick={() => setNotice(null)}
              aria-label="Dismiss"
              className="rounded-sm opacity-70 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          </div>
        )}
        {removeError && (
          <p role="alert" className="text-sm text-destructive">
            {removeError}
          </p>
        )}

        {state.kind === "loading" && (
          <Card>
            <CardContent className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
              <Loader2 className="animate-spin" /> Loading your watchlist…
            </CardContent>
          </Card>
        )}

        {state.kind === "error" && (
          <Card>
            <CardContent className="flex flex-wrap items-center gap-3 py-8 text-destructive">
              <AlertTriangle aria-hidden="true" />
              <div>
                <p className="font-medium">Couldn&apos;t load your watchlist.</p>
                <p className="text-sm text-muted-foreground">{state.message}</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="ml-auto"
                onClick={() => void watchlist.refresh()}
              >
                Try again
              </Button>
            </CardContent>
          </Card>
        )}

        {data && data.items.length === 0 && (
          <Card>
            <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
              <Eye aria-hidden="true" className="size-6 text-muted-foreground" />
              <p className="font-medium">No companies yet</p>
              <p className="text-sm text-muted-foreground">
                Search above to watch a company&apos;s price, earnings date and research
                report.
              </p>
            </CardContent>
          </Card>
        )}

        {data && data.items.length > 0 && (
          <Card className="overflow-hidden">
            <CardContent className="p-0">
              <WatchlistList
                rows={data.items}
                onRemove={remove}
                onBought={(row) => {
                  setNotice(null);
                  setBuying(row.ticker);
                }}
              />
            </CardContent>
          </Card>
        )}
      </main>

      <HoldingFormDialog
        open={buying !== null}
        onOpenChange={(open) => !open && setBuying(null)}
        lot={null}
        initialTicker={buying}
        onSaved={() => {
          setNotice(`Added ${buying} to your portfolio.`);
          void watchlist.refresh();
        }}
      />
    </div>
  );
}
