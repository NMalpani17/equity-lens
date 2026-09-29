import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Stub the data-fetching children so the page renders without network calls.
vi.mock("@/components/portfolio/Dashboard", () => ({
  Dashboard: () => <div>dashboard-body</div>,
}));
vi.mock("@/components/HealthStatus", () => ({
  HealthStatus: () => <div>health-body</div>,
}));
vi.mock("@/context/auth-context", () => ({ useAuth: vi.fn() }));

import { useAuth } from "@/context/auth-context";
import { DashboardPage } from "./DashboardPage";
import { consumeAuthFlash, setAuthFlash } from "@/lib/authFlash";

const useAuthMock = vi.mocked(useAuth);

function renderPage() {
  render(
    <MemoryRouter>
      <DashboardPage />
    </MemoryRouter>,
  );
}

function mockAuth(isDemo: boolean) {
  useAuthMock.mockReturnValue({
    session: null,
    user: { email: "me@example.com" } as never,
    loading: false,
    isDemo,
    isPasswordRecovery: false,
    signIn: vi.fn(),
    signUp: vi.fn(),
    signInWithDemo: vi.fn(),
    sendPasswordReset: vi.fn(),
    updatePassword: vi.fn(),
    signOut: vi.fn(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
});

describe("DashboardPage", () => {
  it("shows the demo banner for anonymous demo users", () => {
    mockAuth(true);
    renderPage();

    expect(screen.getByText(/You're exploring a demo/)).toBeInTheDocument();
  });

  it("hides the demo banner for regular users", () => {
    mockAuth(false);
    renderPage();

    expect(screen.queryByText(/You're exploring a demo/)).not.toBeInTheDocument();
    expect(screen.getByText("dashboard-body")).toBeInTheDocument();
  });

  it("shows a one-shot flash message (e.g. after a password reset) and consumes it", () => {
    mockAuth(false);
    setAuthFlash("Your password has been updated.");
    renderPage();

    expect(screen.getByText("Your password has been updated.")).toBeInTheDocument();
    // The flash is one-shot: it's cleared from storage after being shown.
    expect(consumeAuthFlash()).toBeNull();
  });

  it("shows no flash message when none is set", () => {
    mockAuth(false);
    renderPage();

    expect(
      screen.queryByText("Your password has been updated."),
    ).not.toBeInTheDocument();
  });
});
