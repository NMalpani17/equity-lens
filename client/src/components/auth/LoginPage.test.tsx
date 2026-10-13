import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

// Control the auth context so the page can be tested in isolation.
const authValue = {
  session: null as unknown,
  user: null as unknown,
  loading: false,
  isDemo: false,
  isPasswordRecovery: false,
  signIn: vi.fn(),
  signUp: vi.fn(),
  signInWithGoogle: vi.fn(),
  signInWithDemo: vi.fn(),
  signOut: vi.fn(),
};

vi.mock("@/context/auth-context", () => ({
  useAuth: () => authValue,
}));

import { LoginPage } from "./LoginPage";
import { AuthFailure } from "@/lib/authErrors";
import { clearSignupIntent, rememberSignupIntent } from "@/lib/authIntent";
import { setAuthFlash } from "@/lib/authFlash";

function renderPage() {
  render(
    <MemoryRouter>
      <LoginPage />
    </MemoryRouter>,
  );
}

const emailInput = () => screen.getByLabelText("Email");
const passwordInput = () => screen.getByLabelText("Password");
const confirmInput = () => screen.getByLabelText("Confirm password");

function type(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } });
}

function fillCredentials(email = "user@example.com", password = "secret123") {
  type(emailInput(), email);
  type(passwordInput(), password);
}

function switchToSignup() {
  fireEvent.click(screen.getByRole("tab", { name: "Sign up" }));
}

function fillSignup(
  email = "new@example.com",
  password = "pw123456",
  confirm = password,
) {
  fillCredentials(email, password);
  type(confirmInput(), confirm);
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
  authValue.signUp.mockResolvedValue({ needsConfirmation: false });
  authValue.signInWithDemo.mockResolvedValue(undefined);
  authValue.signInWithGoogle.mockResolvedValue(undefined);
});

describe("LoginPage: log in", () => {
  it("shows the login form by default", () => {
    renderPage();
    expect(screen.getByText("Log in to view your portfolio.")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Log in" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("button", { name: "Log in" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Confirm password")).not.toBeInTheDocument();
  });

  it("uses the right input types and autocomplete", () => {
    renderPage();
    expect(emailInput()).toHaveAttribute("type", "email");
    expect(emailInput()).toHaveAttribute("autocomplete", "email");
    expect(passwordInput()).toHaveAttribute("type", "password");
    expect(passwordInput()).toHaveAttribute("autocomplete", "current-password");
  });

  it("signs in with the entered credentials", async () => {
    renderPage();
    fillCredentials("me@example.com", "pw123456");
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));

    await waitFor(() =>
      expect(authValue.signIn).toHaveBeenCalledWith("me@example.com", "pw123456"),
    );
  });

  it("accepts an existing password shorter than the new-password rule", async () => {
    renderPage();
    fillCredentials("me@example.com", "short");
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));

    await waitFor(() =>
      expect(authValue.signIn).toHaveBeenCalledWith("me@example.com", "short"),
    );
  });

  it("shows an error per field on submit and focuses the first one", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));

    expect(screen.getByText("Enter your email address.")).toBeInTheDocument();
    expect(screen.getByText("Enter your password.")).toBeInTheDocument();
    expect(emailInput()).toHaveAttribute("aria-invalid", "true");
    expect(emailInput()).toHaveFocus();
    expect(authValue.signIn).not.toHaveBeenCalled();
  });

  it("validates a field when the user leaves it, not before", () => {
    renderPage();
    type(emailInput(), "not-an-email");
    expect(screen.queryByText("Enter a valid email address.")).not.toBeInTheDocument();

    fireEvent.blur(emailInput());
    expect(screen.getByText("Enter a valid email address.")).toBeInTheDocument();
    expect(emailInput()).toHaveAccessibleDescription("Enter a valid email address.");
  });

  it("shows the forgot-password link under the password field", () => {
    renderPage();
    expect(screen.getByRole("link", { name: "Forgot password?" })).toHaveAttribute(
      "href",
      "/forgot-password",
    );
  });

  it("toggles password visibility", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(passwordInput()).toHaveAttribute("type", "text");
  });

  it("shows a loading state while logging in", async () => {
    let finish: () => void = () => {};
    authValue.signIn.mockReturnValue(new Promise<void>((r) => (finish = r)));
    renderPage();
    fillCredentials();
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));

    const button = await screen.findByRole("button", { name: "Logging in…" });
    expect(button).toBeDisabled();
    finish();
    expect(await screen.findByRole("button", { name: "Log in" })).toBeEnabled();
  });

  it("shows a generic error and keeps what was entered", async () => {
    authValue.signIn.mockRejectedValue(
      new AuthFailure("Email not confirmed", "email_not_confirmed", 400),
    );
    renderPage();
    fillCredentials("me@example.com", "pw123456");
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /^Incorrect email or password/,
    );
    expect(emailInput()).toHaveValue("me@example.com");
    expect(passwordInput()).toHaveValue("pw123456");
  });

  it("starts the demo session", async () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Try demo" }));

    await waitFor(() => expect(authValue.signInWithDemo).toHaveBeenCalledOnce());
  });

  it("shows a one-shot flash message (e.g. after account deletion)", () => {
    setAuthFlash("Your account has been deleted.");
    renderPage();

    expect(screen.getByText("Your account has been deleted.")).toBeInTheDocument();
  });
});

