import { useCallback, useEffect, useRef, useState } from "react";

import { getApiHealth } from "@/lib/api";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** Re-check this often while the ai-service is waking. */
const WAKING_POLL_MS = 5000;

type Overall = "checking" | "ok" | "waking" | "degraded";
type ServiceState = "checking" | "ok" | "waking up" | "down" | "unreachable";

interface Status {
  overall: Overall;
  api: ServiceState;
  ai: ServiceState;
}

const CHECKING: Status = { overall: "checking", api: "checking", ai: "checking" };

/** Map the /api/health body (external input) to the indicator's states. */
function toStatus(body: unknown): Status {
  const data = body as {
    status?: unknown;
    dependencies?: { aiService?: { status?: unknown } };
  } | null;
  const ai = data?.dependencies?.aiService?.status;
  if (data?.status === "ok" && ai === "ok") {
    return { overall: "ok", api: "ok", ai: "ok" };
  }
  // The API answered, so it's up; the ai-service scales to zero, so being
  // unreachable means it's (re)starting.
  if (ai === "unreachable") {
    return { overall: "waking", api: "ok", ai: "waking up" };
  }
  return { overall: "degraded", api: "ok", ai: "down" };
}

const OVERALL_LABEL: Record<Overall, string> = {
  checking: "Checking",
  ok: "All systems ok",
  waking: "AI service waking up",
  degraded: "Degraded",
};

const DOT_CLASS: Record<Overall, string> = {
  checking: "bg-muted-foreground/40",
  ok: "bg-emerald-600",
  waking: "bg-amber-600 motion-safe:animate-pulse",
  degraded: "bg-destructive",
};

/**
 * A small status dot for the top bar: green = ok, amber = the ai-service is
 * waking up (re-checked every few seconds), red = degraded. Hover or focus
 * shows per-service status; the button's accessible name says the same, and
 * changes are announced politely to screen readers.
 */
export function HealthIndicator({ pollMs = WAKING_POLL_MS }: { pollMs?: number }) {
  const [status, setStatus] = useState<Status>(CHECKING);
  const poll = useRef<ReturnType<typeof setTimeout> | null>(null);

  const check = useCallback(async () => {
    if (poll.current) clearTimeout(poll.current);
    let next: Status;
    try {
      next = toStatus(await getApiHealth());
    } catch {
      next = { overall: "degraded", api: "unreachable", ai: "unreachable" };
    }
    setStatus(next);
    if (next.overall === "waking") {
      poll.current = setTimeout(() => void check(), pollMs);
    }
  }, [pollMs]);

  useEffect(() => {
    void check();
    return () => {
      if (poll.current) clearTimeout(poll.current);
    };
  }, [check]);

  const label = OVERALL_LABEL[status.overall];
  const description = `System status: ${label}. API: ${status.api}. AI service: ${status.ai}.`;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={description}
            className="flex size-6 shrink-0 items-center justify-center rounded-full sm:size-8 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span
              aria-hidden="true"
              data-status={status.overall}
              className={cn("size-2.5 rounded-full", DOT_CLASS[status.overall])}
            />
          </button>
        </TooltipTrigger>
        <TooltipContent align="end">
          <p className="font-medium">{label}</p>
          <dl className="mt-1 grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5">
            <dt>API</dt>
            <dd>{status.api}</dd>
            <dt>AI service</dt>
            <dd>{status.ai}</dd>
          </dl>
        </TooltipContent>
      </Tooltip>
      {/* Announces status changes (e.g. waking up -> ok) without stealing focus. */}
      <span className="sr-only" role="status" aria-live="polite">
        {status.overall === "checking" ? "" : `System status: ${label}`}
      </span>
    </TooltipProvider>
  );
}
