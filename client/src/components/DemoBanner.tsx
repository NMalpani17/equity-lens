import { useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useAuth } from "@/context/auth-context";
import { rememberSignupIntent } from "@/lib/authIntent";

/**
 * Slim banner shown to anonymous demo users, nudging them to create a real
 * account. "Sign up" signs the throwaway demo user out (which routes to the
 * login page) after flagging it to open in sign-up mode.
 */
export function DemoBanner() {
  const { signOut } = useAuth();
  const [busy, setBusy] = useState(false);

  async function handleSignUp() {
    setBusy(true);
    try {
      rememberSignupIntent();
      await signOut();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-amber-500/15 px-4 py-2 text-center text-sm text-amber-900 dark:text-amber-200"
    >
      <span>You&apos;re exploring a demo. Sign up to save your own portfolio.</span>
      <Button size="sm" onClick={() => void handleSignUp()} disabled={busy}>
        {busy && <Loader2 className="animate-spin" />}
        Sign up
      </Button>
    </div>
  );
}
