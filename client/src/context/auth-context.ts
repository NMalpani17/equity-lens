/** Auth context definition and the `useAuth` hook. */
import { createContext, useContext } from "react";
import type { Session, User } from "@supabase/supabase-js";

export interface AuthContextValue {
  /** The current Supabase session, or null when signed out. */
  session: Session | null;
  /** The signed-in user, or null when signed out. */
  user: User | null;
  /** True until the initial session has been resolved. */
  loading: boolean;
  /** True when the current user is an anonymous ("Try demo") visitor. */
  isDemo: boolean;
  /** Create an account with email + password. Throws on failure. */
  signUp: (email: string, password: string) => Promise<void>;
  /** Sign in with email + password. Throws on failure. */
  signIn: (email: string, password: string) => Promise<void>;
  /** Start an anonymous demo session (a fresh temporary user). */
  signInWithDemo: () => Promise<void>;
  /** Sign out the current user. */
  signOut: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

/** Access the auth context. Must be used within an `AuthProvider`. */
export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return value;
}
