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
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard label="Total value">
        {loading || !totals ? (
          <Skeleton />
        ) : (
          <span className="text-2xl font-semibold">
            {formatCurrency(totals.marketValue)}
          </span>
        )}
      </StatCard>

      <StatCard label="Total gain / loss">
        {loading || !totals ? (
          <Skeleton />
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

function StatCard({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function Skeleton() {
  return <div className="h-8 w-24 animate-pulse rounded bg-muted" />;
}
