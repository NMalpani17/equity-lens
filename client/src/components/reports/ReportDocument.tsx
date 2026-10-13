import { useState } from "react";
import { Info } from "lucide-react";

import { ChatCharts } from "@/components/chat/ChatCharts";
import { ChatMarkdown } from "@/components/chat/ChatMarkdown";
import { CitationDialog } from "@/components/chat/CitationDialog";
import { DataSourceDialog } from "@/components/reports/DataSourceDialog";
import { Card } from "@/components/ui/card";
import type { Citation } from "@/lib/chatApi";
import { formatDate, formatTimestampDate } from "@/lib/format";
import type { DataSource, Report } from "@/lib/reportsApi";

/** "as of" facts shown under the title, skipping any that are unknown. */
function asOfParts(report: Report): string[] {
  const parts: string[] = [];
  if (report.asOf.latestCall) {
    parts.push(`Earnings call ${formatDate(report.asOf.latestCall)}`);
  }
  if (report.asOf.quote) parts.push(`Quote as of ${report.asOf.quote}`);
  if (report.asOf.prices)
    parts.push(`Prices through ${formatDate(report.asOf.prices)}`);
  return parts;
}

/**
 * Headings inside a section (e.g. "### New" in What changed) sit below the
 * section's own h3 title, so the outline stays page h1 > report h2 > h3 > h4.
 */
function nestHeadings(markdown: string): string {
  return markdown.replace(/^#{1,6}[ \t]+/gm, "#### ");
}

/** A generated report: header with dates, six sections, chart and disclaimer. */
export function ReportDocument({ report }: { report: Report }) {
  const [citation, setCitation] = useState<Citation | null>(null);
  const [source, setSource] = useState<DataSource | null>(null);
  const { quarter, priorQuarter } = report;
  const callDate = quarter.callDate ? ` (${formatDate(quarter.callDate)})` : "";

  return (
    <article aria-label={`${report.companyName} research report`} className="space-y-4">
      {/* One document card: a header, then each section under a thin divider. */}
      <Card className="divide-y overflow-hidden">
        <header className="space-y-2 p-4 sm:p-6">
          <h2 className="text-2xl font-semibold tracking-tight">
            {report.companyName} ({report.ticker})
          </h2>
          <p className="text-sm text-muted-foreground">
            Based on the {quarter.label} earnings call{callDate}
            {priorQuarter ? `, compared with ${priorQuarter.label}` : ""}.
          </p>
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">
              Generated on {formatTimestampDate(report.generatedAt)}
            </span>
            {asOfParts(report).map((part) => (
              <span key={part}> · {part}</span>
            ))}
          </p>
        </header>

        {report.sections.map((section) => (
          <section
            key={section.key}
            aria-labelledby={`report-${section.key}`}
            className="p-4 sm:p-6"
          >
            <h3
              id={`report-${section.key}`}
              className="mb-3 text-lg font-semibold tracking-tight"
            >
              {section.title}
            </h3>
            {section.key === "stock" && report.chart && (
              <div className="mb-3">
                <ChatCharts charts={[report.chart]} />
              </div>
            )}
            <ChatMarkdown
              content={nestHeadings(section.markdown)}
              citations={report.citations}
              onCite={setCitation}
              dataSources={report.dataSources}
              onDataSource={setSource}
            />
          </section>
        ))}
      </Card>

      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
        <span>{report.disclaimer}</span>
      </p>

      <CitationDialog citation={citation} onOpenChange={() => setCitation(null)} />
      <DataSourceDialog source={source} onOpenChange={() => setSource(null)} />
    </article>
  );
}
