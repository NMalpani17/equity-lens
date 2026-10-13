import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { Label } from "@/components/ui/label";
import { PasswordInput } from "./PasswordInput";
import { PasswordRequirement } from "./PasswordRequirement";

function renderInput() {
  render(
    <>
      <Label htmlFor="pw">Password</Label>
      <PasswordInput id="pw" autoComplete="new-password" />
    </>,
  );
  return screen.getByLabelText("Password") as HTMLInputElement;
}

describe("PasswordInput", () => {
  it("toggles between hidden and visible without losing the value", () => {
    const input = renderInput();
    fireEvent.change(input, { target: { value: "hunter22" } });
    const toggle = screen.getByRole("button", { name: "Show password" });

    expect(input).toHaveAttribute("type", "password");
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(toggle);
    expect(input).toHaveAttribute("type", "text");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(input.value).toBe("hunter22");

    fireEvent.click(toggle);
    expect(input).toHaveAttribute("type", "password");
  });

  it("keeps autocomplete for password managers", () => {
    const input = renderInput();
    expect(input).toHaveAttribute("autocomplete", "new-password");
  });

  it("is a plain button, so it never submits the form", () => {
    renderInput();
    expect(screen.getByRole("button", { name: "Show password" })).toHaveAttribute(
      "type",
      "button",
    );
  });
});

describe("PasswordRequirement", () => {
  it("shows the requirement as met only for 8–64 characters", () => {
    const { rerender } = render(<PasswordRequirement password="short" />);
    expect(screen.getByText(/8–64 characters/)).toHaveTextContent("(not met yet)");

    rerender(<PasswordRequirement password="long enough" />);
    expect(screen.getByText(/8–64 characters/)).toHaveTextContent("(met)");

    rerender(<PasswordRequirement password={"a".repeat(65)} />);
    expect(screen.getByText(/8–64 characters/)).toHaveTextContent("(too long)");
  });
});
