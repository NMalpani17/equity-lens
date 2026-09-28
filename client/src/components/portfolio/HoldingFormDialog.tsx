import { useEffect, useState, type FormEvent } from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createHolding, updateHolding, type PortfolioHolding } from "@/lib/api";

interface HoldingFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The holding being edited, or null to add a new one. */
  holding: PortfolioHolding | null;
  /** Called after a successful create/update so the parent can refresh. */
  onSaved: () => void;
}

export function HoldingFormDialog({
  open,
  onOpenChange,
  holding,
  onSaved,
}: HoldingFormDialogProps) {
  const isEdit = holding !== null;
  const [ticker, setTicker] = useState("");
  const [shares, setShares] = useState("");
  const [buyPrice, setBuyPrice] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset the form whenever it opens (or the target holding changes).
  useEffect(() => {
    if (open) {
      setTicker(holding?.ticker ?? "");
      setShares(holding ? String(holding.shares) : "");
      setBuyPrice(holding ? String(holding.buyPrice) : "");
      setError(null);
    }
  }, [open, holding]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const sharesNum = Number(shares);
    const buyPriceNum = Number(buyPrice);

    if (!ticker.trim()) {
      setError("Ticker is required.");
      return;
    }
    if (!Number.isFinite(sharesNum) || sharesNum <= 0) {
      setError("Shares must be a number greater than 0.");
      return;
    }
    if (!Number.isFinite(buyPriceNum) || buyPriceNum <= 0) {
      setError("Buy price must be a number greater than 0.");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const input = {
        ticker: ticker.trim().toUpperCase(),
        shares: sharesNum,
        buyPrice: buyPriceNum,
      };
      if (isEdit) {
        await updateHolding(holding.id, input);
      } else {
        await createHolding(input);
      }
      onSaved();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit holding" : "Add holding"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Update the shares or buy price for this position."
              : "Add an equity position to your portfolio."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="ticker">Ticker</Label>
            <Input
              id="ticker"
              value={ticker}
              onChange={(e) => setTicker(e.target.value)}
              placeholder="AAPL"
              autoComplete="off"
              disabled={isEdit}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="shares">Shares</Label>
            <Input
              id="shares"
              type="number"
              step="any"
              min="0"
              value={shares}
              onChange={(e) => setShares(e.target.value)}
              placeholder="10"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="buyPrice">Buy price (USD)</Label>
            <Input
              id="buyPrice"
              type="number"
              step="any"
              min="0"
              value={buyPrice}
              onChange={(e) => setBuyPrice(e.target.value)}
              placeholder="150.00"
            />
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting && <Loader2 className="animate-spin" />}
              {isEdit ? "Save changes" : "Add holding"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
