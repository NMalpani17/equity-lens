import { describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";
import { bannerForError } from "@/lib/chatErrors";

describe("bannerForError", () => {
  it("words generic failures for what the user was doing, without status codes", () => {
    const invalid = new ApiError(422, "invalid message id", "validation_error");

    expect(bannerForError(invalid, "retry").message).toBe(
      "Couldn't retry that message. Please try again.",
    );
    expect(bannerForError(invalid, "send").message).toBe(
      "Couldn't send your message. Please try again.",
    );
    expect(bannerForError(new ApiError(500, "boom"), "load").message).toBe(
      "Couldn't load your conversations. Please try again.",
    );
    expect(bannerForError(new Error("x"), "retry").message).not.toMatch(/\d{3}/);
  });

  it("explains known situations", () => {
    expect(
      bannerForError(new ApiError(409, "busy", "turn_in_progress"), "send"),
    ).toMatchObject({ kind: "busy" });
    expect(
      bannerForError(
        new ApiError(
          429,
          "You've reached today's limit of 5 messages.",
          "chat_limit_reached",
        ),
        "send",
      ),
    ).toEqual({
      kind: "limit",
      message:
        "You've reached today's limit of 5 messages. Please try again after the daily reset.",
    });
    expect(bannerForError(new ApiError(0, "x"), "send").message).toMatch(
      /Couldn't reach Equity Lens/,
    );
    expect(
      bannerForError(new ApiError(503, "x", "chat_unavailable"), "retry").message,
    ).toMatch(/unavailable right now/);
  });
});

describe("daily limit banner", () => {
  it("shows the reset time on the user's clock, never in UTC", () => {
    const resetsAt = "2026-10-02T00:00:00.000Z";
    const limit = new ApiError(
      429,
      "You've reached today's limit of 20 messages.",
      "chat_limit_reached",
      { scope: "user", limit: 20, resetsAt },
    );

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T15:00:00.000Z"));
    const { kind, message } = bannerForError(limit, "send");
    vi.useRealTimers();

    // Tests run in America/New_York (vitest.config.ts): midnight UTC is 8 PM EDT.
    expect(kind).toBe("limit");
    expect(message).toBe(
      "You've reached today's limit of 20 messages. It resets at 8:00 PM EDT.",
    );
  });
});
