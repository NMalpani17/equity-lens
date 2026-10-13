import { describe, expect, it } from "vitest";

import {
  confirmPasswordError,
  emailError,
  meetsPasswordRule,
  newPasswordError,
  passwordLength,
  requiredPasswordError,
} from "./validation";

describe("password rule", () => {
  it("accepts 8 to 64 characters with no composition rules", () => {
    expect(meetsPasswordRule("abcdefgh")).toBe(true);
    expect(meetsPasswordRule("a".repeat(64))).toBe(true);
    expect(meetsPasswordRule("all lowercase words")).toBe(true);
    expect(newPasswordError("12345678")).toBeNull();
  });

  it("rejects fewer than 8 or more than 64 characters", () => {
    expect(meetsPasswordRule("abcdefg")).toBe(false);
    expect(meetsPasswordRule("a".repeat(65))).toBe(false);
    expect(newPasswordError("short")).toBe("Use at least 8 characters.");
    expect(newPasswordError("a".repeat(65))).toBe("Use no more than 64 characters.");
    expect(newPasswordError("")).toBe("Enter a password.");
  });

  it("counts an emoji as one character", () => {
    expect(passwordLength("🔒🔒🔒🔒")).toBe(4);
    expect(meetsPasswordRule("🔒".repeat(8))).toBe(true);
  });
});

describe("confirmPasswordError", () => {
  it("requires a matching confirmation", () => {
    expect(confirmPasswordError("password1", "")).toBe("Confirm your password.");
    expect(confirmPasswordError("password1", "password2")).toBe(
      "Passwords don't match.",
    );
    expect(confirmPasswordError("password1", "password1")).toBeNull();
  });
});

describe("emailError", () => {
  it("requires a plausible address", () => {
    expect(emailError("")).toBe("Enter your email address.");
    expect(emailError("   ")).toBe("Enter your email address.");
    expect(emailError("not-an-email")).toBe("Enter a valid email address.");
    expect(emailError(" me@example.com ")).toBeNull();
  });
});

describe("requiredPasswordError", () => {
  it("only checks that a password was entered", () => {
    expect(requiredPasswordError("")).toBe("Enter your password.");
    expect(requiredPasswordError("short")).toBeNull();
  });
});
