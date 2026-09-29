import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const signIn = vi.fn();
const updatePassword = vi.fn();
vi.mock("@/context/auth-context", () => ({
  useAuth: () => ({ user: { email: "me@example.com" }, signIn, updatePassword }),
}));

import { PasswordSection } from "./PasswordSection";

function openForm() {
  fireEvent.click(screen.getByRole("button", { name: "Change password" }));
}

function fill(current: string, next: string, confirm: string) {
  fireEvent.change(screen.getByLabelText("Current password"), {
    target: { value: current },
  });
  fireEvent.change(screen.getByLabelText("New password"), {
    target: { value: next },
  });
  fireEvent.change(screen.getByLabelText("Confirm new password"), {
    target: { value: confirm },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  signIn.mockResolvedValue(undefined);
  updatePassword.mockResolvedValue(undefined);
});

describe("PasswordSection", () => {
  it("is collapsed by default", () => {
    render(<PasswordSection />);

    expect(screen.getByRole("button", { name: "Change password" })).toBeInTheDocument();
    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
  });

  it("reveals the form with autofill hints when expanded", () => {
    render(<PasswordSection />);
    openForm();

    expect(screen.getByLabelText("Current password")).toHaveAttribute(
      "autocomplete",
      "current-password",
    );
    expect(screen.getByLabelText("New password")).toHaveAttribute(
      "autocomplete",
      "new-password",
    );
    expect(screen.getByLabelText("Confirm new password")).toHaveAttribute(
      "autocomplete",
      "new-password",
    );
    expect(screen.getByRole("button", { name: "Update password" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("collapses and clears fields on cancel", () => {
    render(<PasswordSection />);
    openForm();
    fill("old", "newpass1", "newpass1");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Change password" })).toBeInTheDocument();

    // Reopening shows empty fields.
    openForm();
    expect(screen.getByLabelText<HTMLInputElement>("New password").value).toBe("");
  });

  it("blocks a new password equal to the current one", () => {
    render(<PasswordSection />);
    openForm();
    fill("samepass", "samepass", "samepass");
    fireEvent.click(screen.getByRole("button", { name: "Update password" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "New password must be different from your current password.",
    );
    expect(signIn).not.toHaveBeenCalled();
    expect(updatePassword).not.toHaveBeenCalled();
  });

  it("shows a clear error when the current password is wrong", async () => {
    signIn.mockRejectedValue(new Error("Invalid login credentials"));
    render(<PasswordSection />);
    openForm();
    fill("wrongpass", "newpass1", "newpass1");
    fireEvent.click(screen.getByRole("button", { name: "Update password" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Current password is incorrect.",
    );
    expect(updatePassword).not.toHaveBeenCalled();
  });

  it("verifies the current password, updates, then collapses and clears", async () => {
    render(<PasswordSection />);
    openForm();
    fill("oldpass", "newpass1", "newpass1");
    fireEvent.click(screen.getByRole("button", { name: "Update password" }));

    await waitFor(() =>
      expect(signIn).toHaveBeenCalledWith("me@example.com", "oldpass"),
    );
    expect(updatePassword).toHaveBeenCalledWith("newpass1");

    // Collapses back to the row with a success note.
    expect(
      await screen.findByRole("button", { name: "Change password" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Your password has been updated.")).toBeInTheDocument();

    // Fields were cleared.
    openForm();
    expect(screen.getByLabelText<HTMLInputElement>("New password").value).toBe("");
  });

  it("handles Supabase's same-password error gracefully", async () => {
    updatePassword.mockRejectedValue(
      new Error("New password should be different from the old password."),
    );
    render(<PasswordSection />);
    openForm();
    fill("oldpass", "newpass1", "newpass1");
    fireEvent.click(screen.getByRole("button", { name: "Update password" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "New password must be different from your current password.",
    );
    // Stays open so the user can correct it.
    expect(screen.getByLabelText("New password")).toBeInTheDocument();
  });
});
