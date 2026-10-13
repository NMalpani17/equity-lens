import { useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";

import { FormField } from "@/components/auth/FormField";
import { PasswordInput } from "@/components/auth/PasswordInput";
import { PasswordRequirement } from "@/components/auth/PasswordRequirement";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/context/auth-context";
import { useFieldValidation } from "@/hooks/useFieldValidation";
import { SAME_PASSWORD, authErrorMessage } from "@/lib/authErrors";
import {
  confirmPasswordError,
  newPasswordError,
  requiredPasswordError,
} from "@/lib/validation";

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

  const fields = useFieldValidation(
    {
      "current-password": () => requiredPasswordError(currentPassword),
      "new-password": () =>
        newPasswordError(newPassword) ??
        (newPassword === currentPassword ? SAME_PASSWORD : null),
      "confirm-password": () => confirmPasswordError(newPassword, confirm),
    },
    { live: { "confirm-password": true } },
  );

  function resetFields() {
    setCurrentPassword("");
    setNewPassword("");
    setConfirm("");
    fields.reset();
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
    const invalid = fields.validateAll();
    if (invalid) {
      document.getElementById(invalid)?.focus();
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
      setError(authErrorMessage("update", err));
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
        id="current-password"
        label="Current password"
        error={fields.errorFor("current-password", !!currentPassword)}
      >
        {(control) => (
          <PasswordInput
            {...control}
            name="current-password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            onBlur={() => fields.blur("current-password")}
            disabled={submitting}
          />
        )}
      </FormField>
      <FormField
        id="new-password"
        label="New password"
        error={fields.errorFor("new-password", !!newPassword)}
        hint={<PasswordRequirement password={newPassword} />}
      >
        {(control) => (
          <PasswordInput
            {...control}
            name="new-password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            onBlur={() => fields.blur("new-password")}
            disabled={submitting}
          />
        )}
      </FormField>
      <FormField
        id="confirm-password"
        label="Confirm new password"
        error={fields.errorFor("confirm-password", !!confirm)}
      >
        {(control) => (
          <PasswordInput
            {...control}
            name="confirm-password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            onBlur={() => fields.blur("confirm-password")}
            disabled={submitting}
          />
        )}
      </FormField>

      <div className="flex gap-2">
        <Button type="submit" disabled={submitting} aria-busy={submitting}>
          {submitting && <Loader2 aria-hidden="true" className="animate-spin" />}
          {submitting ? "Updating…" : "Update password"}
        </Button>
        <Button type="button" variant="outline" onClick={cancel} disabled={submitting}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
