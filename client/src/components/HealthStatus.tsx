import { useCallback, useEffect, useState } from "react";
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

/** Displays the health of the full chain: client → api → ai-service. */
export function HealthStatus() {
  const [state, setState] = useState<State>({ kind: "loading" });

  const check = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const data = await getApiHealth();
      setState({ kind: "loaded", data });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      setState({ kind: "error", message });
    }
  }, []);

  useEffect(() => {
    void check();
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
            <StatusRow
              label="API (Express)"
              status={state.data.status === "ok" ? "ok" : "degraded"}
            />
            <StatusRow
              label="AI service (FastAPI)"
              status={state.data.dependencies.aiService.status === "ok" ? "ok" : "down"}
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

type RowStatus = "ok" | "degraded" | "down";

const STATUS_STYLES: Record<
  RowStatus,
  { className: string; icon: typeof CheckCircle2 }
> = {
  ok: { className: "text-emerald-600", icon: CheckCircle2 },
  degraded: { className: "text-amber-600", icon: AlertTriangle },
  down: { className: "text-destructive", icon: XCircle },
};

function StatusRow({ label, status }: { label: string; status: RowStatus }) {
  const { className, icon: Icon } = STATUS_STYLES[status];
  return (
    <li className="flex items-center justify-between">
      <span>{label}</span>
      <span className={`flex items-center gap-1 ${className}`}>
        <Icon className="size-4" /> {status}
      </span>
    </li>
  );
}
