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
import { hashHasAuthError } from "@/lib/authHash";

/**
 * Set a new password. Reached from the reset email link, where Supabase
 * establishes a short-lived recovery session that authorizes the update.
 *
 * An expired or already-used link has no recovery session and arrives with an
 * error in the URL hash; in that case (or with no session at all) we show a
 * clear message and a way to request a new link instead of a broken form.
 */
export function ResetPasswordPage() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const linkError = hashHasAuthError(location.hash);

  useEffect(() => {
    // Strip Supabase's error/token params from the address bar.
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

  // Expired/used link (error in the hash) or no recovery session at all.
  if (linkError || !user) {
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
