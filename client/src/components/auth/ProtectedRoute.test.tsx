import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

vi.mock("@/context/auth-context", () => ({ useAuth: vi.fn() }));

import { useAuth } from "@/context/auth-context";
import { ProtectedRoute } from "./ProtectedRoute";

const useAuthMock = vi.mocked(useAuth);

function renderRoutes() {
  render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <div>Protected content</div>
            </ProtectedRoute>
          }
        />
        <Route path="/login" element={<div>Login screen</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function mockAuth(overrides: Partial<ReturnType<typeof useAuth>>) {
  useAuthMock.mockReturnValue({
    session: null,
    user: null,
    loading: false,
    isDemo: false,
    signIn: vi.fn(),
    signUp: vi.fn(),
    signInWithDemo: vi.fn(),
    sendPasswordReset: vi.fn(),
    updatePassword: vi.fn(),
    signOut: vi.fn(),
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ProtectedRoute", () => {
  it("renders nothing but a spinner while the session is loading", () => {
    mockAuth({ loading: true });
    renderRoutes();

    expect(screen.queryByText("Protected content")).not.toBeInTheDocument();
    expect(screen.queryByText("Login screen")).not.toBeInTheDocument();
  });

  it("redirects to /login when signed out", () => {
    mockAuth({ loading: false, user: null });
    renderRoutes();

    expect(screen.getByText("Login screen")).toBeInTheDocument();
    expect(screen.queryByText("Protected content")).not.toBeInTheDocument();
  });

  it("renders children when authenticated", () => {
    mockAuth({ loading: false, user: { email: "me@example.com" } as never });
    renderRoutes();

    expect(screen.getByText("Protected content")).toBeInTheDocument();
  });
});
