import { useState } from "react";

import { useAuth } from "@/context/auth-context";
import { rememberSignupIntent } from "@/lib/authIntent";

/**
 * Leave the demo for a real account: signs the throwaway demo user out (which
 * routes to the login page) after flagging it to open in sign-up mode.
 */
export function useDemoSignUp(): { signUp: () => Promise<void>; busy: boolean } {
  const { signOut } = useAuth();
  const [busy, setBusy] = useState(false);

  async function signUp() {
    setBusy(true);
    try {
      rememberSignupIntent();
      await signOut();
    } finally {
      setBusy(false);
    }
  }

  return { signUp, busy };
}
