import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const navigate = vi.fn();
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => navigate };
});

vi.mock("@/context/auth-context", () => ({ useAuth: vi.fn() }));

import { useAuth } from "@/context/auth-context";
import { ResetPasswordPage } from "./ResetPasswordPage";

const useAuthMock = vi.mocked(useAuth);

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

function renderAt(entry: string) {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <ResetPasswordPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ResetPasswordPage", () => {
  it("shows the form for a valid recovery session", () => {
    mockAuth({ user: { email: "me@example.com" } as never });
    renderAt("/reset-password");

    expect(screen.getByLabelText("New password")).toBeInTheDocument();
    expect(
      screen.queryByText("This reset link is invalid or has expired."),
    ).not.toBeInTheDocument();
  });

  it("shows an error and no form when the link hash carries an auth error", () => {
    mockAuth({ user: null });
    renderAt("/reset-password#error=access_denied&error_code=otp_expired");

    expect(
      screen.getByText("This reset link is invalid or has expired."),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
    // The error hash is stripped from the URL.
    expect(navigate).toHaveBeenCalledWith(
      { pathname: "/reset-password", hash: "" },
      { replace: true },
    );
  });

  it("shows an error when there is no recovery session", () => {
    mockAuth({ user: null });
    renderAt("/reset-password");

    expect(
      screen.getByText("This reset link is invalid or has expired."),
    ).toBeInTheDocument();
  });

  it("shows a spinner while the session is resolving", () => {
    mockAuth({ loading: true });
    renderAt("/reset-password");

    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
    expect(
      screen.queryByText("This reset link is invalid or has expired."),
    ).not.toBeInTheDocument();
  });

  it("sends the user to the forgot-password form to request a new link", () => {
    mockAuth({ user: null });
    renderAt("/reset-password#error=access_denied&error_code=otp_expired");

    fireEvent.click(screen.getByRole("button", { name: "Request a new link" }));
    expect(navigate).toHaveBeenCalledWith("/forgot-password");
  });
});
