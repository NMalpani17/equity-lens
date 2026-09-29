import { useState, type FormEvent } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/context/auth-context";

type Mode = "login" | "signup";

/** Email + password auth with a shared demo shortcut. */
export function LoginPage() {
  const { user, loading, signIn, signUp, signInWithDemo } = useAuth();
  const location = useLocation();

  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [demoLoading, setDemoLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Where to send the user after auth: back to the page they came from, or the
  // dashboard. Redirect happens as soon as a session exists.
  const from = (location.state as { from?: string } | null)?.from ?? "/";
  if (!loading && user) {
    return <Navigate to={from} replace />;
  }

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
    setNotice(null);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);

    if (!email.trim() || !password) {
      setError("Email and password are required.");
      return;
    }

    setSubmitting(true);
    try {
      if (mode === "signup") {
        await signUp(email.trim(), password);
        // With email confirmation enabled, no session is created yet.
        setNotice(
          "Account created. If email confirmation is enabled, check your inbox to finish signing in.",
        );
      } else {
        await signIn(email.trim(), password);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDemo() {
    setError(null);
    setNotice(null);
    setDemoLoading(true);
    try {
      await signInWithDemo();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start the demo.");
    } finally {
      setDemoLoading(false);
    }
  }

  const busy = submitting || demoLoading;

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl">Equity Lens</CardTitle>
          <CardDescription>
            {mode === "login"
              ? "Log in to view your portfolio."
              : "Create an account to start tracking your holdings."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                disabled={busy}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                disabled={busy}
              />
            </div>

            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            {notice && (
              <p role="status" className="text-sm text-muted-foreground">
                {notice}
              </p>
            )}

            <Button type="submit" disabled={busy}>
              {submitting && <Loader2 className="animate-spin" />}
              {mode === "login" ? "Log in" : "Create account"}
            </Button>
          </form>

          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="h-px flex-1 bg-border" />
            or
            <span className="h-px flex-1 bg-border" />
          </div>

          <Button type="button" variant="outline" onClick={handleDemo} disabled={busy}>
            {demoLoading && <Loader2 className="animate-spin" />}
            Try demo
          </Button>

          <p className="text-center text-sm text-muted-foreground">
            {mode === "login" ? (
              <>
                Don&apos;t have an account?{" "}
                <button
                  type="button"
                  className="font-medium text-foreground underline underline-offset-4 disabled:opacity-50"
                  onClick={() => switchMode("signup")}
                  disabled={busy}
                >
                  Sign up
                </button>
              </>
            ) : (
              <>
                Already have an account?{" "}
                <button
                  type="button"
                  className="font-medium text-foreground underline underline-offset-4 disabled:opacity-50"
                  onClick={() => switchMode("login")}
                  disabled={busy}
                >
                  Log in
                </button>
              </>
            )}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
