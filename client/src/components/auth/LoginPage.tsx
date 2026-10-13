import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { Loader2, MailCheck } from "lucide-react";

import { AuthCard } from "@/components/auth/AuthCard";
import { FormField } from "@/components/auth/FormField";
import { GoogleIcon } from "@/components/auth/GoogleIcon";
import { PasswordInput } from "@/components/auth/PasswordInput";
import { PasswordRequirement } from "@/components/auth/PasswordRequirement";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/context/auth-context";
import { useFieldValidation } from "@/hooks/useFieldValidation";
import { authErrorMessage } from "@/lib/authErrors";
import { consumeAuthFlash } from "@/lib/authFlash";
import { clearSignupIntent, hasSignupIntent } from "@/lib/authIntent";
import { cn } from "@/lib/utils";
import {
  confirmPasswordError,
  emailError,
  newPasswordError,
  requiredPasswordError,
} from "@/lib/validation";

type Mode = "login" | "signup";

const COPY: Record<
  Mode,
  { title: string; description: string; submit: string; busy: string }
> = {
  login: {
    title: "Welcome back",
    description: "Log in to view your portfolio.",
    submit: "Log in",
    busy: "Logging in…",
  },
  signup: {
    title: "Create your account",
    description: "Create an account to start tracking your holdings.",
    submit: "Create account",
    busy: "Creating account…",
  },
};

