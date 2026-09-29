import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const signOut = vi.fn();
vi.mock("@/context/auth-context", () => ({ useAuth: () => ({ signOut }) }));

import { DemoBanner } from "./DemoBanner";
import { clearSignupIntent, hasSignupIntent } from "@/lib/authIntent";

beforeEach(() => {
  vi.clearAllMocks();
  clearSignupIntent();
  signOut.mockResolvedValue(undefined);
});

describe("DemoBanner", () => {
  it("shows the demo message and a sign-up call to action", () => {
    render(<DemoBanner />);

    expect(
      screen.getByText(
        /You're exploring a demo\. Sign up to save your own portfolio\./,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign up" })).toBeInTheDocument();
  });

  it("signs out and flags sign-up intent when Sign up is clicked", async () => {
    render(<DemoBanner />);

    fireEvent.click(screen.getByRole("button", { name: "Sign up" }));

    // Intent is recorded synchronously; sign-out follows.
    expect(hasSignupIntent()).toBe(true);
    await waitFor(() => expect(signOut).toHaveBeenCalledOnce());
  });
});
