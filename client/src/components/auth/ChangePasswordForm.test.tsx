import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const updatePassword = vi.fn();
vi.mock("@/context/auth-context", () => ({
  useAuth: () => ({ updatePassword }),
}));

import { ChangePasswordForm } from "./ChangePasswordForm";

const onSuccess = vi.fn();

function renderForm() {
  render(<ChangePasswordForm submitLabel="Update password" onSuccess={onSuccess} />);
}

function fill(newPw: string, confirmPw: string) {
  fireEvent.change(screen.getByLabelText("New password"), {
    target: { value: newPw },
  });
  fireEvent.change(screen.getByLabelText("Confirm new password"), {
    target: { value: confirmPw },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  updatePassword.mockResolvedValue(undefined);
});

describe("ChangePasswordForm", () => {
  it("rejects a too-short password", () => {
    renderForm();
    fill("1234567", "1234567");
    fireEvent.click(screen.getByRole("button", { name: "Update password" }));

    expect(screen.getByText("Use at least 8 characters.")).toBeInTheDocument();
    expect(screen.getByLabelText("New password")).toHaveFocus();
    expect(updatePassword).not.toHaveBeenCalled();
  });

  it("says passwords don't match while typing, and blocks submit", () => {
    renderForm();
    fill("abcdefgh", "abcdefgx");
    expect(screen.getByText("Passwords don't match.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Update password" }));
    expect(updatePassword).not.toHaveBeenCalled();
  });

  it("shows the requirement and a toggle on both fields", () => {
    renderForm();
    expect(screen.getByText(/8–64 characters/)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Show password" })).toHaveLength(2);
  });

  it("updates the password and calls onSuccess", async () => {
    renderForm();
    fill("abcdefgh", "abcdefgh");
    fireEvent.click(screen.getByRole("button", { name: "Update password" }));

    await waitFor(() => expect(updatePassword).toHaveBeenCalledWith("abcdefgh"));
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it("surfaces an error when the update fails", async () => {
    updatePassword.mockRejectedValue(new Error("session missing"));
    renderForm();
    fill("abcdefgh", "abcdefgh");
    fireEvent.click(screen.getByRole("button", { name: "Update password" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "We couldn't update your password.",
    );
  });
});
