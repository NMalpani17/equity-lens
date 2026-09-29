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
    isPasswordRecovery: false,
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

const invalidText = "This reset link is invalid or has expired.";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ResetPasswordPage", () => {
  it("shows the form only for a genuine password-recovery session", () => {
    mockAuth({ isPasswordRecovery: true, user: { email: "me@example.com" } as never });
    renderAt("/reset-password");

    expect(screen.getByLabelText("New password")).toBeInTheDocument();
    expect(screen.queryByText(invalidText)).not.toBeInTheDocument();
  });

  it("shows the invalid state for an anonymous (demo) session", () => {
    mockAuth({
      isPasswordRecovery: false,
      isDemo: true,
      user: { email: null, is_anonymous: true } as never,
    });
    renderAt("/reset-password#error=access_denied&error_code=otp_expired");

    expect(screen.getByText(invalidText)).toBeInTheDocument();
    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
  });

  it("shows the invalid state for a regular logged-in user (not from a link)", () => {
    mockAuth({ isPasswordRecovery: false, user: { email: "me@example.com" } as never });
    renderAt("/reset-password");

    expect(screen.getByText(invalidText)).toBeInTheDocument();
    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
  });

  it("shows the invalid state when there is no session at all", () => {
    mockAuth({ isPasswordRecovery: false, user: null });
    renderAt("/reset-password");

    expect(screen.getByText(invalidText)).toBeInTheDocument();
  });

  it("shows a spinner while the session is resolving", () => {
    mockAuth({ loading: true });
    renderAt("/reset-password");

    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
    expect(screen.queryByText(invalidText)).not.toBeInTheDocument();
  });

  it("strips the token/error hash from the URL", () => {
    mockAuth({ isPasswordRecovery: false });
    renderAt("/reset-password#error=access_denied&error_code=otp_expired");

    expect(navigate).toHaveBeenCalledWith(
      { pathname: "/reset-password", hash: "" },
      { replace: true },
    );
  });

  it("sends the user to the forgot-password form to request a new link", () => {
    mockAuth({ isPasswordRecovery: false });
    renderAt("/reset-password#error=access_denied&error_code=otp_expired");

    fireEvent.click(screen.getByRole("button", { name: "Request a new link" }));
    expect(navigate).toHaveBeenCalledWith("/forgot-password");
  });
});
