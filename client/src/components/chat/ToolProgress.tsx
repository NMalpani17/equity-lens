import { Check, Loader2, X } from "lucide-react";

import type { ToolProgressItem } from "@/hooks/useChat";

/** Live tool activity for the streaming reply, e.g. "Searching NVDA transcripts…". */
export function ToolProgress({ items }: { items: ToolProgressItem[] }) {
  if (items.length === 0) return null;
  return (
    <ul
      aria-label="Research progress"
      className="mb-2 space-y-1 text-xs text-muted-foreground"
    >
      {items.map((item) => (
        <li key={item.id} className="flex items-center gap-1.5">
          {item.state === "running" && (
            <Loader2 aria-hidden="true" className="size-3 animate-spin" />
          )}
          {item.state === "ok" && (
            <Check aria-hidden="true" className="size-3 text-emerald-600" />
          )}
          {item.state === "failed" && (
            <X aria-hidden="true" className="size-3 text-destructive" />
          )}
          <span>{item.label}</span>
          {item.summary && item.state !== "running" && (
            <span className="text-muted-foreground/80">· {item.summary}</span>
          )}
        </li>
      ))}
    </ul>
  );
}
