/**
 * Integration tests for every auth redirect, using a real MemoryRouter and the
 * real AuthProvider, ProtectedRoute, LoginPage, ResetPasswordPage, Header, and
 * AccountPage. Only Supabase (and the network) is mocked.
 */
import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Navigate, Route, Routes } from "react-router-dom";

// A stateful fake Supabase auth: sign-in/out actually flip the session and
// notify listeners, so the real AuthProvider reacts as it would in the browser.
const supa = vi.hoisted(() => {
  let session: unknown = null;
  let pendingRecovery = false;
  const listeners = new Set<(event: string, s: unknown) => void>();
  const emit = () => listeners.forEach((cb) => cb("event", session));
  const loggedInUser = {
    email: "me@example.com",
    is_anonymous: false,
    created_at: "2024-02-12T10:30:00.000Z",
  };
  return {
    reset() {
      session = null;
      pendingRecovery = false;
      listeners.clear();
    },
    loginExisting() {
      session = { user: loggedInUser };
    },
    loginDemo() {
      session = { user: { email: null, is_anonymous: true } };
    },
    /** Simulate arriving via a recovery link: session + a PASSWORD_RECOVERY event. */
    loginRecovery() {
      session = { user: loggedInUser };
      pendingRecovery = true;
    },
    auth: {
      getSession: async () => ({ data: { session } }),
      onAuthStateChange: (cb: (event: string, s: unknown) => void) => {
        listeners.add(cb);
        if (pendingRecovery) {
          pendingRecovery = false;
          queueMicrotask(() => cb("PASSWORD_RECOVERY", session));
        }
        return { data: { subscription: { unsubscribe: () => listeners.delete(cb) } } };
      },
      signInWithPassword: async ({ email }: { email: string }) => {
        session = { user: { ...loggedInUser, email } };
        emit();
        return { error: null };
      },
      signInAnonymously: async () => {
        session = { user: { email: null, is_anonymous: true } };
        emit();
        return { error: null };
      },
      signUp: async ({ email }: { email: string }) => {
        session = { user: { ...loggedInUser, email } };
        emit();
        return { error: null };
      },
      signOut: async () => {
        session = null;
        emit();
        return { error: null };
      },
      updateUser: async () => ({ error: null }),
      resetPasswordForEmail: async () => ({ error: null }),
    },
  };
});

vi.mock("@/lib/supabase", () => ({ supabase: { auth: supa.auth } }));

import { AuthProvider } from "@/context/AuthProvider";
import { ProtectedRoute } from "@/components/auth/ProtectedRoute";
import { LoginPage } from "@/components/auth/LoginPage";
import { ForgotPasswordPage } from "@/components/auth/ForgotPasswordPage";
import { ResetPasswordPage } from "@/components/auth/ResetPasswordPage";
import { Header } from "@/components/Header";
import { AccountPage } from "@/components/AccountPage";
import { clearSignupIntent } from "@/lib/authIntent";
import { consumeAuthFlash } from "@/lib/authFlash";

/**
 * Stand-in for the dashboard route; uses the real Header for menu/logout and
 * consumes the one-shot flash the way the real DashboardPage does.
 */
function DashboardStub() {
  const [flash, setFlash] = useState<string | null>(null);
  useEffect(() => {
    const message = consumeAuthFlash();
    if (message) setFlash(message);
  }, []);
  return (
    <div>
      <Header />
      <h1>Dashboard page</h1>
      {flash && <p>{flash}</p>}
    </div>
  );
}

function renderApp(initialEntry: string) {
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <DashboardStub />
              </ProtectedRoute>
            }
          />
          <Route
            path="/account"
            element={
              <ProtectedRoute>
                <AccountPage />
              </ProtectedRoute>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

const dashboard = () => screen.findByRole("heading", { name: "Dashboard page" });
const loginPage = () => screen.findByText("Log in to view your portfolio.");

function fillLogin(email = "me@example.com", password = "pw123456") {
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: email } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
}

