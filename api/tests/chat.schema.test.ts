import { describe, expect, it } from "vitest";

import { isValidTimeZone, sendMessageSchema } from "../src/schemas/chat.schema.js";

describe("sendMessageSchema time zone", () => {
  it("keeps valid IANA zones", () => {
    expect(
      sendMessageSchema.parse({ content: "hi", timeZone: "America/New_York" }),
    ).toEqual({
      content: "hi",
      timeZone: "America/New_York",
    });
  });

  it("drops unknown or missing zones instead of failing the message", () => {
    expect(
      sendMessageSchema.parse({ content: "hi", timeZone: "Mars/Olympus" }).timeZone,
    ).toBe(undefined);
    expect(sendMessageSchema.parse({ content: "hi" }).timeZone).toBe(undefined);
  });

  it("validates zones with Intl", () => {
    expect(isValidTimeZone("Asia/Kolkata")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("../etc/passwd")).toBe(false);
  });
});
