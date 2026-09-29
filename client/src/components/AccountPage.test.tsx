import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

vi.mock("@/context/auth-context", () => ({ useAuth: vi.fn() }));

import { useAuth } from "@/context/auth-context";
import { AccountPage } from "./AccountPage";

const useAuthMock = vi.mocked(useAuth);

function mockAuth(overrides: Partial<ReturnType<typeof useAuth>>) {
  useAuthMock.mockReturnValue({
    session: null,
    user: { email: "me@example.com" } as never,
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

function renderAt() {
  render(
    <MemoryRouter initialEntries={["/account"]}>
      <Routes>
        <Route path="/account" element={<AccountPage />} />
        <Route path="/" element={<div>dashboard-home</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AccountPage", () => {
  it("shows the change-password form for a regular user", () => {
    mockAuth({ isDemo: false });
    renderAt();

    expect(screen.getByText("Account settings")).toBeInTheDocument();
    expect(screen.getByText("Change password")).toBeInTheDocument();
    expect(screen.getByText(/Signed in as me@example.com/)).toBeInTheDocument();
  });

  it("redirects demo users away", () => {
    mockAuth({ isDemo: true });
    renderAt();

    expect(screen.getByText("dashboard-home")).toBeInTheDocument();
    expect(screen.queryByText("Change password")).not.toBeInTheDocument();
  });
});
