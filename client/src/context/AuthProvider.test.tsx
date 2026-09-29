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
  signUp: vi.fn(),
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
      <span data-testid="err">err:{err}</span>
      <button onClick={() => run(() => auth.signIn("a@b.com", "pw123456"))}>
        signin
      </button>
      <button onClick={() => run(() => auth.signInWithDemo())}>demo</button>
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
  authApi.signUp.mockResolvedValue({ error: null });
  authApi.signOut.mockResolvedValue({ error: null });
});

describe("AuthProvider", () => {
  it("resolves the initial session and clears loading", async () => {
    renderProvider();

    await waitFor(() =>
      expect(screen.getByTestId("loading")).toHaveTextContent("loading:false"),
    );
    expect(screen.getByTestId("user")).toHaveTextContent("user:none");
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

  it("signs into the demo account using the configured env credentials", async () => {
    renderProvider();
    fireClick("demo");

    await waitFor(() =>
      expect(authApi.signInWithPassword).toHaveBeenCalledWith({
        email: "demo@equitylens.app",
        password: "demo-password",
      }),
    );
  });

  it("signs out", async () => {
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

  it("reflects Supabase auth state changes", async () => {
    renderProvider();
    await waitFor(() =>
      expect(screen.getByTestId("loading")).toHaveTextContent("loading:false"),
    );

    // Invoke the callback Supabase would call on sign-in.
    const onChange = authApi.onAuthStateChange.mock.calls[0]![0] as (
      event: string,
      session: unknown,
    ) => void;
    act(() => onChange("SIGNED_IN", { user: { email: "x@y.com" } }));

    expect(screen.getByTestId("user")).toHaveTextContent("user:x@y.com");
  });
});

function fireClick(label: string) {
  screen.getByText(label).click();
}
