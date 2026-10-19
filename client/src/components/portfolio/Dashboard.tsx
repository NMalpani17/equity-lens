import { useEffect, useState } from "react";
import { AlertTriangle, Loader2, Plus, RefreshCw, Upload, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { usePortfolio } from "@/hooks/usePortfolio";
import type { PortfolioLot, PortfolioPosition } from "@/lib/api";
import { SummaryCards } from "./SummaryCards";
import { HoldingsTable } from "./HoldingsTable";
import { HoldingFormDialog } from "./HoldingFormDialog";
import { ConfirmDeleteDialog } from "./ConfirmDeleteDialog";
import { ConfirmDeletePositionDialog } from "./ConfirmDeletePositionDialog";
import { PerformanceChart } from "./PerformanceChart";
import { SectorAllocation } from "./SectorAllocation";
import { ImportHoldingsDialog } from "./ImportHoldingsDialog";

/** How long a confirmation (e.g. "Imported 12 holdings.") stays up. */
export const NOTICE_MS = 5000;

export function Dashboard() {
  const { state, refresh: refreshSummary, refreshing } = usePortfolio();
  // Bumped whenever holdings may have changed, so the insights reload too.
  const [version, setVersion] = useState(0);
  const [formOpen, setFormOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<PortfolioLot | null>(null);
  const [deleting, setDeleting] = useState<PortfolioLot | null>(null);
  const [deletingPosition, setDeletingPosition] = useState<PortfolioPosition | null>(
    null,
  );

  // Auto-dismiss; a new notice restarts the timer.
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const loading = state.kind === "loading";
  const data = state.kind === "loaded" ? state.data : null;

  function refresh(): Promise<void> {
    setVersion((v) => v + 1);
    return refreshSummary();
  }

  function handleImported(count: number) {
    setNotice(
      `Imported ${count.toLocaleString("en-US")} ${count === 1 ? "holding" : "holdings"}.`,
    );
    void refresh();
  }

  // Starting another change clears the last confirmation.
  function openImport() {
    setNotice(null);
    setImportOpen(true);
  }

  function openAdd() {
    setNotice(null);
    setEditing(null);
    setFormOpen(true);
  }

  function openEdit(lot: PortfolioLot) {
    setNotice(null);
    setEditing(lot);
    setFormOpen(true);
  }

  function startDelete(lot: PortfolioLot) {
    setNotice(null);
    setDeleting(lot);
  }

  function startDeletePosition(position: PortfolioPosition) {
    setNotice(null);
    setDeletingPosition(position);
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Portfolio</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Your holdings with live prices and performance.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => void refresh()}
            disabled={loading || refreshing}
          >
            <RefreshCw className={refreshing ? "animate-spin" : ""} />
            Refresh
          </Button>
          <Button variant="outline" onClick={openImport}>
            <Upload />
            Import CSV
          </Button>
          <Button onClick={openAdd}>
            <Plus />
            Add holding
          </Button>
        </div>
      </header>

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

      <SummaryCards
        totals={data?.totals ?? null}
        holdingsCount={data?.positions.length ?? 0}
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

      {data && data.positions.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <p className="font-medium">No holdings yet</p>
            <p className="text-sm text-muted-foreground">
              Add your first position to start tracking its value.
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              <Button onClick={openAdd}>
                <Plus />
                Add holding
              </Button>
              <Button variant="outline" onClick={openImport}>
                <Upload />
                Import CSV
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {data && data.positions.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="min-w-0 lg:col-span-2">
            <PerformanceChart version={version} />
          </div>
          <SectorAllocation version={version} />
        </div>
      )}

      {data && data.positions.length > 0 && (
        <Card className="overflow-hidden">
          <CardContent className="p-0">
            <HoldingsTable
              positions={data.positions}
              onEdit={openEdit}
              onDelete={startDelete}
              onDeletePosition={startDeletePosition}
            />
          </CardContent>
        </Card>
      )}

      <HoldingFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        lot={editing}
        onSaved={() => void refresh()}
      />
      <ImportHoldingsDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={handleImported}
      />
      <ConfirmDeleteDialog
        lot={deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        onDeleted={() => void refresh()}
      />
      <ConfirmDeletePositionDialog
        position={deletingPosition}
        onOpenChange={(open) => !open && setDeletingPosition(null)}
        onDeleted={() => void refresh()}
      />
    </div>
  );
}
