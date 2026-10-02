import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

// Route tests: auth, validation, status codes and SSE relay, with the
// conversation store and the ai-service stream mocked.
vi.mock("../src/services/chat.service.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/services/chat.service.js")>();
  return {
    ...actual,
    listConversations: vi.fn(),
    createConversation: vi.fn(),
    renameConversation: vi.fn(),
    deleteConversation: vi.fn(),
    listMessages: vi.fn(),
    getUsage: vi.fn(),
    assertWithinLimits: vi.fn(),
    beginTurn: vi.fn(),
    finishTurn: vi.fn(),
  };
});
vi.mock("../src/services/chatStream.service.js", () => ({ openChatStream: vi.fn() }));
vi.mock("../src/services/portfolio.service.js", () => ({
  getPortfolioSummary: vi.fn(),
}));
vi.mock("../src/auth/verifyToken.js", () => ({ verifySupabaseToken: vi.fn() }));

import { createApp } from "../src/app.js";
import * as chatService from "../src/services/chat.service.js";
import {
  openChatStream,
  type AiChatEvent,
} from "../src/services/chatStream.service.js";
import { getPortfolioSummary } from "../src/services/portfolio.service.js";
import { verifySupabaseToken } from "../src/auth/verifyToken.js";
import {
  ChatLimitError,
  NotFoundError,
  ServiceUnavailableError,
  TurnInProgressError,
} from "../src/errors.js";

const app = createApp();
const service = vi.mocked(chatService);
const openStream = vi.mocked(openChatStream);
const verifyToken = vi.mocked(verifySupabaseToken);

const USER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CONV = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const AUTH = "Bearer test-token";
const post = (path: string) => request(app).post(path).set("Authorization", AUTH);
const get = (path: string) => request(app).get(path).set("Authorization", AUTH);

const conversation = {
  id: CONV,
  title: "New chat",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};
const userMessage = {
  id: "u1",
  role: "user" as const,
  content: "What did NVDA say?",
  status: "complete" as const,
  citations: [],
  toolCalls: [],
  errorCode: null,
  createdAt: "2026-10-01T00:00:00.000Z",
};

async function* stream(...events: AiChatEvent[]) {
  for (const event of events) yield event;
}

function parseSse(text: string) {
  return text
    .trim()
    .split("\n\n")
    .map((frame) => {
      const lines = frame.split("\n");
      return {
        event: lines[0]!.replace("event: ", ""),
        data: JSON.parse(lines[1]!.replace("data: ", "")) as Record<string, unknown>,
      };
    });
}

