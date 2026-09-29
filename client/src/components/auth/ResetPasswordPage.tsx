import { useNavigate } from "react-router-dom";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ChangePasswordForm } from "./ChangePasswordForm";
import { setAuthFlash } from "@/lib/authFlash";

/**
 * Set a new password. Reached from the reset email link, where Supabase
 * establishes a short-lived recovery session that authorizes the update. On
 * success the user is signed in, so we send them to the dashboard with a
 * one-shot confirmation flash.
 */
export function ResetPasswordPage() {
  const navigate = useNavigate();

  function handleSuccess() {
    setAuthFlash("Your password has been updated.");
    navigate("/", { replace: true });
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
