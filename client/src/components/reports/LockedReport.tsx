import { useId } from "react";
import { Loader2, Lock } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useDemoSignUp } from "@/hooks/useDemoSignUp";

/** Shown to demo users instead of a report outside the demo list. */
export function LockedReport({ companyName }: { companyName: string }) {
  const { signUp, busy } = useDemoSignUp();
  const titleId = useId();
  return (
    <Card>
      <CardContent
        role="region"
        aria-labelledby={titleId}
        className="flex flex-col items-start gap-3 p-4 sm:flex-row sm:items-center sm:p-6"
      >
        <Lock aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
        <div className="flex-1 space-y-1">
          <h2 id={titleId} className="text-sm font-medium">
            Sign up to view or generate this report
          </h2>
          <p className="text-sm text-muted-foreground">
            The demo includes a few companies. With a free account you can read{" "}
            {companyName}&apos;s report and generate your own.
          </p>
        </div>
        <Button onClick={() => void signUp()} disabled={busy}>
          {busy && <Loader2 className="animate-spin" />}
          Sign up
        </Button>
      </CardContent>
    </Card>
  );
}
