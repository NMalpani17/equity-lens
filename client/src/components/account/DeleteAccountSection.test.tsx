import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const signOut = vi.fn();
vi.mock("@/context/auth-context", () => ({ useAuth: () => ({ signOut }) }));

vi.mock("@/lib/api", () => ({ deleteAccount: vi.fn() }));
vi.mock("@/lib/authFlash", () => ({ setAuthFlash: vi.fn() }));

import { DeleteAccountSection } from "./DeleteAccountSection";
import { deleteAccount } from "@/lib/api";
import { setAuthFlash } from "@/lib/authFlash";

const deleteAccountMock = vi.mocked(deleteAccount);
const setAuthFlashMock = vi.mocked(setAuthFlash);

beforeEach(() => {
  vi.clearAllMocks();
  deleteAccountMock.mockResolvedValue(undefined);
  signOut.mockResolvedValue(undefined);
});

async function openDialog() {
  fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
  return screen.findByRole("alertdialog");
}

describe("DeleteAccountSection", () => {
  it("keeps the confirm button disabled until DELETE is typed", async () => {
    render(<DeleteAccountSection />);
    const dialog = await openDialog();

    const confirm = within(dialog).getByRole("button", { name: "Delete account" });
    expect(confirm).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText(/type delete to confirm/i), {
      target: { value: "delete" }, // wrong case
    });
    expect(confirm).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText(/type delete to confirm/i), {
      target: { value: "DELETE" },
    });
    expect(confirm).toBeEnabled();
  });

  it("deletes the account, flashes a message, signs out, and returns to login", async () => {
    render(<DeleteAccountSection />);
    const dialog = await openDialog();

    fireEvent.change(within(dialog).getByLabelText(/type delete to confirm/i), {
      target: { value: "DELETE" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete account" }));

    await waitFor(() => expect(deleteAccountMock).toHaveBeenCalledOnce());
    expect(setAuthFlashMock).toHaveBeenCalledWith("Your account has been deleted.");
    // signOut() clears the return-to and redirects to login (see AuthProvider tests).
    await waitFor(() => expect(signOut).toHaveBeenCalledOnce());
  });

  it("surfaces an error and does not sign out when deletion fails", async () => {
    deleteAccountMock.mockRejectedValue(new Error("server error"));
    render(<DeleteAccountSection />);
    const dialog = await openDialog();

    fireEvent.change(within(dialog).getByLabelText(/type delete to confirm/i), {
      target: { value: "DELETE" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete account" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("server error");
    // On failure it neither signs out nor navigates away.
    expect(signOut).not.toHaveBeenCalled();
  });
});
