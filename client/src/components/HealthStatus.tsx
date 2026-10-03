import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, XCircle } from "lucide-react";

import { getApiHealth, type HealthResponse } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; data: HealthResponse };

/** Re-check this often while the ai-service is waking. */
const WAKING_POLL_MS = 5000;

/** The ai-service scales to zero: unreachable means it's (re)starting. */
function isWaking(data: HealthResponse): boolean {
  return data.dependencies.aiService.status === "unreachable";
}

/** Displays the health of the full chain: client → api → ai-service. */
export function HealthStatus({ pollMs = WAKING_POLL_MS }: { pollMs?: number }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const poll = useRef<ReturnType<typeof setTimeout> | null>(null);

  const check = useCallback(
    async (quiet = false) => {
      if (poll.current) clearTimeout(poll.current);
      // Background re-checks keep the current rows instead of a spinner.
      if (!quiet) setState({ kind: "loading" });
      try {
        const data = await getApiHealth();
        setState({ kind: "loaded", data });
        if (isWaking(data)) {
          poll.current = setTimeout(() => void check(true), pollMs);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        setState({ kind: "error", message });
      }
    },
    [pollMs],
  );

  useEffect(() => {
    void check();
    return () => {
      if (poll.current) clearTimeout(poll.current);
    };
  }, [check]);

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>System health</CardTitle>
        <CardDescription>client → api → ai-service</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {state.kind === "loading" && (
          <p className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="animate-spin" /> Checking…
          </p>
        )}

        {state.kind === "error" && (
          <p className="flex items-center gap-2 text-destructive">
            <XCircle /> API unreachable: {state.message}
          </p>
        )}

        {state.kind === "loaded" && (
          <ul className="flex flex-col gap-2 text-sm">
            {/* The API answered, so it's up; it reports "degraded" only
                because the ai-service is asleep or starting. */}
            <StatusRow
              label="API (Express)"
              status={
                state.data.status === "ok" || isWaking(state.data) ? "ok" : "degraded"
              }
            />
            <StatusRow
              label="AI service (FastAPI)"
              status={
                state.data.dependencies.aiService.status === "ok"
                  ? "ok"
                  : isWaking(state.data)
                    ? "waking up"
                    : "down"
              }
            />
          </ul>
        )}

        <Button onClick={() => void check()} variant="outline" size="sm">
          Re-check
        </Button>
      </CardContent>
    </Card>
  );
}

type RowStatus = "ok" | "degraded" | "down" | "waking up";

const STATUS_STYLES: Record<
  RowStatus,
  { className: string; icon: typeof CheckCircle2; spin?: boolean }
> = {
  ok: { className: "text-emerald-600", icon: CheckCircle2 },
  degraded: { className: "text-amber-600", icon: AlertTriangle },
  down: { className: "text-destructive", icon: XCircle },
  "waking up": { className: "text-amber-600", icon: Loader2, spin: true },
};

function StatusRow({ label, status }: { label: string; status: RowStatus }) {
  const { className, icon: Icon, spin } = STATUS_STYLES[status];
  return (
    <li className="flex items-center justify-between">
      <span>{label}</span>
      <span className={`flex items-center gap-1 ${className}`} role="status">
        <Icon className={spin ? "size-4 animate-spin" : "size-4"} aria-hidden="true" />{" "}
        {status}
      </span>
    </li>
  );
}
