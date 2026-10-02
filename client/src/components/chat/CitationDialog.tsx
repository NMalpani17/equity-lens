import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Citation } from "@/lib/chatApi";

interface CitationDialogProps {
  citation: Citation | null;
  onOpenChange: (open: boolean) => void;
}

const SECTION_LABELS: Record<string, string> = {
  prepared_remarks: "Prepared remarks",
  qa: "Q&A",
};

/** The transcript passage behind a [n] citation. */
export function CitationDialog({ citation, onOpenChange }: CitationDialogProps) {
  return (
    <Dialog open={citation !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        {citation && (
          <>
            <DialogHeader>
              <DialogTitle>
                [{citation.id}] {citation.companyName} ({citation.ticker})
              </DialogTitle>
              <DialogDescription>
                Q{citation.fiscalQuarter} FY{citation.fiscalYear} earnings call
                {citation.callDate ? ` · ${citation.callDate}` : ""} ·{" "}
                {SECTION_LABELS[citation.section] ?? citation.section}
              </DialogDescription>
            </DialogHeader>
            <p className="text-sm font-medium">
              {citation.speaker}
              {citation.role ? `, ${citation.role}` : ""}
            </p>
            <blockquote className="max-h-80 overflow-y-auto whitespace-pre-wrap border-l-2 pl-3 text-sm text-muted-foreground">
              {citation.text}
            </blockquote>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
