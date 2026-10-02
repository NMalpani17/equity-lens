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
    expect(screen.getAllByRole("button", { name: "Sign up" })).toHaveLength(2);
  });

  it("collapses to a single slim line on small screens", () => {
    render(<DemoBanner />);

    const banner = screen.getByRole("status");
    // Phones: "Demo mode · Sign up" on one line; desktop keeps the full banner.
    expect(banner).toHaveTextContent(/^Demo mode ·\s*Sign up/);
    expect(banner.className).toContain("whitespace-nowrap");
    expect(banner.className).toContain("md:whitespace-normal");
    expect(screen.getByText("Demo mode ·").className).toContain("md:hidden");
    const [compact, full] = screen.getAllByRole("button", { name: "Sign up" });
    expect(compact!.className).toContain("md:hidden");
    expect(full!.className).toContain("hidden md:inline-flex");
    expect(screen.getByText(/You're exploring a demo/).className).toContain(
      "hidden md:inline",
    );
  });

  it.each([0, 1])(
    "signs out and flags sign-up intent when Sign up is clicked (button %i)",
    async (index) => {
      render(<DemoBanner />);

      fireEvent.click(screen.getAllByRole("button", { name: "Sign up" })[index]!);

      // Intent is recorded synchronously; sign-out follows.
      expect(hasSignupIntent()).toBe(true);
      await waitFor(() => expect(signOut).toHaveBeenCalledOnce());
    },
  );
});
