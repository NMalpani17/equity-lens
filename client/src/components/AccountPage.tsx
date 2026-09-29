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
import { formatTimestampDate } from "@/lib/format";

/** Account settings: profile, password, and account deletion. Hidden for demo. */
export function AccountPage() {
  const { user, isDemo } = useAuth();

  // Demo (anonymous) users have no account to manage.
  if (isDemo) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-6">
        <h1 className="text-2xl font-bold tracking-tight">Account settings</h1>

        <Card>
          <CardHeader>
            <CardTitle>Profile</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Email</span>
              <span className="font-medium">{user?.email ?? "—"}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Member since</span>
              <span className="font-medium">
                {formatTimestampDate(user?.created_at)}
              </span>
            </div>
          </CardContent>
        </Card>

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