/** True when Supabase sent the user back here with an error (query or hash). */
function hasRedirectError(search: string, hash: string): boolean {
  return (
    new URLSearchParams(search).has("error") ||
    new URLSearchParams(hash.replace(/^#/, "")).has("error")
  );
}

/**
 * Email + password auth (log in or sign up), Google sign-in, and an anonymous
 * demo shortcut.
 */
export function LoginPage() {
  const { user, loading, signIn, signUp, signInWithGoogle, signInWithDemo } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  // Open in sign-up mode when arriving via the demo banner's "Sign up".
  const [mode, setMode] = useState<Mode>(() =>
    hasSignupIntent() ? "signup" : "login",
  );

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [demoLoading, setDemoLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The address a confirmation email was sent to (email confirmation on).
  const [confirmationSentTo, setConfirmationSentTo] = useState<string | null>(null);

  const signingUp = mode === "signup";
  const fields = useFieldValidation(
    {
      email: () => emailError(email),
      password: () =>
        signingUp ? newPasswordError(password) : requiredPasswordError(password),
      confirm: () => (signingUp ? confirmPasswordError(password, confirm) : null),
    },
    { live: { confirm: true } },
  );

  useEffect(() => {
    // Sign-up intent is one-shot: clear it so a later manual visit opens login.
    clearSignupIntent();
    // Show any handoff message (e.g. after account deletion) exactly once.
    const flash = consumeAuthFlash();
    if (flash) {
      setNotice(flash);
    }
  }, []);

  useEffect(() => {
    // A Google sign-in or email link that failed comes back with ?error= or
    // #error=. Say so generically and clear it from the address bar.
    if (hasRedirectError(location.search, location.hash)) {
      setError(authErrorMessage("redirect", null));
      navigate(
        { pathname: location.pathname, search: "", hash: "" },
        { replace: true },
      );
    }
  }, [location.search, location.hash, location.pathname, navigate]);

  // After any successful auth (login, sign-up, demo) the user always lands on the
  // dashboard. A logged-in user who visits /login is sent there too.
  if (!loading && user) {
    return <Navigate to="/" replace />;
  }

  function switchMode(next: Mode) {
    if (next === mode) return;
    setMode(next);
    setConfirm("");
    setError(null);
    setNotice(null);
    fields.reset();
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);

    const invalid = fields.validateAll();
    if (invalid) {
      document.getElementById(invalid)?.focus();
      return;
    }

    setSubmitting(true);
    try {
      if (signingUp) {
        const { needsConfirmation } = await signUp(email.trim(), password);
        if (needsConfirmation) {
          setConfirmationSentTo(email.trim());
        }
      } else {
        await signIn(email.trim(), password);
      }
    } catch (err) {
      setError(authErrorMessage(signingUp ? "signup" : "login", err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleGoogle() {
    setError(null);
    setNotice(null);
    setGoogleLoading(true);
    try {
      // Navigates to Google on success; the page stays busy until it does.
      await signInWithGoogle();
    } catch (err) {
      setError(authErrorMessage("redirect", err));
      setGoogleLoading(false);
    }
  }

  async function handleDemo() {
    setError(null);
    setNotice(null);
    setDemoLoading(true);
    try {
      await signInWithDemo();
    } catch {
      setError("We couldn't start the demo. Try again in a moment.");
    } finally {
      setDemoLoading(false);
    }
  }

  if (confirmationSentTo) {
    return (
      <CheckEmail
        email={confirmationSentTo}
        onBack={() => {
          setConfirmationSentTo(null);
          setPassword("");
          switchMode("login");
        }}
      />
    );
  }

  const busy = submitting || demoLoading || googleLoading;
  const copy = COPY[mode];

  return (
    <AuthCard
      title={copy.title}
      description={copy.description}
      top={<ModeSwitch mode={mode} onChange={switchMode} disabled={busy} />}
    >
      {notice && (
        <p
          role="status"
          className="rounded-md bg-info px-3 py-2 text-sm text-info-foreground"
        >
          {notice}
        </p>
      )}

      <form
        id="auth-panel"
        role="tabpanel"
        aria-labelledby={`tab-${mode}`}
        onSubmit={handleSubmit}
        noValidate
        className="flex flex-col gap-4"
      >
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
              disabled={busy}
            />
          )}
        </FormField>

        <FormField
          id="password"
          label="Password"
          error={fields.errorFor("password", !!password)}
          hint={signingUp ? <PasswordRequirement password={password} /> : undefined}
          footer={
            !signingUp && (
              <Link
                to="/forgot-password"
                className="self-end rounded-sm text-sm font-medium underline underline-offset-4 hover:text-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Forgot password?
              </Link>
            )
          }
        >
          {(control) => (
            <PasswordInput
              {...control}
              name="password"
              autoComplete={signingUp ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onBlur={() => fields.blur("password")}
              disabled={busy}
            />
          )}
        </FormField>

        {signingUp && (
          <FormField
            id="confirm"
            label="Confirm password"
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
                disabled={busy}
              />
            )}
          </FormField>
        )}

        <Button type="submit" disabled={busy} aria-busy={submitting} className="mt-1">
          {submitting && <Loader2 aria-hidden="true" className="animate-spin" />}
          {submitting ? copy.busy : copy.submit}
        </Button>
      </form>

      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        or
        <span className="h-px flex-1 bg-border" />
      </div>

      <div className="flex flex-col gap-3">
        <Button
          type="button"
          variant="outline"
          onClick={handleGoogle}
          disabled={busy}
          aria-busy={googleLoading}
        >
          {googleLoading ? (
            <Loader2 aria-hidden="true" className="animate-spin" />
          ) : (
            <GoogleIcon />
          )}
          Continue with Google
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={handleDemo}
          disabled={busy}
          aria-busy={demoLoading}
        >
          {demoLoading && <Loader2 aria-hidden="true" className="animate-spin" />}
          Try demo
        </Button>
      </div>
    </AuthCard>
  );
}

const MODES: { value: Mode; label: string }[] = [
  { value: "login", label: "Log in" },
  { value: "signup", label: "Sign up" },
];

/** The log in / sign up switch: a two-tab control (arrow keys move between). */
function ModeSwitch({
  mode,
  onChange,
  disabled,
}: {
  mode: Mode;
  onChange: (mode: Mode) => void;
  disabled: boolean;
}) {
  const tabs = useRef<Record<Mode, HTMLButtonElement | null>>({
    login: null,
    signup: null,
  });

  function handleKeyDown(event: KeyboardEvent) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next: Mode = mode === "login" ? "signup" : "login";
    onChange(next);
    tabs.current[next]?.focus();
  }

  return (
    <div
      role="tablist"
      aria-label="Log in or sign up"
      onKeyDown={handleKeyDown}
      className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1"
    >
      {MODES.map(({ value, label }) => {
        const selected = value === mode;
        return (
          <button
            key={value}
            ref={(el) => {
              tabs.current[value] = el;
            }}
            id={`tab-${value}`}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls="auth-panel"
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(value)}
            disabled={disabled}
            className={cn(
              "h-9 rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
              selected
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

/** Shown after sign-up when Supabase requires email confirmation. */
function CheckEmail({ email, onBack }: { email: string; onBack: () => void }) {
  return (
    <AuthCard title="Check your email">
      <div role="status" className="flex flex-col items-center gap-4 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-info text-primary">
          <MailCheck aria-hidden="true" className="size-6" />
        </span>
        <p className="text-sm text-muted-foreground">
          We sent a confirmation link to{" "}
          <span className="font-medium text-foreground">{email}</span>. Open it to
          finish creating your account.
        </p>
        <p className="text-xs text-muted-foreground">
          Can&apos;t find it? Check your spam folder, or sign up again in a few minutes.
        </p>
      </div>
      <Button type="button" variant="outline" onClick={onBack}>
        Back to log in
      </Button>
    </AuthCard>
  );
}
