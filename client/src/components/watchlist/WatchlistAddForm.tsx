import { useState, type FormEvent } from "react";
import { Loader2, Plus } from "lucide-react";

import { CompanySearch } from "@/components/market/CompanySearch";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

interface WatchlistAddFormProps {
  count: number;
  limit: number;
  onAdd: (ticker: string) => Promise<void>;
}

/** Search for a company (or type its exact ticker) and add it to the watchlist. */
export function WatchlistAddForm({ count, limit, onAdd }: WatchlistAddFormProps) {
  const [ticker, setTicker] = useState("");
  const [company, setCompany] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const full = count >= limit;

  async function add(value: string) {
    const symbol = value.trim().toUpperCase();
    if (!symbol) {
      setError("Enter a company name or ticker.");
      return;
    }
    setAdding(true);
    setError(null);
    try {
      await onAdd(symbol);
      setTicker("");
      setCompany(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setAdding(false);
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    void add(ticker);
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2">
      <Label htmlFor="watchlist-ticker">Add a company</Label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="min-w-0 flex-1">
          <CompanySearch
            id="watchlist-ticker"
            value={ticker}
            onChange={(next) => {
              setTicker(next);
              setCompany(null);
              setError(null);
            }}
            onSelect={(match) => setCompany(match.name)}
            placeholder="Company or ticker, e.g. Microsoft or MSFT"
            disabled={full || adding}
            aria-describedby="watchlist-ticker-hint"
          />
        </div>
        <Button type="submit" disabled={full || adding} className="sm:w-auto">
          {adding ? <Loader2 className="animate-spin" /> : <Plus />}
          Add to watchlist
        </Button>
      </div>
      <p id="watchlist-ticker-hint" className="text-xs text-muted-foreground">
        {full
          ? `You're watching ${limit} companies, the most allowed. Remove one to add another.`
          : (company ??
            `${count} of ${limit} companies. Search by name, or type the exact ticker.`)}
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}
