import { useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";

import { FormField } from "@/components/auth/FormField";
import { PasswordInput } from "@/components/auth/PasswordInput";
import { PasswordRequirement } from "@/components/auth/PasswordRequirement";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/context/auth-context";
import { useFieldValidation } from "@/hooks/useFieldValidation";
import { authErrorMessage } from "@/lib/authErrors";
import { confirmPasswordError, newPasswordError } from "@/lib/validation";

interface ChangePasswordFormProps {
  /** Label for the submit button. */
  submitLabel: string;
  /** Called after a successful password update. */
  onSuccess: () => void;
}

/**
 * A new-password + confirm form that calls `updatePassword`, used by the
 * reset-password page (recovery session). On success it invokes `onSuccess`
 * (which sends the now-authenticated user to the dashboard).
 */
export function ChangePasswordForm({
  submitLabel,
  onSuccess,
}: ChangePasswordFormProps) {
  const { updatePassword } = useAuth();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fields = useFieldValidation(
    {
      password: () => newPasswordError(password),
      confirm: () => confirmPasswordError(password, confirm),
    },
    { live: { confirm: true } },
  );

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const invalid = fields.validateAll();
    if (invalid) {
      document.getElementById(invalid)?.focus();
      return;
    }
    setSubmitting(true);
    try {
      await updatePassword(password);
      onSuccess();
    } catch (err) {
      setError(authErrorMessage("update", err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
      {error && (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      )}

      <FormField
        id="password"
        label="New password"
        error={fields.errorFor("password", !!password)}
        hint={<PasswordRequirement password={password} />}
      >
        {(control) => (
          <PasswordInput
            {...control}
            name="new-password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onBlur={() => fields.blur("password")}
            disabled={submitting}
          />
        )}
      </FormField>

      <FormField
        id="confirm"
        label="Confirm new password"
        error={fields.errorFor("confirm", !!confirm)}
      >
        {(control) => (
          <PasswordInput
            {...control}
            name="confirm-password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            onBlur={() => fields.blur("confirm")}
            disabled={submitting}
          />
        )}
      </FormField>

      <Button type="submit" disabled={submitting} aria-busy={submitting}>
        {submitting && <Loader2 aria-hidden="true" className="animate-spin" />}
        {submitting ? "Updating…" : submitLabel}
      </Button>
    </form>
  );
}
