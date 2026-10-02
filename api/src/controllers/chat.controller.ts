/** AI analyst chat controller (HTTP layer). */
import type { Request, Response } from "express";

import * as chatService from "../services/chat.service.js";
import { openChatStream } from "../services/chatStream.service.js";
import {
  loadPortfolioSnapshot,
  relayEvents,
  type EventSink,
} from "../services/chatTurn.service.js";
import { getUserId, isAnonymousRequest } from "../middleware/auth.js";
import { HttpError } from "../errors.js";
import { logger } from "../logger.js";
import {
  conversationIdSchema,
  createConversationSchema,
  messageIdSchema,
  renameConversationSchema,
  retryMessageSchema,
  sendMessageSchema,
} from "../schemas/chat.schema.js";
import type { TurnStart } from "../services/chat.service.js";
import type { PortfolioSummary } from "../types.js";

export async function listConversations(req: Request, res: Response): Promise<void> {
  res.status(200).json(await chatService.listConversations(getUserId(req)));
}

export async function createConversation(req: Request, res: Response): Promise<void> {
  const { title } = createConversationSchema.parse(req.body ?? {});
  res.status(201).json(await chatService.createConversation(getUserId(req), title));
}

export async function renameConversation(req: Request, res: Response): Promise<void> {
  const id = conversationIdSchema.parse(req.params.id);
  const { title } = renameConversationSchema.parse(req.body);
  res.status(200).json(await chatService.renameConversation(id, getUserId(req), title));
}

export async function deleteConversation(req: Request, res: Response): Promise<void> {
  const id = conversationIdSchema.parse(req.params.id);
  await chatService.deleteConversation(id, getUserId(req));
  res.status(204).end();
}

export async function listMessages(req: Request, res: Response): Promise<void> {
  const id = conversationIdSchema.parse(req.params.id);
  res.status(200).json(await chatService.listMessages(id, getUserId(req)));
}

export async function getUsage(req: Request, res: Response): Promise<void> {
  res
    .status(200)
    .json(await chatService.getUsage(getUserId(req), isAnonymousRequest(req)));
}

function sseSink(res: Response): EventSink {
  return {
    send(event, data) {
      if (!res.writableEnded) {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    },
  };
}

/** Timing marks for one turn, logged with its outcome. */
function turnTimer() {
  const started = performance.now();
  const timings: Record<string, number> = {};
  return {
    timings,
    mark(stage: string) {
      timings[stage] = Math.round(performance.now() - started);
    },
  };
}

interface TurnContext {
  userId: string;
  isAnonymous: boolean;
  conversationId: string;
  timeZone?: string;
  turn: TurnStart;
  portfolioPromise: Promise<PortfolioSummary | null>;
  timer: ReturnType<typeof turnTimer>;
}

/**
 * Send a message and stream the reply as server-sent events.
 *
 * Errors before streaming starts (validation, caps, 409 overlap, upstream
 * unavailable) are normal JSON errors. Once streaming, the client receives
 * `turn`, then `token` / `tool_start` / `tool_progress` / `tool_end`, then
 * `error` (if any) and `done` with the saved assistant message.
 */
export async function sendMessage(req: Request, res: Response): Promise<void> {
  const userId = getUserId(req);
  const isAnonymous = isAnonymousRequest(req);
  const conversationId = conversationIdSchema.parse(req.params.id);
  const { content, timeZone } = sendMessageSchema.parse(req.body);
  const timer = turnTimer();

  await chatService.assertWithinLimits(userId, isAnonymous);
  timer.mark("limitsMs");
  // The portfolio snapshot is independent of claiming the turn, so load it
  // concurrently (it never rejects; failures become a null snapshot).
  const portfolioPromise = loadPortfolioSnapshot(userId);
  const turn = await chatService.beginTurn(conversationId, userId, content);
  timer.mark("beginTurnMs");
  await streamTurn(res, {
    userId,
    isAnonymous,
    conversationId,
    timeZone,
    turn,
    portfolioPromise,
    timer,
  });
}

/**
 * Regenerate the latest stopped/failed reply in place. Same SSE contract as
 * sendMessage; no new user message is created and the same assistant
 * message id is reused.
 */
export async function retryMessage(req: Request, res: Response): Promise<void> {
  const userId = getUserId(req);
  const isAnonymous = isAnonymousRequest(req);
  const conversationId = conversationIdSchema.parse(req.params.id);
  const messageId = messageIdSchema.parse(req.params.messageId);
  const { timeZone } = retryMessageSchema.parse(req.body ?? {});
  const timer = turnTimer();

  await chatService.assertWithinLimits(userId, isAnonymous);
  timer.mark("limitsMs");
  const portfolioPromise = loadPortfolioSnapshot(userId);
  const turn = await chatService.beginRetry(conversationId, userId, messageId);
  timer.mark("beginTurnMs");
  await streamTurn(res, {
    userId,
    isAnonymous,
    conversationId,
    timeZone,
    turn,
    portfolioPromise,
    timer,
  });
}

async function streamTurn(res: Response, ctx: TurnContext): Promise<void> {
  const { userId, isAnonymous, conversationId, timeZone, turn, timer } = ctx;
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abort.abort(); // the client went away mid-stream
  });

  let events;
  try {
    const portfolio = await ctx.portfolioPromise;
    timer.mark("portfolioMs");
    events = await openChatStream(
      {
        userId,
        isAnonymous,
        conversationId,
        message: turn.question,
        history: turn.history,
        portfolio,
        timeZone,
      },
      abort.signal,
    );
  } catch (error) {
    await chatService.finishTurn(conversationId, turn.turnId, turn.assistantMessageId, {
      content: "",
      status: abort.signal.aborted ? "interrupted" : "error",
      errorCode: error instanceof HttpError ? error.code : "upstream_error",
    });
    if (abort.signal.aborted) return;
    throw error;
  }

  timer.mark("upstreamOpenMs");
  res.status(200).set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  const sink = sseSink(res);
  sink.send("turn", {
    conversation: turn.conversation,
    userMessage: turn.userMessage,
    assistantMessageId: turn.assistantMessageId,
  });

  const result = await relayEvents(events, sink, abort.signal);
  timer.mark("relayMs");
  try {
    const saved = await chatService.finishTurn(
      conversationId,
      turn.turnId,
      turn.assistantMessageId,
      result.outcome,
    );
    if (result.kind === "error") sink.send("error", result.error);
    sink.send("done", { message: saved });
  } catch (error) {
    logger.error({ err: error }, "failed to save chat turn");
    sink.send("error", {
      code: "save_failed",
      message: "The reply couldn't be saved. Please try again.",
      retryable: true,
    });
  } finally {
    if (!res.writableEnded) res.end();
    timer.mark("totalMs");
    logger.info(
      {
        event: "chat_turn",
        conversationId,
        outcome: result.kind,
        status: result.outcome.status,
        toolCalls: result.outcome.toolCalls?.length ?? 0,
        ...timer.timings,
      },
      "chat turn",
    );
  }
}
