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

const useAuthMock = vi.mocked(useAuth);

function mockAuth(isDemo: boolean) {
  useAuthMock.mockReturnValue({
    session: null,
    user: { email: "me@example.com" } as never,
    loading: false,
    isDemo,
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
});

describe("DashboardPage", () => {
  it("shows the demo banner for anonymous demo users", () => {
    mockAuth(true);
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );

    expect(screen.getByText(/You're exploring a demo/)).toBeInTheDocument();
  });

  it("hides the demo banner for regular users", () => {
    mockAuth(false);
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );

    expect(screen.queryByText(/You're exploring a demo/)).not.toBeInTheDocument();
    expect(screen.getByText("dashboard-body")).toBeInTheDocument();
  });
});
