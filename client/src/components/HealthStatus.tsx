import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";

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
            <StatusRow label="API (Express)" ok={state.data.status === "ok"} />
            <StatusRow
              label="AI service (FastAPI)"
              ok={state.data.dependencies.aiService.status === "ok"}
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

function StatusRow({ label, ok }: { label: string; ok: boolean }) {
  return (
    <li className="flex items-center justify-between">
      <span>{label}</span>
      {ok ? (
        <span className="flex items-center gap-1 text-emerald-600">
          <CheckCircle2 className="size-4" /> ok
        </span>
      ) : (
        <span className="flex items-center gap-1 text-destructive">
          <XCircle className="size-4" /> down
        </span>
      )}
    </li>
  );
}
