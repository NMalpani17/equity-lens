import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: { access_token: "t" } } }) },
  },
}));

import { API_URL, ApiError } from "@/lib/api";
import { browserTimeZone, streamMessage, streamRetry } from "@/lib/chatApi";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("streamMessage", () => {
  it("sends the message with the browser's time zone", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("event: done\ndata: {}\n\n", { status: 200 }));

    await streamMessage("c1", "hi", () => {});

    const body = JSON.parse(String(fetchSpy.mock.calls[0]![1]?.body));
    expect(body).toEqual({ content: "hi", timeZone: browserTimeZone() });
    expect(typeof body.timeZone).toBe("string");
  });
});

describe("streamRetry", () => {
  const SAVED_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";

  it("posts exactly what the API's retry route expects", async () => {
    // Kept in step with api/tests/chat.routes.test.ts ("what the browser client
    // actually sends"): URL with the saved reply id, headers and body.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("event: done\ndata: {}\n\n", { status: 200 }));

    await streamRetry("c1", SAVED_ID, () => {});

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(`${API_URL}/api/conversations/c1/messages/${SAVED_ID}/retry`);
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Authorization: "Bearer t",
    });
    expect(JSON.parse(String(init?.body))).toEqual({ timeZone: browserTimeZone() });
  });

  it("never surfaces a bare status code", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<html>bad gateway</html>", { status: 502 }),
    );

    const error = await streamRetry("c1", SAVED_ID, () => {}).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(502);
    expect((error as ApiError).message).toBe("Something went wrong. Please try again.");
  });
});
