import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: { access_token: "t" } } }) },
  },
}));

import { browserTimeZone, streamMessage } from "@/lib/chatApi";

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
