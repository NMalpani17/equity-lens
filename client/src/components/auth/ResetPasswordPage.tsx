import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
        <Loader2 className="animate-spin" />
      </div>
    );
  }

  if (!isPasswordRecovery) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle className="text-2xl">Reset link invalid</CardTitle>
            <CardDescription>
              This reset link is invalid or has expired.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button className="w-full" onClick={() => navigate("/forgot-password")}>
              Request a new link
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl">Set a new password</CardTitle>
          <CardDescription>Choose a new password for your account.</CardDescription>
        </CardHeader>
        <CardContent>
          <ChangePasswordForm submitLabel="Update password" onSuccess={handleSuccess} />
        </CardContent>
      </Card>
    </div>
  );
}