beforeEach(() => {
  vi.clearAllMocks();
  verifyToken.mockResolvedValue({ userId: USER, isAnonymous: false });
  service.assertWithinLimits.mockResolvedValue(undefined);
  service.beginTurn.mockResolvedValue({
    turnId: "turn-1",
    conversation,
    userMessage,
    assistantMessageId: "a1",
    history: [{ role: "user", content: "earlier" }],
  });
  service.finishTurn.mockImplementation(async (_c, _t, id, outcome) => ({
    ...userMessage,
    id,
    role: "assistant",
    content: outcome.content,
    status: outcome.status,
    errorCode: outcome.errorCode ?? null,
  }));
  vi.mocked(getPortfolioSummary).mockResolvedValue({
    positions: [],
    totals: {
      marketValue: 0,
      costBasis: 0,
      gainLoss: 0,
      gainLossPercent: 0,
      dailyChange: 0,
      pricedCount: 0,
      unpricedCount: 0,
      partial: false,
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("conversations", () => {
  it("requires authentication", async () => {
    const res = await request(app).get("/api/conversations");

    expect(res.status).toBe(401);
    expect(service.listConversations).not.toHaveBeenCalled();
  });

  it("lists, creates, renames and deletes", async () => {
    service.listConversations.mockResolvedValue([conversation]);
    service.createConversation.mockResolvedValue(conversation);
    service.renameConversation.mockResolvedValue({ ...conversation, title: "NVDA" });
    service.deleteConversation.mockResolvedValue(undefined);

    expect((await get("/api/conversations")).body).toEqual([conversation]);
    expect((await post("/api/conversations").send({})).status).toBe(201);
    const renamed = await request(app)
      .patch(`/api/conversations/${CONV}`)
      .set("Authorization", AUTH)
      .send({ title: " NVDA " });
    expect(renamed.body.title).toBe("NVDA");
    expect(service.renameConversation).toHaveBeenCalledWith(CONV, USER, "NVDA");
    const deleted = await request(app)
      .delete(`/api/conversations/${CONV}`)
      .set("Authorization", AUTH);
    expect(deleted.status).toBe(204);
  });

  it("validates ids and titles", async () => {
    expect((await get("/api/conversations/not-a-uuid/messages")).status).toBe(422);
    const blank = await request(app)
      .patch(`/api/conversations/${CONV}`)
      .set("Authorization", AUTH)
      .send({ title: "   " });
    expect(blank.status).toBe(422);
  });

  it("returns 404 for another user's conversation", async () => {
    service.listMessages.mockRejectedValue(new NotFoundError("conversation not found"));

    expect((await get(`/api/conversations/${CONV}/messages`)).status).toBe(404);
  });

  it("reports usage with the demo flag", async () => {
    verifyToken.mockResolvedValue({ userId: USER, isAnonymous: true });
    service.getUsage.mockResolvedValue({
      used: 2,
      limit: 5,
      remaining: 3,
      resetsAt: "2026-10-02T00:00:00.000Z",
      isDemo: true,
    });

    const res = await get("/api/chat/usage");

    expect(res.body.remaining).toBe(3);
    expect(service.getUsage).toHaveBeenCalledWith(USER, true);
  });
});

describe("POST /api/conversations/:id/messages", () => {
  it("streams the turn and saves the final answer", async () => {
    openStream.mockResolvedValue(
      stream(
        {
          type: "tool_start",
          id: "t1",
          name: "search_transcripts",
          label: "Searching NVDA transcripts…",
          args: { ticker: "NVDA" },
        },
        {
          type: "tool_end",
          id: "t1",
          name: "search_transcripts",
          ok: true,
          summary: "Found 5",
        },
        { type: "token", text: "Demand is strong [1]." },
        {
          type: "done",
          content: "Demand is strong [1].",
          status: "complete",
          citations: [],
          toolCalls: [],
          inputTokens: 10,
          outputTokens: 5,
          model: "m",
        },
      ),
    );

    const res = await post(`/api/conversations/${CONV}/messages`).send({
      content: "What did NVDA say?",
    });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    const events = parseSse(res.text);
    expect(events.map((e) => e.event)).toEqual([
      "turn",
      "tool_start",
      "tool_end",
      "token",
      "done",
    ]);
    expect(events[0]!.data).toMatchObject({ assistantMessageId: "a1" });
    expect(events.at(-1)!.data).toMatchObject({
      message: { id: "a1", content: "Demand is strong [1].", status: "complete" },
    });
    const upstream = openStream.mock.calls[0]![0];
    expect(upstream).toMatchObject({
      userId: USER,
      isAnonymous: false,
      conversationId: CONV,
      history: [{ role: "user", content: "earlier" }],
    });
    expect(service.finishTurn).toHaveBeenCalledWith(
      CONV,
      "turn-1",
      "a1",
      expect.objectContaining({ status: "complete", inputTokens: 10 }),
    );
  });

  it("forwards the browser's time zone to the ai-service", async () => {
    openStream.mockResolvedValue(
      stream({
        type: "done",
        content: "ok",
        status: "complete",
        citations: [],
        toolCalls: [],
        inputTokens: 1,
        outputTokens: 1,
        model: "m",
      }),
    );

    await post(`/api/conversations/${CONV}/messages`).send({
      content: "hi",
      timeZone: "Europe/Berlin",
    });

    expect(openStream.mock.calls[0]![0]).toMatchObject({ timeZone: "Europe/Berlin" });
  });

  it("rejects messages over the length limit before doing anything", async () => {
    const res = await post(`/api/conversations/${CONV}/messages`).send({
      content: "x".repeat(2001),
    });

    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain("limited to 2000 characters");
    expect(service.beginTurn).not.toHaveBeenCalled();
  });

  it("returns 429 when the daily cap is reached", async () => {
    service.assertWithinLimits.mockRejectedValue(
      new ChatLimitError(
        "user",
        20,
        "2026-10-02T00:00:00.000Z",
        "You've reached today's limit",
      ),
    );

    const res = await post(`/api/conversations/${CONV}/messages`).send({
      content: "hi",
    });

    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({
      error: "chat_limit_reached",
      scope: "user",
      limit: 20,
    });
    expect(service.beginTurn).not.toHaveBeenCalled();
  });

  it("returns 409 when a turn is already streaming", async () => {
    service.beginTurn.mockRejectedValue(new TurnInProgressError());

    const res = await post(`/api/conversations/${CONV}/messages`).send({
      content: "again",
    });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("turn_in_progress");
    expect(openStream).not.toHaveBeenCalled();
  });

  it("saves an error and returns 503 when the ai-service is unavailable", async () => {
    openStream.mockRejectedValue(
      new ServiceUnavailableError(
        "chat_unavailable",
        "The AI analyst is unavailable right now.",
      ),
    );

    const res = await post(`/api/conversations/${CONV}/messages`).send({
      content: "hi",
    });

    expect(res.status).toBe(503);
    expect(service.finishTurn).toHaveBeenCalledWith(
      CONV,
      "turn-1",
      "a1",
      expect.objectContaining({ status: "error", errorCode: "chat_unavailable" }),
    );
  });

  it("relays upstream errors as an error event plus the saved message", async () => {
    openStream.mockResolvedValue(
      stream({
        type: "error",
        code: "ai_credits_exhausted",
        message: "The AI analyst is out of credits right now.",
        retryable: false,
      }),
    );

    const res = await post(`/api/conversations/${CONV}/messages`).send({
      content: "hi",
    });

    const events = parseSse(res.text);
    expect(events.map((e) => e.event)).toEqual(["turn", "error", "done"]);
    expect(events[1]!.data).toMatchObject({
      code: "ai_credits_exhausted",
      retryable: false,
    });
    expect(events[2]!.data).toMatchObject({ message: { status: "error" } });
  });

  it("aborts upstream and saves the partial reply when the client disconnects", async () => {
    let upstreamSignal: AbortSignal | undefined;
    openStream.mockImplementation(async (_req, signal) => {
      upstreamSignal = signal;
      return (async function* () {
        yield { type: "token", text: "Demand was " } as AiChatEvent;
        yield { type: "token", text: "strong" } as AiChatEvent;
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve()),
        );
        throw new Error("upstream aborted");
      })();
    });
    const server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    const controller = new AbortController();
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/api/conversations/${CONV}/messages`,
        {
          method: "POST",
          headers: { Authorization: AUTH, "Content-Type": "application/json" },
          body: JSON.stringify({ content: "What did NVDA say?" }),
          signal: controller.signal,
        },
      );
      const reader = res.body!.getReader();
      let received = "";
      while (!received.includes("strong")) {
        const { value } = await reader.read();
        received += new TextDecoder().decode(value);
      }
      controller.abort(); // the user closed the tab

      await vi.waitFor(() => expect(service.finishTurn).toHaveBeenCalled(), {
        timeout: 2000,
      });
    } finally {
      server.close();
    }

    expect(upstreamSignal?.aborted).toBe(true);
    expect(service.finishTurn).toHaveBeenCalledWith(CONV, "turn-1", "a1", {
      content: "Demand was strong",
      status: "interrupted",
      toolCalls: [],
    });
  });
});
