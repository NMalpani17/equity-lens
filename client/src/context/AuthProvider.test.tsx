import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";

// Mock the Supabase client so the provider's actions can be asserted without
// any network or real auth. `vi.hoisted` lets the mock factory (hoisted to the
// top of the file) reference these spies safely.
const authApi = vi.hoisted(() => ({
  getSession: vi.fn(),
  onAuthStateChange: vi.fn(),
  signInWithPassword: vi.fn(),
  signInAnonymously: vi.fn(),
  signUp: vi.fn(),
  resetPasswordForEmail: vi.fn(),
  updateUser: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("@/lib/supabase", () => ({ supabase: { auth: authApi } }));

import { AuthProvider } from "./AuthProvider";
import { useAuth } from "./auth-context";

/** A small consumer that surfaces auth state and drives the provider actions. */
function Consumer() {
  const auth = useAuth();
  const [err, setErr] = useState("");

  async function run(fn: () => Promise<void>) {
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <div>
      <span data-testid="loading">loading:{String(auth.loading)}</span>
      <span data-testid="user">user:{auth.user?.email ?? "none"}</span>
      <span data-testid="demo">demo:{String(auth.isDemo)}</span>
      <span data-testid="recovery">recovery:{String(auth.isPasswordRecovery)}</span>
      <span data-testid="err">err:{err}</span>
      <button onClick={() => run(() => auth.signIn("a@b.com", "pw123456"))}>
        signin
      </button>
      <button onClick={() => run(() => auth.signInWithDemo())}>demo</button>
      <button onClick={() => run(() => auth.sendPasswordReset("a@b.com"))}>
        reset
      </button>
      <button onClick={() => run(() => auth.updatePassword("newpass123"))}>
        update
      </button>
      <button onClick={() => run(() => auth.signOut())}>signout</button>
    </div>
  );
}

function renderProvider() {
  render(
    <AuthProvider>
      <Consumer />
    </AuthProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  authApi.getSession.mockResolvedValue({ data: { session: null } });
  authApi.onAuthStateChange.mockReturnValue({
    data: { subscription: { unsubscribe: vi.fn() } },
  });
  authApi.signInWithPassword.mockResolvedValue({ error: null });
  authApi.signInAnonymously.mockResolvedValue({ error: null });
  authApi.signUp.mockResolvedValue({ error: null });
  authApi.resetPasswordForEmail.mockResolvedValue({ error: null });
  authApi.updateUser.mockResolvedValue({ error: null });
  authApi.signOut.mockResolvedValue({ error: null });
});

describe("AuthProvider", () => {
  it("resolves the initial session and clears loading", async () => {
    renderProvider();

    await waitFor(() =>
      expect(screen.getByTestId("loading")).toHaveTextContent("loading:false"),
    );
    expect(screen.getByTestId("user")).toHaveTextContent("user:none");
    expect(screen.getByTestId("demo")).toHaveTextContent("demo:false");
  });

  it("signs in with email and password", async () => {
    renderProvider();
    fireClick("signin");

    await waitFor(() =>
      expect(authApi.signInWithPassword).toHaveBeenCalledWith({
        email: "a@b.com",
        password: "pw123456",
      }),
    );
  });

  it("starts an anonymous demo session", async () => {
    renderProvider();
    fireClick("demo");

    await waitFor(() => expect(authApi.signInAnonymously).toHaveBeenCalledOnce());
    // The demo path never uses password sign-in.
    expect(authApi.signInWithPassword).not.toHaveBeenCalled();
  });

  it("sends a password-reset email pointing at the reset page", async () => {
    renderProvider();
    fireClick("reset");

    await waitFor(() =>
      expect(authApi.resetPasswordForEmail).toHaveBeenCalledWith(
        "a@b.com",
        expect.objectContaining({
          redirectTo: expect.stringContaining("/reset-password"),
        }),
      ),
    );
  });

  it("updates the current user's password", async () => {
    renderProvider();
    fireClick("update");

    await waitFor(() =>
      expect(authApi.updateUser).toHaveBeenCalledWith({ password: "newpass123" }),
    );
  });

  it("signs out and clears the session (redirect is handled by ProtectedRoute)", async () => {
    renderProvider();
    fireClick("signout");

    await waitFor(() => expect(authApi.signOut).toHaveBeenCalledOnce());
  });

  it("propagates auth errors to the caller", async () => {
    authApi.signInWithPassword.mockResolvedValue({
      error: { message: "Invalid login credentials" },
    });
    renderProvider();
    fireClick("signin");

    await waitFor(() =>
      expect(screen.getByTestId("err")).toHaveTextContent(
        "err:Invalid login credentials",
      ),
    );
  });

  it("reflects Supabase auth state changes, including anonymous users", async () => {
    renderProvider();
    await waitFor(() =>
      expect(screen.getByTestId("loading")).toHaveTextContent("loading:false"),
    );

    // Invoke the callback Supabase would call on anonymous sign-in.
    const onChange = authApi.onAuthStateChange.mock.calls[0]![0] as (
      event: string,
      session: unknown,
    ) => void;
    act(() => onChange("SIGNED_IN", { user: { email: null, is_anonymous: true } }));

    expect(screen.getByTestId("demo")).toHaveTextContent("demo:true");
    // A plain sign-in is not a password recovery.
    expect(screen.getByTestId("recovery")).toHaveTextContent("recovery:false");
  });

  it("flags a password-recovery session only on the PASSWORD_RECOVERY event", async () => {
    renderProvider();
    await waitFor(() =>
      expect(screen.getByTestId("loading")).toHaveTextContent("loading:false"),
    );

    const onChange = authApi.onAuthStateChange.mock.calls[0]![0] as (
      event: string,
      session: unknown,
    ) => void;

    act(() => onChange("PASSWORD_RECOVERY", { user: { email: "me@example.com" } }));
    expect(screen.getByTestId("recovery")).toHaveTextContent("recovery:true");

    // Signing out clears the recovery flag.
    act(() => onChange("SIGNED_OUT", null));
    expect(screen.getByTestId("recovery")).toHaveTextContent("recovery:false");
  });
});

function fireClick(label: string) {
  screen.getByText(label).click();
}
