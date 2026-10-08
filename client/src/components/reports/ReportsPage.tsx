import { AlertTriangle, FileText, Loader2, X } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";

import { DemoBanner } from "@/components/DemoBanner";
import { Header } from "@/components/Header";
import { ReportActions } from "@/components/reports/ReportActions";
import { ReportDocument } from "@/components/reports/ReportDocument";
import { ReportProgress } from "@/components/reports/ReportProgress";
import { TickerPicker } from "@/components/reports/TickerPicker";
import { Card, CardContent } from "@/components/ui/card";
import { useAuth } from "@/context/auth-context";
import { useReports } from "@/hooks/useReports";

function ErrorNote({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss?: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
    >
      <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <p className="flex-1">{message}</p>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss message"
          className="rounded-sm opacity-70 hover:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      )}
    </div>
  );
}

/**
 * Research reports: pick a company, read its multi-agent report (cited
 * passages, price chart, dates), and generate or regenerate it if allowed.
 * Reports are shared by all users; demo accounts can only view them.
 */
export function ReportsPage() {
  const { isDemo } = useAuth();
  const { ticker: param } = useParams();
  const navigate = useNavigate();
  const reports = useReports(param?.toUpperCase());
  const { ticker, view } = reports;

  const select = (next: string) => navigate(`/reports/${encodeURIComponent(next)}`);

  return (
    <div className="min-h-screen">
      {isDemo && <DemoBanner />}
      <Header />
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-5 p-4 sm:p-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">Research reports</h1>
          <p className="text-sm text-muted-foreground">
            What a company said on its latest earnings call, what changed since the
            quarter before, and how the stock has moved, written by three AI agents with
            every claim cited.
          </p>
        </header>

        {reports.listError && <ErrorNote message={reports.listError} />}
        {reports.tickers === null && !reports.listError && (
          <p
            role="status"
            className="flex items-center gap-2 text-sm text-muted-foreground"
          >
            <Loader2 aria-hidden="true" className="size-4 animate-spin" />
            Loading companies…
          </p>
        )}
        {reports.tickers && (
          <TickerPicker
            tickers={reports.tickers}
            value={ticker}
            onChange={select}
            disabled={reports.generating}
          />
        )}

        {reports.tickers?.length === 0 && (
          <Card>
            <CardContent className="flex items-center gap-3 p-4 text-sm text-muted-foreground sm:p-6">
              <FileText aria-hidden="true" className="size-5 shrink-0" />
              No companies are indexed yet.
            </CardContent>
          </Card>
        )}

        {ticker && reports.loadingView && !view && (
          <p
            role="status"
            className="flex items-center gap-2 text-sm text-muted-foreground"
          >
            <Loader2 aria-hidden="true" className="size-4 animate-spin" />
            Loading the report…
          </p>
        )}
        {ticker && reports.viewError && <ErrorNote message={reports.viewError} />}

        {view && (
          <>
            <ReportActions
              view={view}
              generating={reports.generating}
              onGenerate={() => void reports.generate()}
            />
            {reports.generateError && (
              <ErrorNote
                message={reports.generateError}
                onDismiss={reports.dismissGenerateError}
              />
            )}
            {reports.generating && (
              <Card>
                <CardContent className="p-4 sm:p-6">
                  <ReportProgress items={reports.progress} />
                </CardContent>
              </Card>
            )}
            {view.report && view.outdated && (
              <p
                role="note"
                className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
              >
                A newer earnings call ({view.latestQuarter.label}) is indexed. This
                report covers {view.report.quarter.label}.
              </p>
            )}
            {view.report ? (
              <ReportDocument report={view.report} />
            ) : (
              !reports.generating && (
                <Card>
                  <CardContent className="flex items-center gap-3 p-4 text-sm text-muted-foreground sm:p-6">
                    <FileText aria-hidden="true" className="size-5 shrink-0" />
                    {view.generating
                      ? `${view.companyName}'s report is being generated.`
                      : `There's no report for ${view.companyName} (${view.latestQuarter.label}) yet.`}
                  </CardContent>
                </Card>
              )
            )}
          </>
        )}
      </main>
    </div>
  );
}
