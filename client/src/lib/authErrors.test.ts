import { describe, expect, it } from "vitest";

import {
  AuthFailure,
  OFFLINE,
  RATE_LIMITED,
  SAME_PASSWORD,
  WEAK_PASSWORD,
  authErrorMessage,
} from "./authErrors";

const failure = (code: string, status = 400, message = code) =>
  new AuthFailure(message, code, status);

describe("authErrorMessage", () => {
  it("gives the same login message whether or not the email exists", () => {
    const wrongPassword = authErrorMessage("login", failure("invalid_credentials"));
    const unconfirmed = authErrorMessage("login", failure("email_not_confirmed"));
    const unknown = authErrorMessage("login", new Error("User not found"));

    expect(wrongPassword).toMatch(/^Incorrect email or password/);
    expect(unconfirmed).toBe(wrongPassword);
    expect(unknown).toBe(wrongPassword);
  });

  it("never says an email is already registered on sign-up", () => {
    const message = authErrorMessage(
      "signup",
      failure("user_already_exists", 422, "User already registered"),
    );
    expect(message).not.toMatch(/already registered|exists/i);
    expect(message).toMatch(/couldn't create an account/);
  });

  it("explains password-rule failures, which reveal nothing about the account", () => {
    expect(authErrorMessage("signup", failure("weak_password", 422))).toBe(
      WEAK_PASSWORD,
    );
    expect(authErrorMessage("update", failure("same_password", 422))).toBe(
      SAME_PASSWORD,
    );
  });

  it("keeps reset errors generic", () => {
    expect(authErrorMessage("reset", failure("unexpected_failure", 500))).toMatch(
      /couldn't send the reset link/,
    );
  });

  it("calls out rate limits and network failures", () => {
    expect(authErrorMessage("login", failure("over_request_rate_limit", 429))).toBe(
      RATE_LIMITED,
    );
    expect(authErrorMessage("reset", failure("over_email_send_rate_limit", 429))).toBe(
      RATE_LIMITED,
    );
    expect(authErrorMessage("login", new TypeError("Failed to fetch"))).toBe(OFFLINE);
  });
});
