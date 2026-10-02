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
    chatUsageEvent: { count: vi.fn(), create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import { prisma } from "../src/db/prisma.js";
import {
  assertWithinLimits,
  beginRetry,
  beginTurn,
  buildHistory,
  finishTurn,
  getUsage,
  titleFromMessage,
  utcDayWindow,
} from "../src/services/chat.service.js";
import {
  ChatLimitError,
  NotFoundError,
  RetryNotAllowedError,
  TurnInProgressError,
} from "../src/errors.js";

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
  it("counts every turn (messages and retries) from the usage events", async () => {
    db.chatUsageEvent.count.mockResolvedValue(2);

    await getUsage(USER, false);

    expect(db.chatUsageEvent.count.mock.calls[0]![0]!.where).toMatchObject({
      userId: USER,
    });
  });

  it("reports usage with the demo limit for anonymous users", async () => {
    db.chatUsageEvent.count.mockResolvedValue(3);

    const usage = await getUsage(USER, true);

    expect(usage).toMatchObject({ used: 3, limit: 5, remaining: 2, isDemo: true });
  });

  it("blocks a signed-in user at 20 messages", async () => {
    db.chatUsageEvent.count.mockResolvedValueOnce(20);

    const error = await assertWithinLimits(USER, false).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ChatLimitError);
    expect(error).toMatchObject({ status: 429, details: { scope: "user", limit: 20 } });
  });

  it("blocks a demo user at 5 messages with a sign-up hint", async () => {
    db.chatUsageEvent.count.mockResolvedValueOnce(5);

    const error = (await assertWithinLimits(USER, true).catch(
      (e: unknown) => e,
    )) as Error;

    expect(error).toBeInstanceOf(ChatLimitError);
    expect(error.message).toContain("Demo accounts");
  });

  it("enforces the global daily cap", async () => {
    db.chatUsageEvent.count.mockResolvedValueOnce(1).mockResolvedValueOnce(60);

    const error = await assertWithinLimits(USER, false).catch((e: unknown) => e);

    expect(error).toMatchObject({
      code: "chat_limit_reached",
      details: { scope: "global" },
    });
  });

  it("allows a user under both caps", async () => {
    db.chatUsageEvent.count.mockResolvedValueOnce(4).mockResolvedValueOnce(30);

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
      chatUsageEvent: { create: vi.fn() },
    };
    db.$transaction.mockImplementation(((fn: (t: typeof tx) => unknown) =>
      fn(tx)) as never);

    const turn = await beginTurn(CONV, USER, "What did NVIDIA say?");

    const claim = db.chatConversation.updateMany.mock.calls[0]![0];
    expect(claim.where).toMatchObject({ id: CONV, userId: USER });
    expect(turn.conversation.title).toBe("What did NVIDIA say?");
    expect(turn.userMessage.id).toBe("u1");
    expect(turn.assistantMessageId).toBe("a1");
    expect(turn.question).toBe("What did NVIDIA say?");
    expect(tx.chatUsageEvent.create).toHaveBeenCalledWith({
      data: { userId: USER, kind: "message" },
    });
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

describe("retry", () => {
  const failed = message({
    id: "a2",
    role: "assistant",
    content: "Partial",
    status: "interrupted",
  });
  const question = message({ id: "u2", content: "What did NVIDIA say?" });
  const older = [
    message({ id: "a1", role: "assistant", content: "earlier answer" }),
    message({ id: "u1", content: "earlier question" }),
  ];

  function retryTx() {
    const tx = {
      chatMessage: { update: vi.fn(), create: vi.fn() },
      chatUsageEvent: { create: vi.fn() },
      chatConversation: {
        findUniqueOrThrow: vi.fn().mockResolvedValue(conversation("NVDA")),
      },
    };
    db.$transaction.mockImplementation(((fn: (t: typeof tx) => unknown) =>
      fn(tx)) as never);
    return tx;
  }

  beforeEach(() => {
    db.chatConversation.updateMany.mockResolvedValue({ count: 1 });
  });

  it("resets the same reply in place without a new user message", async () => {
    db.chatMessage.findMany.mockResolvedValue([failed, question, ...older] as never);
    const tx = retryTx();

    const turn = await beginRetry(CONV, USER, "a2");

    expect(turn.assistantMessageId).toBe("a2");
    expect(turn.question).toBe("What did NVIDIA say?");
    expect(turn.userMessage.id).toBe("u2");
    expect(tx.chatMessage.create).not.toHaveBeenCalled();
    expect(db.chatMessage.create).not.toHaveBeenCalled();
    expect(tx.chatMessage.update.mock.calls[0]![0]).toMatchObject({
      where: { id: "a2" },
      data: { content: "", status: "streaming", citations: [], errorCode: null },
    });
    expect(tx.chatUsageEvent.create).toHaveBeenCalledWith({
      data: { userId: USER, kind: "retry" },
    });
  });

  it("sends clean history: no repeated question and no failed attempt", async () => {
    db.chatMessage.findMany.mockResolvedValue([
      failed,
      question,
      ...older,
      message({ id: "a0", role: "assistant", content: "boom", status: "error" }),
      message({ id: "u0", content: "first question" }),
    ] as never);
    retryTx();

    const turn = await beginRetry(CONV, USER, "a2");

    expect(turn.history).toEqual([
      { role: "user", content: "first question" },
      { role: "user", content: "earlier question" },
      { role: "assistant", content: "earlier answer" },
    ]);
  });

  it.each([
    ["an older reply", [failed, question, ...older], "a1"],
    [
      "a completed reply",
      [{ ...failed, status: "complete" }, question, ...older],
      "a2",
    ],
    ["a user message", [question, ...older], "u2"],
    ["a reply with no question before it", [failed], "a2"],
  ])("refuses to retry %s and releases the lock", async (_label, rows, id) => {
    db.chatMessage.findMany.mockResolvedValue(rows as never);

    await expect(beginRetry(CONV, USER, id)).rejects.toBeInstanceOf(
      RetryNotAllowedError,
    );
    expect(db.$transaction).not.toHaveBeenCalled();
    const release = db.chatConversation.updateMany.mock.calls.at(-1)![0];
    expect(release.data).toEqual({ activeTurnId: null, activeTurnStartedAt: null });
  });

  it("rejects a retry while another turn is streaming", async () => {
    db.chatConversation.updateMany.mockResolvedValue({ count: 0 });
    db.chatConversation.findFirst.mockResolvedValue(conversation() as never);

    await expect(beginRetry(CONV, USER, "a2")).rejects.toBeInstanceOf(
      TurnInProgressError,
    );
  });
});