describe("LoginPage: sign up", () => {
  it("switches to sign up with password, confirm and the requirement", () => {
    renderPage();
    switchToSignup();

    expect(
      screen.getByText("Create an account to start tracking your holdings."),
    ).toBeInTheDocument();
    expect(passwordInput()).toHaveAttribute("autocomplete", "new-password");
    expect(confirmInput()).toHaveAttribute("autocomplete", "new-password");
    expect(screen.getByText(/8–64 characters/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Forgot password?" })).toBeNull();
    // Every password field has its own toggle.
    expect(screen.getAllByRole("button", { name: "Show password" })).toHaveLength(2);
  });

  it("supports arrow keys on the log in / sign up switch", () => {
    renderPage();
    fireEvent.keyDown(screen.getByRole("tab", { name: "Log in" }), {
      key: "ArrowRight",
    });

    const signupTab = screen.getByRole("tab", { name: "Sign up" });
    expect(signupTab).toHaveAttribute("aria-selected", "true");
    expect(signupTab).toHaveFocus();
  });

  it("creates an account", async () => {
    renderPage();
    switchToSignup();
    fillSignup("new@example.com", "pw123456");
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() =>
      expect(authValue.signUp).toHaveBeenCalledWith("new@example.com", "pw123456"),
    );
  });

  it("updates the password requirement while typing", () => {
    renderPage();
    switchToSignup();

    type(passwordInput(), "short");
    expect(screen.getByText(/8–64 characters/)).toHaveTextContent("(not met yet)");
    type(passwordInput(), "long enough");
    expect(screen.getByText(/8–64 characters/)).toHaveTextContent("(met)");
  });

  it("says passwords don't match while typing the confirmation", () => {
    renderPage();
    switchToSignup();
    type(passwordInput(), "pw123456");
    type(confirmInput(), "pw12");

    expect(screen.getByText("Passwords don't match.")).toBeInTheDocument();

    type(confirmInput(), "pw123456");
    expect(screen.queryByText("Passwords don't match.")).not.toBeInTheDocument();
  });

  it("rejects a password under 8 characters before calling Supabase", () => {
    renderPage();
    switchToSignup();
    fillSignup("new@example.com", "pw123");
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    expect(screen.getByText("Use at least 8 characters.")).toBeInTheDocument();
    expect(passwordInput()).toHaveFocus();
    expect(authValue.signUp).not.toHaveBeenCalled();
  });

  it("shows a check-your-email screen when confirmation is required", async () => {
    authValue.signUp.mockResolvedValue({ needsConfirmation: true });
    renderPage();
    switchToSignup();
    fillSignup("new@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    expect(
      await screen.findByRole("heading", { name: "Check your email" }),
    ).toBeInTheDocument();
    expect(screen.getByText("new@example.com")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back to log in" }));
    expect(screen.getByRole("tab", { name: "Log in" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(emailInput()).toHaveValue("new@example.com");
  });

  it("never says an email is already registered", async () => {
    authValue.signUp.mockRejectedValue(
      new AuthFailure("User already registered", "user_already_exists", 422),
    );
    renderPage();
    switchToSignup();
    fillSignup("taken@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/couldn't create an account/);
    expect(alert).not.toHaveTextContent(/already registered/);
  });

  it("opens in sign-up mode when a signup intent is set (from the demo banner)", () => {
    rememberSignupIntent();
    renderPage();

    expect(screen.getByRole("button", { name: "Create account" })).toBeInTheDocument();
  });
});

describe("LoginPage: Google sign-in", () => {
  it("offers Continue with Google on both log in and sign up", () => {
    renderPage();
    expect(screen.getByRole("button", { name: "Continue with Google" })).toBeVisible();
    switchToSignup();
    expect(screen.getByRole("button", { name: "Continue with Google" })).toBeVisible();
  });

  it("starts the Google OAuth flow", async () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));

    await waitFor(() => expect(authValue.signInWithGoogle).toHaveBeenCalledOnce());
  });

  it("shows a generic error when Google can't be started", async () => {
    authValue.signInWithGoogle.mockRejectedValue(
      new AuthFailure(
        "Unsupported provider: provider is not enabled",
        "validation_failed",
        400,
      ),
    );
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/Sign-in didn't complete/);
    expect(alert).not.toHaveTextContent(/provider/);
    expect(screen.getByRole("button", { name: "Continue with Google" })).toBeEnabled();
  });

  it("shows a generic error when Google (or an email link) returns one", () => {
    render(
      <MemoryRouter
        initialEntries={[
          "/login?error=access_denied&error_description=Email+not+found",
        ]}
      >
        <Routes>
          <Route path="/login" element={<LoginPage />} />
        </Routes>
      </MemoryRouter>,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/Sign-in didn't complete/);
    expect(alert).not.toHaveTextContent(/not found/);
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
      return { needsConfirmation: false };
    });
    renderWithRoutes();

    switchToSignup();
    fillSignup("new@example.com", "pw123456");
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
