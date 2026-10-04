import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { API_URL } from "./api";
import { resetWarmUp, warmUp } from "./warmUp";

describe("warmUp", () => {
  beforeEach(() => resetWarmUp());
  afterEach(() => vi.restoreAllMocks());

  it("asks the API to wake the ai-service with the session token, without waiting", () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockReturnValue(new Promise<Response>(() => {})); // never settles

    const result = warmUp("access-token");

    expect(result).toBeUndefined(); // nothing for the app to await
    expect(fetchSpy).toHaveBeenCalledWith(`${API_URL}/api/warmup`, {
      method: "POST",
      keepalive: true,
      headers: { Authorization: "Bearer access-token" },
    });
  });

  it("asks at most once a minute", () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockReturnValue(new Promise<Response>(() => {}));
    let clock = 0;

    warmUp("t", () => clock);
    clock = 59_000;
    warmUp("t", () => clock);
    clock = 60_000;
    warmUp("t", () => clock);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("swallows network errors", async () => {
    vi.spyOn(globalThis, "fetch").mockReturnValue(
      Promise.reject(new TypeError("Failed to fetch")),
    );
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    expect(() => warmUp("t")).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 10));

    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});
