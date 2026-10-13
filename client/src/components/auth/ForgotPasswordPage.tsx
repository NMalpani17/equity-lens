import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Loader2, MailCheck } from "lucide-react";

import { AuthCard } from "@/components/auth/AuthCard";
import { FormField } from "@/components/auth/FormField";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/context/auth-context";
import { useFieldValidation } from "@/hooks/useFieldValidation";
import { authErrorMessage } from "@/lib/authErrors";
import { emailError } from "@/lib/validation";

/** Request a password-reset email. */
export function ForgotPasswordPage() {
  const { sendPasswordReset } = useAuth();
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const fields = useFieldValidation({ email: () => emailError(email) });

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (fields.validateAll()) {
      document.getElementById("email")?.focus();
      return;
    }
    setSubmitting(true);
    try {
      await sendPasswordReset(email.trim());
      setSent(true);
    } catch (err) {
      setError(authErrorMessage("reset", err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthCard
      title="Reset your password"
      description="We'll email you a link to set a new password."
    >
      {sent ? (
        <div role="status" className="flex flex-col items-center gap-4 text-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-info text-primary">
            <MailCheck aria-hidden="true" className="size-6" />
          </span>
          <p className="text-sm text-muted-foreground">
            If an account exists for{" "}
            <span className="font-medium text-foreground">{email.trim()}</span>, a reset
            link is on its way. Check your inbox.
          </p>
        </div>
      ) : (
        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
          {error && (
            <p
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </p>
          )}

          <FormField id="email" label="Email" error={fields.errorFor("email", !!email)}>
            {(control) => (
              <Input
                {...control}
                name="email"
                type="email"
                inputMode="email"
                autoComplete="email"
                autoCapitalize="none"
                spellCheck={false}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onBlur={() => fields.blur("email")}
                placeholder="you@example.com"
                disabled={submitting}
              />
            )}
          </FormField>

          <Button type="submit" disabled={submitting} aria-busy={submitting}>
            {submitting && <Loader2 aria-hidden="true" className="animate-spin" />}
            {submitting ? "Sending…" : "Send reset link"}
          </Button>
        </form>
      )}

      <Link
        to="/login"
        className="self-center rounded-sm text-sm font-medium underline underline-offset-4 hover:text-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Back to log in
      </Link>
    </AuthCard>
  );
}
