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
import { deleteHolding, type PortfolioHolding } from "@/lib/api";

interface ConfirmDeleteDialogProps {
  /** The holding to delete, or null when the dialog is closed. */
  holding: PortfolioHolding | null;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}

export function ConfirmDeleteDialog({
  holding,
  onOpenChange,
  onDeleted,
}: ConfirmDeleteDialogProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    if (!holding) return;
    setSubmitting(true);
    setError(null);
    try {
      await deleteHolding(holding.id);
      onDeleted();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={holding !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete holding</DialogTitle>
          <DialogDescription>
            Remove {holding?.ticker} from your portfolio? This cannot be undone.
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
