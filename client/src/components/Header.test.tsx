import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("@/context/auth-context", () => ({ useAuth: vi.fn() }));

import { useAuth } from "@/context/auth-context";
import { Header } from "./Header";

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

function renderHeader() {
  render(
    <MemoryRouter>
      <Header />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Header", () => {
  it("shows the account link and email for a regular user", () => {
    mockAuth({ isDemo: false });
    renderHeader();

    expect(screen.getByRole("link", { name: "Account" })).toBeInTheDocument();
    expect(screen.getByText("me@example.com")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Log out" })).toBeInTheDocument();
  });

  it("hides the account link for demo users but keeps logout", () => {
    mockAuth({ isDemo: true, user: { email: null } as never });
    renderHeader();

    expect(screen.queryByRole("link", { name: "Account" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Log out" })).toBeInTheDocument();
  });
});
