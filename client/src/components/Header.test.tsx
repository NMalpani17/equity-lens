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

describe("Header user menu", () => {
  it("labels the trigger with the user's email and initial", () => {
    mockAuth({ isDemo: false });
    renderHeader();

    const trigger = screen.getByRole("button", {
      name: /user menu for me@example.com/i,
    });
    expect(trigger).toHaveTextContent("M"); // avatar initial
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
    mockAuth({ isDemo: false });
    renderHeader();
    openMenu(/user menu for me@example.com/i);

    fireEvent.click(await screen.findByRole("menuitem", { name: "Log out" }));

    await waitFor(() => expect(signOut).toHaveBeenCalledOnce());
  });
});
