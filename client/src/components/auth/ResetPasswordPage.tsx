import { useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/button";
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
 * establishes a short-lived recovery session that authorizes the update.
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
            renderSuccess={() => (
              <div className="flex flex-col gap-4">
                <p role="status" className="text-sm text-muted-foreground">
                  Your password has been updated.
                </p>
                <Button onClick={() => navigate("/")}>Go to dashboard</Button>
              </div>
            )}
          />
        </CardContent>
      </Card>
    </div>
  );
}
