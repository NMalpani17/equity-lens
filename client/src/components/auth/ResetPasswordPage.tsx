import { useNavigate } from "react-router-dom";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ChangePasswordForm } from "./ChangePasswordForm";

/**
 * Set a new password. Reached from the reset email link, where Supabase
 * establishes a short-lived recovery session that authorizes the update. On
 * success the user is signed in, so we send them to the dashboard.
 */
export function ResetPasswordPage() {
  const navigate = useNavigate();

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl">Set a new password</CardTitle>
          <CardDescription>Choose a new password for your account.</CardDescription>
        </CardHeader>
        <CardContent>
          <ChangePasswordForm
            submitLabel="Update password"
            onSuccess={() => navigate("/", { replace: true })}
          />
        </CardContent>
      </Card>
    </div>
  );
}
