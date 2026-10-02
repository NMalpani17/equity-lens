import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/db/prisma.js", () => ({
  prisma: {
    chatConversation: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    chatMessage: {
      count: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

import { prisma } from "../src/db/prisma.js";
import {
  assertWithinLimits,
  beginTurn,
  buildHistory,
  finishTurn,
  getUsage,
  titleFromMessage,
  utcDayWindow,
} from "../src/services/chat.service.js";
import { ChatLimitError, NotFoundError, TurnInProgressError } from "../src/errors.js";

const db = vi.mocked(prisma, true);
const USER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CONV = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const NOW = new Date("2026-10-01T15:00:00.000Z");

function conversation(title = "New chat") {
  return {
    id: CONV,
    userId: USER,
    title,
    activeTurnId: null,
    activeTurnStartedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function message(overrides: Record<string, unknown> = {}) {
  return {
    id: "m1",
    conversationId: CONV,
    userId: USER,
    role: "user",
    content: "hi",
    status: "complete",
    citations: [],
    toolCalls: [],
    errorCode: null,
    inputTokens: null,
    outputTokens: null,
    model: null,
    createdAt: NOW,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("helpers", () => {
  it("computes the UTC day window", () => {
    const { start, resetsAt } = utcDayWindow(NOW);

    expect(start.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(resetsAt.toISOString()).toBe("2026-10-02T00:00:00.000Z");
  });

  it("titles a conversation from its first message", () => {
    expect(titleFromMessage("  What did   NVIDIA say? ")).toBe("What did NVIDIA say?");
    const long = titleFromMessage("x".repeat(100));
    expect(long).toHaveLength(60);
    expect(long.endsWith("…")).toBe(true);
  });

  it("builds history from final messages within the budgets", () => {
    const messages = Array.from({ length: 10 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `message ${i} `.repeat(20),
    }));

    const history = buildHistory(messages, 6, 3000);
    const tight = buildHistory(messages, 6, 60);

    expect(history).toHaveLength(6);
    expect(history[0]?.role).toBe("user");
    expect(history.at(-1)?.content).toContain("message 9");
    expect(tight.length).toBeLessThanOrEqual(2);
    expect(tight[0]?.role ?? "user").toBe("user");
  });
});

describe("limits", () => {
  it("reports usage with the demo limit for anonymous users", async () => {
    db.chatMessage.count.mockResolvedValue(3);

    const usage = await getUsage(USER, true);

    expect(usage).toMatchObject({ used: 3, limit: 5, remaining: 2, isDemo: true });
  });

  it("blocks a signed-in user at 20 messages", async () => {
    db.chatMessage.count.mockResolvedValueOnce(20);

    const error = await assertWithinLimits(USER, false).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ChatLimitError);
    expect(error).toMatchObject({ status: 429, details: { scope: "user", limit: 20 } });
  });

  it("blocks a demo user at 5 messages with a sign-up hint", async () => {
    db.chatMessage.count.mockResolvedValueOnce(5);

    const error = (await assertWithinLimits(USER, true).catch(
      (e: unknown) => e,
    )) as Error;

    expect(error).toBeInstanceOf(ChatLimitError);
    expect(error.message).toContain("Demo accounts");
  });

  it("enforces the global daily cap", async () => {
    db.chatMessage.count.mockResolvedValueOnce(1).mockResolvedValueOnce(60);

    const error = await assertWithinLimits(USER, false).catch((e: unknown) => e);

    expect(error).toMatchObject({
      code: "chat_limit_reached",
      details: { scope: "global" },
    });
  });

  it("allows a user under both caps", async () => {
    db.chatMessage.count.mockResolvedValueOnce(4).mockResolvedValueOnce(30);

    await expect(assertWithinLimits(USER, false)).resolves.toBeUndefined();
  });
});

describe("turns", () => {
  it("claims the conversation, saves messages and titles a new chat", async () => {
    db.chatConversation.updateMany.mockResolvedValue({ count: 1 });
    db.chatMessage.findMany.mockResolvedValue([
      { role: "assistant", content: "earlier answer" },
      { role: "user", content: "earlier question" },
    ] as never);
    const tx = {
      chatConversation: {
        findUniqueOrThrow: vi.fn().mockResolvedValue(conversation()),
        update: vi.fn().mockResolvedValue(conversation("What did NVIDIA say?")),
      },
      chatMessage: {
        create: vi
          .fn()
          .mockResolvedValueOnce(message({ id: "u1", content: "What did NVIDIA say?" }))
          .mockResolvedValueOnce(
            message({ id: "a1", role: "assistant", status: "streaming" }),
          ),
      },
    };
    db.$transaction.mockImplementation(((fn: (t: typeof tx) => unknown) =>
      fn(tx)) as never);

    const turn = await beginTurn(CONV, USER, "What did NVIDIA say?");

    const claim = db.chatConversation.updateMany.mock.calls[0]![0];
    expect(claim.where).toMatchObject({ id: CONV, userId: USER });
    expect(turn.conversation.title).toBe("What did NVIDIA say?");
    expect(turn.userMessage.id).toBe("u1");
    expect(turn.assistantMessageId).toBe("a1");
    expect(turn.history).toEqual([
      { role: "user", content: "earlier question" },
      { role: "assistant", content: "earlier answer" },
    ]);
    const historyQuery = db.chatMessage.findMany.mock.calls[0]![0];
    expect(JSON.stringify(historyQuery?.where)).toContain(
      '"status":{"in":["complete","truncated"]}',
    );
  });

  it("rejects an overlapping turn with 409", async () => {
    db.chatConversation.updateMany.mockResolvedValue({ count: 0 });
    db.chatConversation.findFirst.mockResolvedValue(conversation() as never);

    await expect(beginTurn(CONV, USER, "again")).rejects.toBeInstanceOf(
      TurnInProgressError,
    );
    expect(db.chatMessage.create).not.toHaveBeenCalled();
  });

  it("returns 404 for someone else's conversation", async () => {
    db.chatConversation.updateMany.mockResolvedValue({ count: 0 });
    db.chatConversation.findFirst.mockResolvedValue(null);

    await expect(beginTurn(CONV, USER, "hi")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("saves the outcome and releases only this turn's lock", async () => {
    db.chatMessage.update.mockReturnValue(
      message({
        id: "a1",
        role: "assistant",
        content: "Answer [1]",
        status: "complete",
      }) as never,
    );
    db.chatConversation.updateMany.mockReturnValue({ count: 1 } as never);
    db.$transaction.mockImplementation(((ops: unknown[]) => Promise.all(ops)) as never);

    const saved = await finishTurn(CONV, "turn-1", "a1", {
      content: "Answer [1]",
      status: "complete",
      citations: [{ id: 1 }],
      inputTokens: 100,
      outputTokens: 20,
    });

    expect(saved).toMatchObject({ id: "a1", status: "complete" });
    expect(db.chatMessage.update.mock.calls[0]![0].data).toMatchObject({
      status: "complete",
      citations: [{ id: 1 }],
      inputTokens: 100,
    });
    expect(db.chatConversation.updateMany.mock.calls[0]![0].where).toEqual({
      id: CONV,
      activeTurnId: "turn-1",
    });
  });
});
