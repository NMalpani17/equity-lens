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
    fill("123", "123");
    fireEvent.click(screen.getByRole("button", { name: "Update password" }));

    expect(screen.getByRole("alert")).toHaveTextContent("at least 6 characters");
    expect(updatePassword).not.toHaveBeenCalled();
  });

  it("rejects mismatched passwords", () => {
    renderForm();
    fill("abcdef", "abcdeg");
    fireEvent.click(screen.getByRole("button", { name: "Update password" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Passwords do not match.");
    expect(updatePassword).not.toHaveBeenCalled();
  });

  it("updates the password and calls onSuccess", async () => {
    renderForm();
    fill("abcdef", "abcdef");
    fireEvent.click(screen.getByRole("button", { name: "Update password" }));

    await waitFor(() => expect(updatePassword).toHaveBeenCalledWith("abcdef"));
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it("surfaces an error when the update fails", async () => {
    updatePassword.mockRejectedValue(new Error("session missing"));
    renderForm();
    fill("abcdef", "abcdef");
    fireEvent.click(screen.getByRole("button", { name: "Update password" }));

    expect(await screen.findByText("session missing")).toBeInTheDocument();
  });
});
