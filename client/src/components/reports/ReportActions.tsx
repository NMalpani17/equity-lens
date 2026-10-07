import { Loader2, RefreshCw, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { blockedMessage } from "@/lib/reportFormat";
import type { ReportView } from "@/lib/reportsApi";

/** Generate / Regenerate, shown per the API's canGenerate and blockedReason. */
export function ReportActions({
  view,
  generating,
  onGenerate,
}: {
  view: ReportView;
  generating: boolean;
  onGenerate: () => void;
}) {
  // Demo accounts are view-only: no button, just the explanation.
  const isDemo = view.blockedReason === "demo";
  const regenerate = view.report !== null && !view.outdated;
  const note = generating ? null : blockedMessage(view);
  const Icon = generating ? Loader2 : regenerate ? RefreshCw : Sparkles;

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
      {!isDemo && (
        <Button
          onClick={onGenerate}
          disabled={generating || !view.canGenerate}
          className="w-full sm:w-auto"
        >
          <Icon aria-hidden="true" className={generating ? "animate-spin" : ""} />
          {generating
            ? "Generating…"
            : regenerate
              ? "Regenerate report"
              : "Generate report"}
        </Button>
      )}
      <p className="text-xs text-muted-foreground" role={note ? "status" : undefined}>
        {note ??
          (generating
            ? "Takes about a minute. Leaving this page cancels it."
            : `${view.usage.remaining} of ${view.usage.limit} reports left today.`)}
      </p>
    </div>
  );
}
