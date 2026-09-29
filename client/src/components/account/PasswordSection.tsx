import { useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/context/auth-context";

/** Minimum password length enforced by Supabase's default policy. */
const MIN_PASSWORD_LENGTH = 6;

/** Map Supabase's "same password" error to a friendly, actionable message. */
function friendlyUpdateError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/different from the old password|same[_ ]password/i.test(message)) {
    return "New password must be different from your current password.";
  }
  return message || "Couldn't update the password.";
}

/**
 * Collapsed password control for the account page. Shows a "Password" row with a
 * "Change password" button; expanding it reveals a form that verifies the
 * current password (via re-sign-in) before setting a new one.
 */
export function PasswordSection() {
  const { user, signIn, updatePassword } = useAuth();

  const [editing, setEditing] = useState(false);
  const [updated, setUpdated] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function resetFields() {
    setCurrentPassword("");
    setNewPassword("");
    setConfirm("");
  }

  function open() {
    setEditing(true);
    setUpdated(false);
    setError(null);
  }

  function cancel() {
    setEditing(false);
    setError(null);
    resetFields();
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    const email = user?.email;
    if (!email) {
      setError("You must be signed in to change your password.");
      return;
    }
    if (!currentPassword || !newPassword || !confirm) {
      setError("All fields are required.");
      return;
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (newPassword !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    if (newPassword === currentPassword) {
      setError("New password must be different from your current password.");
      return;
    }

    setSubmitting(true);

    // Verify the current password by re-authenticating before changing it.
    try {
      await signIn(email, currentPassword);
    } catch {
      setError("Current password is incorrect.");
      setSubmitting(false);
      return;
    }

    try {
      await updatePassword(newPassword);
      resetFields();
      setEditing(false);
      setUpdated(true);
    } catch (err) {
      setError(friendlyUpdateError(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (!editing) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium">Password</p>
            <p className="text-sm text-muted-foreground">••••••••</p>
          </div>
          <Button variant="outline" onClick={open}>
            Change password
          </Button>
        </div>
        {updated && (
          <p role="status" className="text-sm text-muted-foreground">
            Your password has been updated.
          </p>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="current-password">Current password</Label>
        <Input
          id="current-password"
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          placeholder="••••••••"
          disabled={submitting}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="new-password">New password</Label>
        <Input
          id="new-password"
          type="password"
          autoComplete="new-password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          placeholder="••••••••"
          disabled={submitting}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="confirm-password">Confirm new password</Label>
        <Input
          id="confirm-password"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="••••••••"
          disabled={submitting}
        />
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <Button type="submit" disabled={submitting}>
          {submitting && <Loader2 className="animate-spin" />}
          Update password
        </Button>
        <Button type="button" variant="outline" onClick={cancel} disabled={submitting}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
