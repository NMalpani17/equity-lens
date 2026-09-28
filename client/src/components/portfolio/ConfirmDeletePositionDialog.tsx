import { useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { deleteHoldingsByTicker, type PortfolioPosition } from "@/lib/api";

interface ConfirmDeletePositionDialogProps {
  /** The position to delete (all its lots), or null when the dialog is closed. */
  position: PortfolioPosition | null;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}

export function ConfirmDeletePositionDialog({
  position,
  onOpenChange,
  onDeleted,
}: ConfirmDeletePositionDialogProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    if (!position) return;
    setSubmitting(true);
    setError(null);
    try {
      await deleteHoldingsByTicker(position.ticker);
      onDeleted();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  }

  const lotCount = position?.lots.length ?? 0;

  return (
    <Dialog open={position !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete position</DialogTitle>
          <DialogDescription>
            Delete all {lotCount} {lotCount === 1 ? "lot" : "lots"} of{" "}
            {position?.ticker}? This cannot be undone.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            variant="default"
            className="bg-destructive text-white hover:bg-destructive/90"
            onClick={handleConfirm}
            disabled={submitting}
          >
            {submitting && <Loader2 className="animate-spin" />}
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
