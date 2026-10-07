import { Check, Circle, Loader2, X } from "lucide-react";

import type { AgentProgress } from "@/hooks/useReports";

/**
 * One line per agent while a report is generated. The transcript and market
 * researchers run at the same time; the writer starts when both are done.
 */
export function ReportProgress({ items }: { items: AgentProgress[] }) {
  return (
    <ul aria-label="Report progress" className="space-y-2 text-sm">
      {items.map((item) => (
        <li key={item.agent} className="flex items-start gap-2">
          <span className="mt-0.5 shrink-0">
            {item.state === "pending" && (
              <Circle aria-hidden="true" className="size-4 text-muted-foreground/50" />
            )}
            {item.state === "running" && (
              <Loader2
                aria-hidden="true"
                className="size-4 animate-spin text-primary"
              />
            )}
            {item.state === "done" && (
              <Check aria-hidden="true" className="size-4 text-emerald-600" />
            )}
            {item.state === "failed" && (
              <X aria-hidden="true" className="size-4 text-destructive" />
            )}
          </span>
          <span className={item.state === "pending" ? "text-muted-foreground" : ""}>
            {item.label}
            {item.summary && item.state !== "running" && (
              <span className="text-muted-foreground"> · {item.summary}</span>
            )}
            <span className="sr-only"> ({item.state})</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
