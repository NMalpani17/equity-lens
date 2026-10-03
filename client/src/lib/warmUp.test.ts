import { afterEach, describe, expect, it, vi } from "vitest";

import { API_URL, warmUp } from "./api";

describe("warmUp", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("asks the API to wake the ai-service without waiting for it", () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockReturnValue(new Promise<Response>(() => {})); // never settles

    const result = warmUp();

    expect(result).toBeUndefined(); // nothing for the app to await
    expect(fetchSpy).toHaveBeenCalledWith(`${API_URL}/api/warmup`, {
      method: "POST",
      keepalive: true,
    });
  });

  it("swallows network errors", async () => {
    const failed = Promise.reject(new TypeError("Failed to fetch"));
    vi.spyOn(globalThis, "fetch").mockReturnValue(failed);
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    expect(() => warmUp()).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 10));

    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("fires once when the app starts", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockReturnValue(new Promise<Response>(() => {}));
    document.body.innerHTML = '<div id="root"></div>';
    vi.resetModules();

    await import("@/main");

    const warmups = fetchSpy.mock.calls.filter(([url]) =>
      String(url).endsWith("/api/warmup"),
    );
    expect(warmups).toHaveLength(1);
  });
});
