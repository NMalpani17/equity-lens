/**
 * Auth provider: owns the Supabase session and exposes sign-in/up/out actions.
 * Subscribes to Supabase auth state so the UI reacts to token refreshes and
 * sign-out across tabs.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";

import { supabase } from "@/lib/supabase";
import { AuthContext, type AuthContextValue } from "./auth-context";

/** Normalize a Supabase auth error into a thrown Error the UI can display. */
function throwOnError(error: { message: string } | null): void {
  if (error) {
    throw new Error(error.message);
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  // Set only when the user arrives via a password-recovery link, so the reset
  // page can distinguish a genuine recovery from any other logged-in session.
  const [isPasswordRecovery, setIsPasswordRecovery] = useState(false);

  useEffect(() => {
    // Resolve the initial session, then keep it in sync with Supabase.
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, nextSession) => {
      setSession(nextSession);
      if (event === "PASSWORD_RECOVERY") {
        setIsPasswordRecovery(true);
      } else if (event === "SIGNED_OUT") {
        setIsPasswordRecovery(false);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      user: session?.user ?? null,
      loading,
      isDemo: session?.user?.is_anonymous ?? false,
      isPasswordRecovery,
      signUp: async (email, password) => {
        const { error } = await supabase.auth.signUp({ email, password });
        throwOnError(error);
      },
      signIn: async (email, password) => {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        throwOnError(error);
      },
      signInWithDemo: async () => {
        // Each visitor gets their own throwaway anonymous user; the API seeds it
        // with a sample portfolio on first load.
        const { error } = await supabase.auth.signInAnonymously();
        throwOnError(error);
      },
      sendPasswordReset: async (email) => {
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/reset-password`,
        });
        throwOnError(error);
      },
      updatePassword: async (newPassword) => {
        const { error } = await supabase.auth.updateUser({ password: newPassword });
        throwOnError(error);
      },
      signOut: async () => {
        const { error } = await supabase.auth.signOut();
        throwOnError(error);
        // No navigation here: sign-out UI lives on protected pages, so clearing
        // the session lets ProtectedRoute redirect to /login (replace, no state).
      },
    }),
    [session, loading, isPasswordRecovery],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
