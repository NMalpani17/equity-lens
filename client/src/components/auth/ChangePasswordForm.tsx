import { useState, type FormEvent, type ReactNode } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/context/auth-context";

/** Minimum password length enforced by Supabase's default policy. */
const MIN_PASSWORD_LENGTH = 6;

interface ChangePasswordFormProps {
  /** Label for the submit button. */
  submitLabel: string;
  /** Rendered in place of the form after a successful update. */
  renderSuccess: () => ReactNode;
}

/**
 * A new-password + confirm form that calls `updatePassword`. Shared by the
 * reset-password page (recovery session) and the account settings page
 * (logged-in session), which differ only in what they show on success.
 */
export function ChangePasswordForm({
  submitLabel,
  renderSuccess,
}: ChangePasswordFormProps) {
  const { updatePassword } = useAuth();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setSubmitting(true);
    try {
      await updatePassword(password);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't update the password.");
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return <>{renderSuccess()}</>;
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="password">New password</Label>
        <Input
          id="password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
          disabled={submitting}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="confirm">Confirm new password</Label>
        <Input
          id="confirm"
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

      <Button type="submit" disabled={submitting}>
        {submitting && <Loader2 className="animate-spin" />}
        {submitLabel}
      </Button>
    </form>
  );
}
