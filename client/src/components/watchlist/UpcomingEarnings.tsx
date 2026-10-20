import type { ReactNode } from "react";
import { CalendarDays, Loader2 } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useUpcomingEarnings } from "@/hooks/useUpcomingEarnings";
import { formatCurrency, formatDate } from "@/lib/format";
import { earningsHourLabel, type EarningsSource } from "@/lib/marketApi";

const SOURCE_LABEL: Record<EarningsSource, string> = {
  holding: "Holding",
  watchlist: "Watching",
  both: "Holding · Watching",
};

/**
 * The next 60 days of earnings for the user's holdings and watchlist:
 * date, before/after market when announced, and the EPS estimate when known.
 * The calendar comes from the database (refreshed once a day in the
 * background), so this costs no market-data calls.
 */
export function UpcomingEarnings({ version }: { version: number }) {
  const state = useUpcomingEarnings(version);
  const titleId = "upcoming-earnings-title";

  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-3">
      <div>
        <h2 id={titleId} className="text-lg font-semibold tracking-tight">
          Upcoming earnings
        </h2>
        <p className="text-sm text-muted-foreground">
          The next 60 days for your holdings and watchlist.
        </p>
      </div>
      <Card className="overflow-hidden">
        <CardContent className="p-0">
          <TooltipProvider>
            <Body state={state} />
          </TooltipProvider>
        </CardContent>
      </Card>
    </section>
  );
}

const EPS_ESTIMATE_HINT = "Analysts' expected earnings per share for the quarter.";

/** "EPS estimate $1.97"; the label explains itself on hover or keyboard focus. */
function EpsEstimate({ value }: { value: number | null }) {
  if (value === null) return <>No EPS estimate</>;
  return (
    <span>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            className="cursor-help rounded-sm underline decoration-dotted underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            EPS estimate
          </span>
        </TooltipTrigger>
        <TooltipContent>{EPS_ESTIMATE_HINT}</TooltipContent>
      </Tooltip>{" "}
      <span className="tabular-nums text-foreground">{formatCurrency(value)}</span>
    </span>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground">
      <CalendarDays aria-hidden="true" className="size-4 shrink-0" />
      {children}
    </p>
  );
}

function Body({ state }: { state: ReturnType<typeof useUpcomingEarnings> }) {
  if (state.kind === "loading") {
    return (
      <p
        role="status"
        className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground"
      >
        <Loader2 aria-hidden="true" className="size-4 animate-spin" />
        Loading earnings dates…
      </p>
    );
  }
  if (state.kind === "error") {
    return <Note>Earnings dates are unavailable right now. {state.message}</Note>;
  }
  const { earnings, unscheduled, refreshing, available } = state.data;
  if (earnings.length === 0 && unscheduled.length === 0) {
    return <Note>Add holdings or watch companies to see their earnings dates.</Note>;
  }
  if (earnings.length === 0) {
    if (refreshing)
      return <Note>Earnings dates are updating. Check back in a minute.</Note>;
    if (!available) return <Note>Earnings dates are unavailable right now.</Note>;
  }

  return (
    <div>
      {earnings.length === 0 ? (
        <Note>No earnings scheduled in the next 60 days.</Note>
      ) : (
        <ul aria-label="Upcoming earnings" className="divide-y">
          {earnings.map((event) => {
            const session = earningsHourLabel(event.hour);
            return (
              <li
                key={event.ticker}
                className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-4 gap-y-1 px-4 py-3 text-sm sm:grid-cols-[8rem_minmax(0,1fr)_11rem_9.5rem] sm:items-center"
              >
                <div className="font-medium tabular-nums">
                  {formatDate(event.date)}
                  {session && (
                    <span className="block text-xs font-normal text-muted-foreground">
                      {session}
                    </span>
                  )}
                </div>
                <div
                  data-testid="earnings-company"
                  className="flex min-w-0 items-baseline gap-2"
                >
                  <span className="shrink-0 font-semibold">{event.ticker}</span>
                  {event.name && (
                    <span className="min-w-0 truncate text-muted-foreground">
                      {event.name}
                    </span>
                  )}
                </div>
                <div className="col-start-2 text-xs text-muted-foreground sm:col-start-auto sm:text-right sm:text-sm">
                  <EpsEstimate value={event.epsEstimate} />
                </div>
                <div className="col-start-2 sm:col-start-auto">
                  <span className="rounded bg-secondary px-1.5 py-0.5 text-xs text-secondary-foreground">
                    {SOURCE_LABEL[event.source]}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {unscheduled.length > 0 && (
        <p className="border-t px-4 py-3 text-xs text-muted-foreground">
          No date in the next 60 days:{" "}
          {unscheduled.map((item) => item.ticker).join(", ")}
          {refreshing && " (the calendar is updating)"}
        </p>
      )}
    </div>
  );
}
