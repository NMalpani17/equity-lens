import { useId, useState, type KeyboardEvent } from "react";
import { Loader2 } from "lucide-react";

import { Input } from "@/components/ui/input";
import { useCompanySearch } from "@/hooks/useCompanySearch";
import { matchLabel, type SymbolMatch } from "@/lib/marketApi";
import { cn } from "@/lib/utils";

const TYPE_LABELS: Record<SymbolMatch["type"], string | null> = {
  stock: null,
  etf: "ETF",
  adr: "ADR",
};

interface CompanySearchProps {
  /** The input's id, for an external <Label htmlFor>. */
  id: string;
  /** The text in the field: what the user typed, or the chosen ticker. */
  value: string;
  onChange: (value: string) => void;
  /** A suggestion was chosen (the field now holds its ticker). */
  onSelect?: (match: SymbolMatch) => void;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Extra ids describing the field (e.g. a hint), joined with ours. */
  "aria-describedby"?: string;
}

/**
 * Company search as you type: an ARIA 1.2 combobox with a listbox of up to 8
 * suggestions ("Microsoft Corp (MSFT)").
 *
 * Keyboard: Down/Up move through suggestions (Down opens them), Enter picks
 * the highlighted one, Escape closes the list. With nothing highlighted,
 * Enter submits the surrounding form, so an exact ticker typed in full still
 * works without picking a suggestion. A live region announces the result
 * count. Searches are debounced and cost no Finnhub calls.
 */
export function CompanySearch({
  id,
  value,
  onChange,
  onSelect,
  placeholder = "Company name or ticker",
  disabled,
  autoFocus,
  "aria-describedby": describedBy,
}: CompanySearchProps) {
  const listId = useId();
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(-1);
  // After a pick the field holds a ticker; don't search for it again.
  const [picked, setPicked] = useState<string | null>(null);
  const searching = focused && !disabled && value.trim() !== picked;
  const search = useCompanySearch(value, searching);

  const fresh = search.resultsFor === value.trim();
  const results = fresh ? search.results : [];
  const open = searching && !dismissed && results.length > 0;
  const activeIndex = open && active < results.length ? active : -1;

  function choose(match: SymbolMatch) {
    setPicked(match.ticker);
    setActive(-1);
    onChange(match.ticker);
    onSelect?.(match);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (results.length === 0) return;
      event.preventDefault();
      setDismissed(false);
      const step = event.key === "ArrowDown" ? 1 : -1;
      const start = open ? activeIndex : -1;
      const next =
        start === -1 && step === -1
          ? results.length - 1
          : (start + step + results.length) % results.length;
      setActive(next);
    } else if (event.key === "Enter" && activeIndex >= 0) {
      event.preventDefault(); // pick, don't submit
      choose(results[activeIndex]!);
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      setDismissed(true);
      setActive(-1);
    }
  }

  let status = "";
  if (searching && fresh && !search.loading) {
    if (results.length > 0) {
      status = `${results.length} suggestion${results.length === 1 ? "" : "s"}. Use the up and down arrows to choose.`;
    } else if (!search.ready) {
      status = "Suggestions are unavailable. Enter the exact ticker.";
    } else {
      status = "No matching companies. You can still enter an exact ticker.";
    }
  }

  return (
    <div className="relative">
      <Input
        id={id}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={
          activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined
        }
        aria-describedby={describedBy}
        value={value}
        onChange={(event) => {
          setPicked(null);
          setDismissed(false);
          setActive(-1);
          onChange(event.target.value);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          setActive(-1);
        }}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        disabled={disabled}
        autoFocus={autoFocus}
        className="pr-9"
      />
      {searching && search.loading && (
        <Loader2
          aria-hidden="true"
          className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground"
        />
      )}
      <ul
        id={listId}
        role="listbox"
        aria-label="Company suggestions"
        hidden={!open}
        className="absolute inset-x-0 top-full z-50 mt-1 max-h-72 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
      >
        {open &&
          results.map((match, index) => {
            const tags = [
              TYPE_LABELS[match.type],
              match.exchange === "OOTC" ? "OTC" : null,
            ].filter(Boolean);
            return (
              <li
                key={match.ticker}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === activeIndex}
                // Keep focus in the input; the click picks the option.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(match)}
                onMouseMove={() => setActive(index)}
                className={cn(
                  "flex cursor-pointer items-center justify-between gap-3 rounded-sm px-2 py-1.5 text-sm",
                  index === activeIndex && "bg-accent text-accent-foreground",
                )}
              >
                <span className="min-w-0 truncate">{matchLabel(match)}</span>
                {tags.length > 0 && (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {tags.join(" · ")}
                  </span>
                )}
              </li>
            );
          })}
      </ul>
      <p role="status" aria-live="polite" className="sr-only">
        {status}
      </p>
    </div>
  );
}
