import { Link, Navigate } from "react-router-dom";

import { Header } from "@/components/Header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ChangePasswordForm } from "@/components/auth/ChangePasswordForm";
import { useAuth } from "@/context/auth-context";

/** Account settings: change the logged-in user's password. Hidden for demo. */
export function AccountPage() {
  const { user, isDemo } = useAuth();

  // Demo (anonymous) users have no password to manage.
  if (isDemo) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Account settings</h1>
          {user?.email && (
            <p className="text-sm text-muted-foreground">Signed in as {user.email}</p>
          )}
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Change password</CardTitle>
            <CardDescription>Set a new password for your account.</CardDescription>
          </CardHeader>
          <CardContent>
            <ChangePasswordForm
              submitLabel="Update password"
              renderSuccess={() => (
                <p role="status" className="text-sm text-muted-foreground">
                  Your password has been updated.
                </p>
              )}
            />
          </CardContent>
        </Card>

        <Link
          to="/"
          className="text-sm text-muted-foreground underline underline-offset-4"
        >
          Back to dashboard
        </Link>
      </main>
    </div>
  );
}
