import { useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useAuth } from "@/context/auth-context";
import { rememberSignupIntent } from "@/lib/authIntent";

/**
 * Banner shown to anonymous demo users, nudging them to create a real
 * account: a single slim "Demo mode · Sign up" line on phones, the full
 * message from md up. "Sign up" signs the throwaway demo user out (which routes to the
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
      className="flex items-center justify-center gap-1.5 whitespace-nowrap bg-amber-500/15 px-4 py-1 text-center text-xs text-amber-900 dark:text-amber-200 md:flex-wrap md:gap-x-3 md:gap-y-1 md:whitespace-normal md:py-2 md:text-sm"
    >
      {/* Phones: one slim line so the banner doesn't crowd the screen. */}
      <span className="md:hidden">Demo mode ·</span>
      <button
        type="button"
        onClick={() => void handleSignUp()}
        disabled={busy}
        className="inline-flex items-center gap-1 font-medium underline underline-offset-2 disabled:opacity-50 md:hidden"
      >
        {busy && <Loader2 className="size-3 animate-spin" />}
        Sign up
      </button>
      <span className="hidden md:inline">
        You&apos;re exploring a demo. Sign up to save your own portfolio.
      </span>
      <Button
        size="sm"
        onClick={() => void handleSignUp()}
        disabled={busy}
        className="hidden md:inline-flex"
      >
        {busy && <Loader2 className="animate-spin" />}
        Sign up
      </Button>
    </div>
  );
}
