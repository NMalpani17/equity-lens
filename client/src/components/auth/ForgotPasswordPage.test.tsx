import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const sendPasswordReset = vi.fn();
vi.mock("@/context/auth-context", () => ({
  useAuth: () => ({ sendPasswordReset }),
}));

import { ForgotPasswordPage } from "./ForgotPasswordPage";

function renderPage() {
  render(
    <MemoryRouter>
      <ForgotPasswordPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  sendPasswordReset.mockResolvedValue(undefined);
});

describe("ForgotPasswordPage", () => {
  it("sends a reset email and confirms it was sent", async () => {
    renderPage();
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "me@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));

    await waitFor(() =>
      expect(sendPasswordReset).toHaveBeenCalledWith("me@example.com"),
    );
    expect(await screen.findByText(/reset link is on its way/)).toBeInTheDocument();
  });

  it("requires an email address", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Enter your email address.");
    expect(sendPasswordReset).not.toHaveBeenCalled();
  });

  it("surfaces an error when the request fails", async () => {
    sendPasswordReset.mockRejectedValue(new Error("rate limited"));
    renderPage();
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "me@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));

    expect(await screen.findByText("rate limited")).toBeInTheDocument();
  });
});
