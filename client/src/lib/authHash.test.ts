import { describe, expect, it } from "vitest";

import { hashHasAuthError } from "./authHash";

describe("hashHasAuthError", () => {
  it("detects an expired/used link error hash", () => {
    expect(hashHasAuthError("#error=access_denied&error_code=otp_expired")).toBe(true);
    expect(hashHasAuthError("#error_code=otp_expired")).toBe(true);
  });

  it("returns false for a valid recovery token hash", () => {
    expect(hashHasAuthError("#access_token=abc&type=recovery")).toBe(false);
  });

  it("returns false for an empty hash", () => {
    expect(hashHasAuthError("")).toBe(false);
  });
});
