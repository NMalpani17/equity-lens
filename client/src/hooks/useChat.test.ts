import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/chatApi", () => ({ listMessages: vi.fn() }));

import { listMessages, type ChatMessage } from "@/lib/chatApi";
import { loadSettled } from "@/hooks/useChat";

const list = vi.mocked(listMessages);

function msg(id: string, status: ChatMessage["status"]): ChatMessage {
  return {
    id,
    role: id.startsWith("u") ? "user" : "assistant",
    content: "",
    status,
    citations: [],
    toolCalls: [],
    errorCode: null,
    createdAt: "2026-10-01T00:00:00.000Z",
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  list.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("loadSettled", () => {
  it("waits for the server to finish saving a stopped reply", async () => {
    list
      .mockResolvedValueOnce([msg("u1", "complete"), msg("a1", "streaming")])
      .mockResolvedValueOnce([msg("u1", "complete"), msg("a1", "interrupted")]);

    const settled = loadSettled("c1");
    await vi.advanceTimersByTimeAsync(300);

    expect((await settled).map((m) => m.status)).toEqual(["complete", "interrupted"]);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("never returns an endless 'streaming' reply", async () => {
    list.mockResolvedValue([msg("u1", "complete"), msg("a1", "streaming")]);

    const settled = loadSettled("c1");
    await vi.advanceTimersByTimeAsync(10_000);

    expect((await settled).at(-1)?.status).toBe("interrupted");
    expect(list).toHaveBeenCalledTimes(5); // first load + four bounded re-checks
  });

  it("waits for a just-stopped turn to appear", async () => {
    list
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([msg("u1", "complete"), msg("a1", "interrupted")]);

    const settled = loadSettled("c1", 0);
    await vi.advanceTimersByTimeAsync(300);

    expect(await settled).toHaveLength(2);
  });
});
