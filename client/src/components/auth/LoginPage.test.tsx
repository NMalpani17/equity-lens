import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

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
import { clearSignupIntent, rememberSignupIntent } from "@/lib/authIntent";
import { setAuthFlash } from "@/lib/authFlash";

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

/** Render the login page inside routes so post-auth redirects are observable. */
function renderWithRoutes() {
  render(
    <MemoryRouter initialEntries={["/login"]}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={<div>dashboard-home</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  clearSignupIntent();
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

  it("shows a forgot-password link in login mode", () => {
    renderPage();
    expect(screen.getByRole("link", { name: "Forgot password?" })).toHaveAttribute(
      "href",
      "/forgot-password",
    );
  });

  it("opens in sign-up mode when a signup intent is set (from the demo banner)", () => {
    rememberSignupIntent();
    renderPage();

    expect(screen.getByRole("button", { name: "Create account" })).toBeInTheDocument();
  });

  it("shows a one-shot flash message (e.g. after account deletion)", () => {
    setAuthFlash("Your account has been deleted.");
    renderPage();

    expect(screen.getByText("Your account has been deleted.")).toBeInTheDocument();
  });

  it("surfaces an error when sign in fails", async () => {
    authValue.signIn.mockRejectedValue(new Error("Invalid login credentials"));
    renderPage();
    fillCredentials();
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));

    expect(await screen.findByText("Invalid login credentials")).toBeInTheDocument();
  });
});

describe("LoginPage post-auth redirect", () => {
  it("sends a normal login without a bounce to the dashboard", async () => {
    authValue.signIn.mockImplementation(async () => {
      authValue.user = { email: "me@example.com" };
    });
    renderWithRoutes(); // no return-to location

    fillCredentials("me@example.com", "pw123456");
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));

    expect(await screen.findByText("dashboard-home")).toBeInTheDocument();
  });

  it("sends a sign-up to the dashboard", async () => {
    authValue.signUp.mockImplementation(async () => {
      authValue.user = { email: "new@example.com" };
    });
    renderWithRoutes();

    fireEvent.click(screen.getByRole("button", { name: "Sign up" }));
    fillCredentials("new@example.com", "pw123456");
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    expect(await screen.findByText("dashboard-home")).toBeInTheDocument();
  });

  it("sends the demo to the dashboard", async () => {
    authValue.signInWithDemo.mockImplementation(async () => {
      authValue.user = { email: null, is_anonymous: true };
    });
    renderWithRoutes();

    fireEvent.click(screen.getByRole("button", { name: "Try demo" }));

    expect(await screen.findByText("dashboard-home")).toBeInTheDocument();
  });
});
