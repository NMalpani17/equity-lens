import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("@/context/auth-context", () => ({ useAuth: vi.fn() }));

import { useAuth } from "@/context/auth-context";
import { Header } from "./Header";

const useAuthMock = vi.mocked(useAuth);
const signOut = vi.fn();

function mockAuth(overrides: Partial<ReturnType<typeof useAuth>>) {
  useAuthMock.mockReturnValue({
    session: null,
    user: { email: "me@example.com" } as never,
    loading: false,
    isDemo: false,
    isPasswordRecovery: false,
    signIn: vi.fn(),
    signUp: vi.fn(),
    signInWithDemo: vi.fn(),
    sendPasswordReset: vi.fn(),
    updatePassword: vi.fn(),
    signOut,
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

/** Open the user menu via keyboard (also exercises accessibility). */
function openMenu(name: RegExp) {
  const trigger = screen.getByRole("button", { name });
  fireEvent.keyDown(trigger, { key: "Enter" });
  return trigger;
}

beforeEach(() => {
  vi.clearAllMocks();
  signOut.mockResolvedValue(undefined);
});

describe("Header", () => {
  it("links the logo to the dashboard", () => {
    mockAuth({ isDemo: false });
    renderHeader();

    expect(screen.getByRole("link", { name: "Equity Lens" })).toHaveAttribute(
      "href",
      "/",
    );
  });
});

describe("Header user menu", () => {
  it("shows only the avatar initial on the trigger (no inline email text)", () => {
    mockAuth({ isDemo: false });
    renderHeader();

    const trigger = screen.getByRole("button", {
      name: /user menu for me@example.com/i,
    });
    expect(trigger).toHaveTextContent("M"); // avatar initial
    // The email is not rendered inline on the trigger; it lives in the menu/tooltip.
    expect(trigger).not.toHaveTextContent("me@example.com");
  });

  it("reveals the full email in a tooltip on focus", async () => {
    mockAuth({ isDemo: false });
    renderHeader();

    fireEvent.focus(
      screen.getByRole("button", { name: /user menu for me@example.com/i }),
    );

    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent("me@example.com");
  });

  it("shows account settings and logout for a regular user", async () => {
    mockAuth({ isDemo: false });
    renderHeader();
    openMenu(/user menu for me@example.com/i);

    const accountItem = await screen.findByRole("menuitem", {
      name: "Account settings",
    });
    expect(accountItem).toHaveAttribute("href", "/account");
    expect(screen.getByRole("menuitem", { name: "Log out" })).toBeInTheDocument();
  });

  it("labels demo users and offers only logout", async () => {
    mockAuth({ isDemo: true, user: { email: null } as never });
    renderHeader();

    const trigger = screen.getByRole("button", { name: /user menu for demo user/i });
    expect(trigger).toHaveTextContent("D");

    fireEvent.keyDown(trigger, { key: "Enter" });

    expect(
      await screen.findByRole("menuitem", { name: "Log out" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: "Account settings" }),
    ).not.toBeInTheDocument();
  });

  it("signs out when Log out is selected", async () => {
    // signOut() itself clears the return-to and redirects (see AuthProvider tests).
    mockAuth({ isDemo: false });
    renderHeader();
    openMenu(/user menu for me@example.com/i);

    fireEvent.click(await screen.findByRole("menuitem", { name: "Log out" }));

    await waitFor(() => expect(signOut).toHaveBeenCalledOnce());
  });
});
