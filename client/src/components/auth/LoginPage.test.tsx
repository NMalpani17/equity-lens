import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Control the auth context so the page can be tested in isolation.
const authValue = {
  session: null as unknown,
  user: null as unknown,
  loading: false,
  isDemo: false,
  signIn: vi.fn(),
  signUp: vi.fn(),
  signInWithDemo: vi.fn(),
  signOut: vi.fn(),
};

vi.mock("@/context/auth-context", () => ({
  useAuth: () => authValue,
}));

import { LoginPage } from "./LoginPage";

function renderPage() {
  render(
    <MemoryRouter>
      <LoginPage />
    </MemoryRouter>,
  );
}

function fillCredentials(email = "user@example.com", password = "secret123") {
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: email } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
}

beforeEach(() => {
  vi.clearAllMocks();
  authValue.user = null;
  authValue.loading = false;
  authValue.signIn.mockResolvedValue(undefined);
  authValue.signUp.mockResolvedValue(undefined);
  authValue.signInWithDemo.mockResolvedValue(undefined);
});

describe("LoginPage", () => {
  it("shows the login form by default", () => {
    renderPage();
    expect(screen.getByText("Log in to view your portfolio.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Log in" })).toBeInTheDocument();
  });

  it("signs in with the entered credentials", async () => {
    renderPage();
    fillCredentials("me@example.com", "pw123456");
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));

    await waitFor(() =>
      expect(authValue.signIn).toHaveBeenCalledWith("me@example.com", "pw123456"),
    );
  });

  it("requires both email and password", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Email and password are required.",
    );
    expect(authValue.signIn).not.toHaveBeenCalled();
  });

  it("starts the demo session", async () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Try demo" }));

    await waitFor(() => expect(authValue.signInWithDemo).toHaveBeenCalledOnce());
  });

  it("switches to sign up and creates an account", async () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Sign up" }));

    // The submit action becomes "Create account" in sign-up mode.
    fillCredentials("new@example.com", "pw123456");
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() =>
      expect(authValue.signUp).toHaveBeenCalledWith("new@example.com", "pw123456"),
    );
    expect(await screen.findByText(/Account created/)).toBeInTheDocument();
  });

  it("surfaces an error when sign in fails", async () => {
    authValue.signIn.mockRejectedValue(new Error("Invalid login credentials"));
    renderPage();
    fillCredentials();
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));

    expect(await screen.findByText("Invalid login credentials")).toBeInTheDocument();
  });
});
