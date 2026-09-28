import { Fragment, useState } from "react";
import { ChevronDown, ChevronRight, Pencil, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { PortfolioLot, PortfolioPosition, PriceStatus } from "@/lib/api";
import {
  changeColor,
  formatCurrency,
  formatDate,
  formatShares,
  formatSignedCurrency,
  formatSignedPercent,
} from "@/lib/format";

interface HoldingsTableProps {
  positions: PortfolioPosition[];
  onEdit: (lot: PortfolioLot) => void;
  onDelete: (lot: PortfolioLot) => void;
  onDeletePosition: (position: PortfolioPosition) => void;
}

const PRICE_STATUS_LABEL: Record<PriceStatus, string> = {
  ok: "",
  not_found: "unknown ticker",
  unavailable: "price unavailable",
};

export function HoldingsTable({
  positions,
  onEdit,
  onDelete,
  onDeletePosition,
}: HoldingsTableProps) {
  // Positions with more than one lot start collapsed; the set holds the tickers
  // the user has expanded.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggle(ticker: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(ticker)) {
        next.delete(ticker);
      } else {
        next.add(ticker);
      }
      return next;
    });
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Ticker</TableHead>
          <TableHead className="text-right">Shares</TableHead>
          <TableHead className="text-right">Avg buy price</TableHead>
          <TableHead className="text-right">Current</TableHead>
          <TableHead className="text-right">Market value</TableHead>
          <TableHead className="text-right">Gain / loss</TableHead>
          <TableHead className="text-right">Today</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {positions.map((position) => {
          const isOpen = expanded.has(position.ticker);
          return (
            <Fragment key={position.ticker}>
              <TableRow
                className="cursor-pointer"
                onClick={() => toggle(position.ticker)}
              >
                <TableCell>
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground" aria-hidden="true">
                      {isOpen ? (
                        <ChevronDown className="size-4" />
                      ) : (
                        <ChevronRight className="size-4" />
                      )}
                    </span>
                    <div>
                      <div className="font-medium">
                        {position.ticker}
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                          {position.lots.length}{" "}
                          {position.lots.length === 1 ? "lot" : "lots"}
                        </span>
                      </div>
                      {position.name && (
                        <div className="text-xs text-muted-foreground">
                          {position.name}
                        </div>
                      )}
                    </div>
                  </div>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatShares(position.totalShares)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCurrency(position.avgBuyPrice)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {position.currentPrice !== null ? (
                    formatCurrency(position.currentPrice)
                  ) : (
                    <UnavailableBadge
                      label={PRICE_STATUS_LABEL[position.priceStatus]}
                    />
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {position.marketValue !== null
                    ? formatCurrency(position.marketValue)
                    : "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  <GainLoss
                    gainLoss={position.gainLoss}
                    gainLossPercent={position.gainLossPercent}
                  />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  <DailyChange dailyChange={position.dailyChange} />
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Delete all ${position.ticker} lots`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeletePosition(position);
                      }}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>

              {isOpen &&
                position.lots.map((lot) => (
                  <TableRow key={lot.id} className="bg-muted/30">
                    <TableCell className="pl-10">
                      <div className="text-sm">Lot</div>
                      {lot.purchaseDate && (
                        <div className="text-xs text-muted-foreground">
                          {formatDate(lot.purchaseDate)}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatShares(lot.shares)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(lot.buyPrice)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {lot.currentPrice !== null
                        ? formatCurrency(lot.currentPrice)
                        : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {lot.marketValue !== null ? formatCurrency(lot.marketValue) : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      <GainLoss
                        gainLoss={lot.gainLoss}
                        gainLossPercent={lot.gainLossPercent}
                      />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      <DailyChange dailyChange={lot.dailyChange} />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Edit ${lot.ticker} lot`}
                          onClick={() => onEdit(lot)}
                        >
                          <Pencil />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Delete ${lot.ticker} lot`}
                          onClick={() => onDelete(lot)}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
            </Fragment>
          );
        })}
      </TableBody>
    </Table>
  );
}

function GainLoss({
  gainLoss,
  gainLossPercent,
}: {
  gainLoss: number | null;
  gainLossPercent: number | null;
}) {
  if (gainLoss === null || gainLossPercent === null) return <>—</>;
  return (
    <span className={changeColor(gainLoss)}>
      {formatSignedCurrency(gainLoss)}
      <span className="ml-1 text-xs">({formatSignedPercent(gainLossPercent)})</span>
    </span>
  );
}

function DailyChange({ dailyChange }: { dailyChange: number | null }) {
  if (dailyChange === null) return <>—</>;
  return (
    <span className={changeColor(dailyChange)}>
      {formatSignedCurrency(dailyChange)}
    </span>
  );
}

function UnavailableBadge({ label }: { label: string }) {
  return (
    <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
      {label}
    </span>
  );
}
