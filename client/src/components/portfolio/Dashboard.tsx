import { useState } from "react";
import { AlertTriangle, Loader2, Plus, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { usePortfolio } from "@/hooks/usePortfolio";
import type { PortfolioHolding } from "@/lib/api";
import { SummaryCards } from "./SummaryCards";
import { HoldingsTable } from "./HoldingsTable";
import { HoldingFormDialog } from "./HoldingFormDialog";
import { ConfirmDeleteDialog } from "./ConfirmDeleteDialog";

export function Dashboard() {
  const { state, refresh, refreshing } = usePortfolio();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<PortfolioHolding | null>(null);
  const [deleting, setDeleting] = useState<PortfolioHolding | null>(null);

  const loading = state.kind === "loading";
  const data = state.kind === "loaded" ? state.data : null;

  function openAdd() {
    setEditing(null);
    setFormOpen(true);
  }

  function openEdit(holding: PortfolioHolding) {
    setEditing(holding);
    setFormOpen(true);
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Portfolio</h1>
          <p className="text-sm text-muted-foreground">
            Your holdings with live prices from the market data service.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => void refresh()}
            disabled={loading || refreshing}
          >
            <RefreshCw className={refreshing ? "animate-spin" : ""} />
            Refresh
          </Button>
          <Button onClick={openAdd}>
            <Plus />
            Add holding
          </Button>
        </div>
      </header>

      <SummaryCards
        totals={data?.totals ?? null}
        holdingsCount={data?.holdings.length ?? 0}
        loading={loading}
      />

      {state.kind === "error" && (
        <Card>
          <CardContent className="flex items-center gap-3 py-8 text-destructive">
            <AlertTriangle />
            <div>
              <p className="font-medium">Couldn't load your portfolio.</p>
              <p className="text-sm text-muted-foreground">{state.message}</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              onClick={() => void refresh()}
            >
              Try again
            </Button>
          </CardContent>
        </Card>
      )}

      {loading && (
        <Card>
          <CardContent className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
            <Loader2 className="animate-spin" /> Loading holdings…
          </CardContent>
        </Card>
      )}

      {data && data.holdings.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <p className="font-medium">No holdings yet</p>
            <p className="text-sm text-muted-foreground">
              Add your first position to start tracking its value.
            </p>
            <Button onClick={openAdd}>
              <Plus />
              Add holding
            </Button>
          </CardContent>
        </Card>
      )}

      {data && data.holdings.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <HoldingsTable
              holdings={data.holdings}
              onEdit={openEdit}
              onDelete={setDeleting}
            />
          </CardContent>
        </Card>
      )}

      <HoldingFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        holding={editing}
        onSaved={() => void refresh()}
      />
      <ConfirmDeleteDialog
        holding={deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        onDeleted={() => void refresh()}
      />
    </div>
  );
}
