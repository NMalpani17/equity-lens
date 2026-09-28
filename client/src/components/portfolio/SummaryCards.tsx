import type { ReactNode } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { PortfolioTotals } from "@/lib/api";
import {
  changeColor,
  formatCurrency,
  formatSignedCurrency,
  formatSignedPercent,
} from "@/lib/format";

interface SummaryCardsProps {
  totals: PortfolioTotals | null;
  holdingsCount: number;
  loading: boolean;
}

/** Top-of-dashboard KPI cards: total value, gain/loss, today's change, count. */
export function SummaryCards({ totals, holdingsCount, loading }: SummaryCardsProps) {
  // When no holding has a live price, the monetary totals are all $0.00 —
  // showing that would be misleading, so render an "unavailable" state instead.
  const noPrices =
    totals !== null && totals.pricedCount === 0 && totals.unpricedCount > 0;

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard label="Total value" footnote={<PartialNote totals={totals} />}>
        {loading || !totals ? (
          <Skeleton />
        ) : noPrices ? (
          <Unavailable />
        ) : (
          <span className="text-2xl font-semibold">
            {formatCurrency(totals.marketValue)}
          </span>
        )}
      </StatCard>

      <StatCard label="Total gain / loss">
        {loading || !totals ? (
          <Skeleton />
        ) : noPrices ? (
          <Unavailable />
        ) : (
          <span className={`text-2xl font-semibold ${changeColor(totals.gainLoss)}`}>
            {formatSignedCurrency(totals.gainLoss)}{" "}
            <span className="text-base font-normal">
              ({formatSignedPercent(totals.gainLossPercent)})
            </span>
          </span>
        )}
      </StatCard>

      <StatCard label="Today's change">
        {loading || !totals ? (
          <Skeleton />
        ) : noPrices ? (
          <Unavailable />
        ) : (
          <span className={`text-2xl font-semibold ${changeColor(totals.dailyChange)}`}>
            {formatSignedCurrency(totals.dailyChange)}
          </span>
        )}
      </StatCard>

      <StatCard label="Holdings">
        {loading ? (
          <Skeleton />
        ) : (
          <span className="text-2xl font-semibold">{holdingsCount}</span>
        )}
      </StatCard>
    </div>
  );
}

/** Muted placeholder shown when totals can't be computed from live prices. */
function Unavailable() {
  return <span className="text-2xl font-semibold text-muted-foreground">—</span>;
}

/** Footnote flagging that totals cover only the holdings that could be priced. */
function PartialNote({ totals }: { totals: PortfolioTotals | null }) {
  if (!totals || !totals.partial || totals.pricedCount === 0) {
    return null;
  }
  const total = totals.pricedCount + totals.unpricedCount;
  return (
    <span className="text-xs text-muted-foreground">
      Partial · {totals.pricedCount} of {total} holdings priced
    </span>
  );
}

function StatCard({
  label,
  children,
  footnote,
}: {
  label: string;
  children: ReactNode;
  footnote?: ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        {children}
        {footnote}
      </CardContent>
    </Card>
  );
}

function Skeleton() {
  return <div className="h-8 w-24 animate-pulse rounded bg-muted" />;
}
