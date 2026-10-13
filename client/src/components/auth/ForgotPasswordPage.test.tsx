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

    expect(screen.getByText("Enter your email address.")).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toHaveFocus();
    expect(sendPasswordReset).not.toHaveBeenCalled();
  });

  it("validates the email when the user leaves the field", () => {
    renderPage();
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "nope" } });
    fireEvent.blur(screen.getByLabelText("Email"));

    expect(screen.getByText("Enter a valid email address.")).toBeInTheDocument();
  });

  it("says when to retry after a rate limit", async () => {
    sendPasswordReset.mockRejectedValue(new Error("email rate limit exceeded"));
    renderPage();
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "me@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Too many attempts");
  });

  it("keeps other failures generic", async () => {
    sendPasswordReset.mockRejectedValue(new Error("User not found"));
    renderPage();
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "me@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("couldn't send the reset link");
    expect(alert).not.toHaveTextContent("not found");
    expect(screen.getByLabelText("Email")).toHaveValue("me@example.com");
  });
});
