import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Response } from "express";

import { startKeepalive, streamOpenError } from "../src/controllers/chat.controller.js";
import { HttpError, ServiceUnavailableError } from "../src/errors.js";

/** Just enough of an Express response to record what gets written. */
function fakeResponse() {
  const writes: string[] = [];
  const res = Object.assign(new EventEmitter(), {
    writableEnded: false,
    write: (chunk: string) => {
      writes.push(chunk);
      return true;
    },
  });
  return {
    res: res as unknown as Response,
    writes,
    end: () => (res.writableEnded = true),
  };
}

describe("startKeepalive", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes an SSE comment on every interval until stopped", () => {
    vi.useFakeTimers();
    const { res, writes } = fakeResponse();

    const stop = startKeepalive(res, 1000);
    vi.advanceTimersByTime(3500);
    stop();
    vi.advanceTimersByTime(5000);

    expect(writes).toEqual([": keepalive\n\n", ": keepalive\n\n", ": keepalive\n\n"]);
  });

  it("stops writing once the response has ended", () => {
    vi.useFakeTimers();
    const { res, writes, end } = fakeResponse();

    const stop = startKeepalive(res, 1000);
    vi.advanceTimersByTime(1000);
    end();
    vi.advanceTimersByTime(3000);
    stop();

    expect(writes).toHaveLength(1);
  });
});

describe("streamOpenError", () => {
  it("shows the friendly unavailable message for a timeout or outage", () => {
    expect(
      streamOpenError(
        new ServiceUnavailableError(
          "chat_unavailable",
          "The AI analyst is unavailable right now.",
        ),
      ),
    ).toEqual({
      code: "chat_unavailable",
      message: "The AI analyst is unavailable right now. Please try again shortly.",
      retryable: true,
    });
  });

  it("keeps other gateway errors and hides unexpected ones", () => {
    expect(
      streamOpenError(new HttpError(422, "message_too_long", "Too long.")),
    ).toEqual({
      code: "message_too_long",
      message: "Too long.",
      retryable: false,
    });
    expect(streamOpenError(new Error("ECONNRESET 10.0.0.7"))).toMatchObject({
      code: "upstream_error",
      retryable: true,
    });
  });
});
