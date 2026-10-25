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
import { CompanySearch } from "@/components/market/CompanySearch";
import { createHolding, updateHolding, type PortfolioLot } from "@/lib/api";
import { keepOpenForSuggestions } from "@/lib/combobox";
import { todayISODate } from "@/lib/format";

interface HoldingFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The lot being edited, or null to add a new one. */
  lot: PortfolioLot | null;
  /** Called after a successful create/update so the parent can refresh. */
  onSaved: () => void;
}

export function HoldingFormDialog({
  open,
  onOpenChange,
  lot,
  onSaved,
}: HoldingFormDialogProps) {
  const isEdit = lot !== null;
  const today = todayISODate();
  const [ticker, setTicker] = useState("");
  // The name of the suggestion picked, shown under the field.
  const [company, setCompany] = useState<string | null>(null);
  const [shares, setShares] = useState("");
  const [buyPrice, setBuyPrice] = useState("");
  const [purchaseDate, setPurchaseDate] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset the form whenever it opens (or the target lot changes). New lots
  // default the purchase date to today; the user can change or clear it.
  useEffect(() => {
    if (open) {
      setTicker(lot?.ticker ?? "");
      setCompany(null);
      setShares(lot ? String(lot.shares) : "");
      setBuyPrice(lot ? String(lot.buyPrice) : "");
      setPurchaseDate(lot ? (lot.purchaseDate ?? "") : todayISODate());
      setError(null);
    }
  }, [open, lot]);

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
    // The date input's `max` normally blocks future dates via native
    // validation; this guard is a fallback in case a future value slips
    // through (and mirrors the server-side check).
    if (purchaseDate && purchaseDate > today) {
      setError("Purchase date cannot be in the future.");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const input = {
        ticker: ticker.trim().toUpperCase(),
        shares: sharesNum,
        buyPrice: buyPriceNum,
        purchaseDate: purchaseDate ? purchaseDate : null,
      };
      if (isEdit) {
        await updateHolding(lot.id, input);
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
      <DialogContent onEscapeKeyDown={keepOpenForSuggestions}>
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit lot" : "Add holding"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Update the shares, buy price, or purchase date for this lot."
              : "Add an equity purchase to your portfolio."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="ticker">Ticker</Label>
            {isEdit ? (
              <Input id="ticker" value={ticker} autoComplete="off" disabled readOnly />
            ) : (
              <CompanySearch
                id="ticker"
                value={ticker}
                onChange={(next) => {
                  setTicker(next);
                  setCompany(null);
                }}
                onSelect={(match) => setCompany(match.name)}
                placeholder="Company or ticker, e.g. Microsoft or MSFT"
                aria-describedby="ticker-company"
              />
            )}
            {!isEdit && (
              <p id="ticker-company" className="text-xs text-muted-foreground">
                {company ?? "Search by name, or type the exact ticker."}
              </p>
            )}
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
          <div className="flex flex-col gap-2">
            <Label htmlFor="purchaseDate">Purchase date (optional)</Label>
            <Input
              id="purchaseDate"
              type="date"
              max={today}
              value={purchaseDate}
              onChange={(e) => setPurchaseDate(e.target.value)}
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
