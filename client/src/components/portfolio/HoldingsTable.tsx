import { Pencil, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { PortfolioHolding } from "@/lib/api";
import {
  changeColor,
  formatCurrency,
  formatShares,
  formatSignedCurrency,
  formatSignedPercent,
} from "@/lib/format";

interface HoldingsTableProps {
  holdings: PortfolioHolding[];
  onEdit: (holding: PortfolioHolding) => void;
  onDelete: (holding: PortfolioHolding) => void;
}

const PRICE_STATUS_LABEL: Record<PortfolioHolding["priceStatus"], string> = {
  ok: "",
  not_found: "unknown ticker",
  unavailable: "price unavailable",
};

export function HoldingsTable({ holdings, onEdit, onDelete }: HoldingsTableProps) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Ticker</TableHead>
          <TableHead className="text-right">Shares</TableHead>
          <TableHead className="text-right">Buy price</TableHead>
          <TableHead className="text-right">Current</TableHead>
          <TableHead className="text-right">Market value</TableHead>
          <TableHead className="text-right">Gain / loss</TableHead>
          <TableHead className="text-right">Today</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {holdings.map((holding) => (
          <TableRow key={holding.id}>
            <TableCell>
              <div className="font-medium">{holding.ticker}</div>
              {holding.name && (
                <div className="text-xs text-muted-foreground">{holding.name}</div>
              )}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {formatShares(holding.shares)}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {formatCurrency(holding.buyPrice)}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {holding.currentPrice !== null ? (
                formatCurrency(holding.currentPrice)
              ) : (
                <UnavailableBadge label={PRICE_STATUS_LABEL[holding.priceStatus]} />
              )}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {holding.marketValue !== null ? formatCurrency(holding.marketValue) : "—"}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {holding.gainLoss !== null && holding.gainLossPercent !== null ? (
                <span className={changeColor(holding.gainLoss)}>
                  {formatSignedCurrency(holding.gainLoss)}
                  <span className="ml-1 text-xs">
                    ({formatSignedPercent(holding.gainLossPercent)})
                  </span>
                </span>
              ) : (
                "—"
              )}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {holding.dailyChange !== null ? (
                <span className={changeColor(holding.dailyChange)}>
                  {formatSignedCurrency(holding.dailyChange)}
                </span>
              ) : (
                "—"
              )}
            </TableCell>
            <TableCell className="text-right">
              <div className="flex justify-end gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Edit ${holding.ticker}`}
                  onClick={() => onEdit(holding)}
                >
                  <Pencil />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Delete ${holding.ticker}`}
                  onClick={() => onDelete(holding)}
                >
                  <Trash2 />
                </Button>
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function UnavailableBadge({ label }: { label: string }) {
  return (
    <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
      {label}
    </span>
  );
}
