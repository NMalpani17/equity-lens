import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { Loader2 } from "lucide-react";

import { useAuth } from "@/context/auth-context";

/**
 * Gate that renders its children only for authenticated users. While the session
 * is still resolving it shows a spinner; signed-out users are sent to the login
 * page (replace, so the Back button can't reopen a protected page). No return-to
 * is tracked — after logging in the user always lands on the dashboard.
 */
export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-muted-foreground">
        <Loader2 className="animate-spin" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}