async function logOutViaMenu() {
  fireEvent.keyDown(screen.getByRole("button", { name: /user menu/i }), {
    key: "Enter",
  });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Log out" }));
}

beforeEach(() => {
  supa.reset();
  clearSignupIntent();
  sessionStorage.clear();
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("auth redirects", () => {
  it("sends a signed-out user who opens /account to login, then to the dashboard after login", async () => {
    renderApp("/account");
    expect(await loginPage()).toBeInTheDocument();

    fillLogin();
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));

    expect(await dashboard()).toBeInTheDocument();
  });

  it("on /account: logging out then back in returns to the dashboard, not /account", async () => {
    supa.loginExisting();
    renderApp("/account");
    expect(await screen.findByText("Account settings")).toBeInTheDocument();

    await logOutViaMenu();
    expect(await loginPage()).toBeInTheDocument();

    fillLogin();
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));
    expect(await dashboard()).toBeInTheDocument();
  });

  it("sends a normal login to the dashboard", async () => {
    renderApp("/login");
    expect(await loginPage()).toBeInTheDocument();

    fillLogin();
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));

    expect(await dashboard()).toBeInTheDocument();
  });

  it("sends a sign-up to the dashboard", async () => {
    renderApp("/login");
    expect(await loginPage()).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Sign up" }));
    fillLogin("new@example.com", "pw123456");
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    expect(await dashboard()).toBeInTheDocument();
  });

  it("sends a demo start to the dashboard", async () => {
    renderApp("/login");
    expect(await loginPage()).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Try demo" }));

    expect(await dashboard()).toBeInTheDocument();
  });

  it("sends a completed password reset to the dashboard", async () => {
    supa.loginRecovery(); // recovery session established by the email link
    renderApp("/reset-password");
    // Wait for the reset page before acting.
    await screen.findByLabelText("New password");

    fireEvent.change(screen.getByLabelText("New password"), {
      target: { value: "newpass1" },
    });
    fireEvent.change(screen.getByLabelText("Confirm new password"), {
      target: { value: "newpass1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Update password" }));

    expect(await dashboard()).toBeInTheDocument();
    // One-shot confirmation flash is shown on the dashboard.
    expect(
      await screen.findByText("Your password has been updated."),
    ).toBeInTheDocument();
  });

  it("shows an error for an expired reset link and offers a new one", async () => {
    // No recovery session; Supabase left an error in the hash.
    renderApp("/reset-password#error=access_denied&error_code=otp_expired");

    expect(
      await screen.findByText("This reset link is invalid or has expired."),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Request a new link" }));
    expect(
      await screen.findByText("We'll email you a link to set a new password."),
    ).toBeInTheDocument();
  });

  it("never shows the reset form for an anonymous session on an expired link", async () => {
    supa.loginDemo(); // an anonymous "Try demo" session is active
    renderApp("/reset-password#error=access_denied&error_code=otp_expired");

    expect(
      await screen.findByText("This reset link is invalid or has expired."),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
  });

  it("sends a logged-in user who visits /login to the dashboard", async () => {
    supa.loginExisting();
    renderApp("/login");

    expect(await dashboard()).toBeInTheDocument();
  });

  it("sends a demo user who visits /account to the dashboard", async () => {
    supa.loginDemo();
    renderApp("/account");

    expect(await dashboard()).toBeInTheDocument();
  });

  it("sends an unknown URL to the dashboard for a logged-in user", async () => {
    supa.loginExisting();
    renderApp("/does-not-exist");

    expect(await dashboard()).toBeInTheDocument();
  });

  it("sends account deletion to login with a confirmation and no way back", async () => {
    supa.loginExisting();
    renderApp("/account");
    expect(await screen.findByText("Account settings")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.change(screen.getByLabelText(/type delete to confirm/i), {
      target: { value: "DELETE" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete account" }));

    expect(await loginPage()).toBeInTheDocument();
    // The confirmation flash appears once the login page's effect runs.
    expect(
      await screen.findByText("Your account has been deleted."),
    ).toBeInTheDocument();
  });
});
