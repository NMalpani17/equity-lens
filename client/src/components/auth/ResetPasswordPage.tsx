import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Loader2 } from "lucide-react";

import { AuthCard } from "@/components/auth/AuthCard";
import { Button } from "@/components/ui/button";
import { ChangePasswordForm } from "./ChangePasswordForm";
import { useAuth } from "@/context/auth-context";
import { setAuthFlash } from "@/lib/authFlash";

/**
 * Set a new password. Reached from the reset email link, where Supabase fires a
 * PASSWORD_RECOVERY event and establishes a short-lived recovery session.
 *
 * The form is shown ONLY for a genuine recovery session — never for an anonymous
 * ("Try demo") user, nor for a regular logged-in user who opens this page
 * directly (they can change their password from Account settings), nor for an
 * expired/used link. Anything else shows an invalid-link message.
 */
export function ResetPasswordPage() {
  const { isPasswordRecovery, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    // Strip Supabase's token/error params from the address bar.
    if (location.hash) {
      navigate({ pathname: location.pathname, hash: "" }, { replace: true });
    }
  }, [location.hash, location.pathname, navigate]);

  function handleSuccess() {
    setAuthFlash("Your password has been updated.");
    navigate("/", { replace: true });
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-muted-foreground">
        <Loader2 aria-label="Loading" className="animate-spin" />
      </div>
    );
  }

  if (!isPasswordRecovery) {
    return (
      <AuthCard
        title="Reset link invalid"
        description="This reset link is invalid or has expired."
      >
        <Button onClick={() => navigate("/forgot-password")}>Request a new link</Button>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Set a new password"
      description="Choose a new password for your account."
    >
      <ChangePasswordForm submitLabel="Update password" onSuccess={handleSuccess} />
    </AuthCard>
  );
}
