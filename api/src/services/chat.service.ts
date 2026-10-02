/**
 * Chat conversations: CRUD, daily caps, the per-conversation turn lock, the
 * history sent to the model, and persisting finished turns.
 *
 * Every query is scoped to the authenticated user's id.
 */
import { randomUUID } from "node:crypto";

import { Prisma, type ChatMessage, type ChatMessageStatus } from "@prisma/client";

import { config } from "../config.js";
import { prisma } from "../db/prisma.js";
import {
  ChatLimitError,
  NotFoundError,
  RetryNotAllowedError,
  TurnInProgressError,
} from "../errors.js";

const DEFAULT_TITLE = "New chat";
const TITLE_FROM_MESSAGE_CHARS = 60;
/** A turn lock older than this is assumed abandoned (e.g. a crashed process). */
const STALE_TURN_MS = 3 * 60 * 1000;
/** Statuses whose assistant content is a final answer worth sending as context. */
const CONTEXT_STATUSES: ChatMessageStatus[] = ["complete", "truncated"];
/** Assistant replies that can be regenerated in place. */
const RETRYABLE_STATUSES: ChatMessageStatus[] = ["interrupted", "error"];

// A question and its reply are created in one transaction and can share a
// timestamp; the chat_role enum orders user before assistant, so the role
// breaks ties.
const MESSAGE_ORDER_ASC: Prisma.ChatMessageOrderByWithRelationInput[] = [
  { createdAt: "asc" },
  { role: "asc" },
];
const MESSAGE_ORDER_DESC: Prisma.ChatMessageOrderByWithRelationInput[] = [
  { createdAt: "desc" },
  { role: "desc" },
];

export interface ConversationDto {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessageDto {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: ChatMessageStatus;
  citations: unknown[];
  charts: unknown[];
  toolCalls: unknown[];
  errorCode: string | null;
  createdAt: string;
}

export interface ChatUsage {
  used: number;
  limit: number;
  remaining: number;
  resetsAt: string;
  isDemo: boolean;
}

export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export interface TurnStart {
  turnId: string;
  /** The question to answer (the new message, or the one being retried). */
  question: string;
  conversation: ConversationDto;
  userMessage: ChatMessageDto;
  assistantMessageId: string;
  history: HistoryMessage[];
}

export interface TurnOutcome {
  content: string;
  status: ChatMessageStatus;
  citations?: unknown[];
  charts?: unknown[];
  toolCalls?: unknown[];
  errorCode?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  model?: string | null;
}

function toConversationDto(c: {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
}): ConversationDto {
  return {
    id: c.id,
    title: c.title,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

export function toMessageDto(m: ChatMessage): ChatMessageDto {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    status: m.status,
    citations: Array.isArray(m.citations) ? m.citations : [],
    charts: Array.isArray(m.charts) ? m.charts : [],
    toolCalls: Array.isArray(m.toolCalls) ? m.toolCalls : [],
    errorCode: m.errorCode,
    createdAt: m.createdAt.toISOString(),
  };
}

/** Start of the current UTC day and the next reset. */
export function utcDayWindow(now = new Date()): { start: Date; resetsAt: Date } {
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  return { start, resetsAt: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

/** Title for a new conversation, from its first message. */
export function titleFromMessage(content: string): string {
  const flat = content.replace(/\s+/g, " ").trim();
  return flat.length <= TITLE_FROM_MESSAGE_CHARS
    ? flat
    : `${flat.slice(0, TITLE_FROM_MESSAGE_CHARS - 1).trimEnd()}…`;
}

/**
 * Newest final messages within the message and (estimated) token budget,
 * oldest first, starting with a user message.
 */
export function buildHistory(
  messages: Pick<ChatMessage, "role" | "content">[],
  maxMessages = config.chat.historyMessages,
  maxTokens = config.chat.historyTokens,
): HistoryMessage[] {
  let budget = maxTokens * 4; // ~4 characters per token
  const kept: HistoryMessage[] = [];
  for (const message of messages.slice(-maxMessages).reverse()) {
    const content = message.content.trim();
    if (!content) continue;
    if (content.length > budget) break;
    budget -= content.length;
    kept.unshift({ role: message.role, content });
  }
  while (kept[0] && kept[0].role !== "user") kept.shift();
  return kept;
}

async function getOwnedConversation(conversationId: string, userId: string) {
  const conversation = await prisma.chatConversation.findFirst({
    where: { id: conversationId, userId },
  });
  if (!conversation) {
    throw new NotFoundError("conversation not found");
  }
  return conversation;
}

export async function listConversations(userId: string): Promise<ConversationDto[]> {
  const rows = await prisma.chatConversation.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
  });
  return rows.map(toConversationDto);
}

export async function createConversation(
  userId: string,
  title?: string,
): Promise<ConversationDto> {
  const row = await prisma.chatConversation.create({
    data: { userId, title: title ?? DEFAULT_TITLE },
  });
  return toConversationDto(row);
}

export async function renameConversation(
  conversationId: string,
  userId: string,
  title: string,
): Promise<ConversationDto> {
  await getOwnedConversation(conversationId, userId);
  const row = await prisma.chatConversation.update({
    where: { id: conversationId },
    data: { title },
  });
  return toConversationDto(row);
}

export async function deleteConversation(conversationId: string, userId: string) {
  const { count } = await prisma.chatConversation.deleteMany({
    where: { id: conversationId, userId },
  });
  if (count === 0) {
    throw new NotFoundError("conversation not found");
  }
}

export async function listMessages(
  conversationId: string,
  userId: string,
): Promise<ChatMessageDto[]> {
  await getOwnedConversation(conversationId, userId);
  const rows = await prisma.chatMessage.findMany({
    where: { conversationId },
    orderBy: MESSAGE_ORDER_ASC,
  });
  return rows.map(toMessageDto);
}

/** The user's message allowance for today (UTC). */
export async function getUsage(
  userId: string,
  isAnonymous: boolean,
): Promise<ChatUsage> {
  const { start, resetsAt } = utcDayWindow();
  const limit = isAnonymous ? config.chat.dailyLimitAnon : config.chat.dailyLimit;
  // Every turn (new message or retry) is one usage event.
  const used = await prisma.chatUsageEvent.count({
    where: { userId, createdAt: { gte: start } },
  });
  return {
    used,
    limit,
    remaining: Math.max(0, limit - used),
    resetsAt: resetsAt.toISOString(),
    isDemo: isAnonymous,
  };
}

/**
 * Throw 429 if the user's or the global daily cap is reached. Messages don't
 * name a time: the body's `resetsAt` lets the client show the reset on the
 * user's own clock.
 */
export async function assertWithinLimits(userId: string, isAnonymous: boolean) {
  const { start } = utcDayWindow();
  // Both counts are independent; run them together to keep turn latency low.
  const [usage, globalUsed] = await Promise.all([
    getUsage(userId, isAnonymous),
    prisma.chatUsageEvent.count({ where: { createdAt: { gte: start } } }),
  ]);
  if (usage.remaining <= 0) {
    throw new ChatLimitError(
      "user",
      usage.limit,
      usage.resetsAt,
      isAnonymous
        ? `Demo accounts can send ${usage.limit} messages a day. Sign up for more.`
        : `You've reached today's limit of ${usage.limit} messages.`,
    );
  }
  if (globalUsed >= config.chat.globalDailyLimit) {
    throw new ChatLimitError(
      "global",
      config.chat.globalDailyLimit,
      usage.resetsAt,
      "The AI analyst has reached its daily capacity.",
    );
  }
}

/**
 * Claim the conversation for a new turn, save the user's message and an
 * assistant placeholder, and return the history to send to the model.
 *
 * The claim is one conditional UPDATE, so two concurrent requests for the
 * same conversation can't both start a turn (the loser gets 409).
 */
export async function beginTurn(
  conversationId: string,
  userId: string,
  content: string,
): Promise<TurnStart> {
  const turnId = await claimTurn(conversationId, userId);
  try {
    const prior = await prisma.chatMessage.findMany({
      where: {
        conversationId,
        OR: [{ role: "user" }, { role: "assistant", status: { in: CONTEXT_STATUSES } }],
      },
      orderBy: MESSAGE_ORDER_DESC,
      take: config.chat.historyMessages,
      select: { role: true, content: true },
    });
    const [conversation, userMessage, assistant] = await prisma.$transaction(
      async (tx) => {
        const current = await tx.chatConversation.findUniqueOrThrow({
          where: { id: conversationId },
        });
        const updated =
          current.title === DEFAULT_TITLE
            ? await tx.chatConversation.update({
                where: { id: conversationId },
                data: { title: titleFromMessage(content) },
              })
            : current;
        const user = await tx.chatMessage.create({
          data: { conversationId, userId, role: "user", content, status: "complete" },
        });
        await tx.chatUsageEvent.create({ data: { userId, kind: "message" } });
        const placeholder = await tx.chatMessage.create({
          data: {
            conversationId,
            userId,
            role: "assistant",
            status: "streaming",
            createdAt: new Date(user.createdAt.getTime() + 1),
          },
        });
        return [updated, user, placeholder] as const;
      },
    );
    return {
      turnId,
      question: content,
      conversation: toConversationDto(conversation),
      userMessage: toMessageDto(userMessage),
      assistantMessageId: assistant.id,
      history: buildHistory(prior.reverse()),
    };
  } catch (error) {
    await releaseTurn(conversationId, turnId);
    throw error;
  }
}

/**
 * Claim the conversation for a turn with one conditional UPDATE, so two
 * concurrent requests can't both start one (the loser gets 409).
 */
async function claimTurn(conversationId: string, userId: string): Promise<string> {
  const turnId = randomUUID();
  const now = new Date();
  const claimed = await prisma.chatConversation.updateMany({
    where: {
      id: conversationId,
      userId,
      OR: [
        { activeTurnId: null },
        { activeTurnStartedAt: { lt: new Date(now.getTime() - STALE_TURN_MS) } },
      ],
    },
    data: { activeTurnId: turnId, activeTurnStartedAt: now },
  });
  if (claimed.count === 0) {
    await getOwnedConversation(conversationId, userId); // 404 if not theirs
    throw new TurnInProgressError();
  }
  return turnId;
}

/**
 * Regenerate the latest stopped/failed reply in place ("Regenerate"): no new
 * user message, the same assistant row is reset to streaming, and the history
 * sent to the model excludes the question and the failed attempt. Counts as
 * a turn for the daily caps.
 */
export async function beginRetry(
  conversationId: string,
  userId: string,
  assistantMessageId: string,
): Promise<TurnStart> {
  const turnId = await claimTurn(conversationId, userId);
  try {
    const recent = await prisma.chatMessage.findMany({
      where: { conversationId },
      orderBy: MESSAGE_ORDER_DESC,
      take: config.chat.historyMessages + 2,
    });
    const [target, question, ...older] = recent;
    if (
      !target ||
      target.id !== assistantMessageId ||
      target.role !== "assistant" ||
      !RETRYABLE_STATUSES.includes(target.status) ||
      question?.role !== "user"
    ) {
      throw new RetryNotAllowedError();
    }
    const conversation = await prisma.$transaction(async (tx) => {
      await tx.chatMessage.update({
        where: { id: target.id },
        data: {
          content: "",
          status: "streaming",
          citations: [],
          charts: [],
          toolCalls: [],
          errorCode: null,
          inputTokens: null,
          outputTokens: null,
          model: null,
        },
      });
      await tx.chatUsageEvent.create({ data: { userId, kind: "retry" } });
      return tx.chatConversation.findUniqueOrThrow({ where: { id: conversationId } });
    });
    const prior = older.filter(
      (m) => m.role === "user" || CONTEXT_STATUSES.includes(m.status),
    );
    return {
      turnId,
      question: question.content,
      conversation: toConversationDto(conversation),
      userMessage: toMessageDto(question),
      assistantMessageId: target.id,
      history: buildHistory(prior.reverse()),
    };
  } catch (error) {
    await releaseTurn(conversationId, turnId);
    throw error;
  }
}

async function releaseTurn(conversationId: string, turnId: string) {
  await prisma.chatConversation.updateMany({
    where: { id: conversationId, activeTurnId: turnId },
    data: { activeTurnId: null, activeTurnStartedAt: null },
  });
}

/** Persist the assistant message's final state and release the turn lock. */
export async function finishTurn(
  conversationId: string,
  turnId: string,
  assistantMessageId: string,
  outcome: TurnOutcome,
): Promise<ChatMessageDto> {
  const [message] = await prisma.$transaction([
    prisma.chatMessage.update({
      where: { id: assistantMessageId },
      data: {
        content: outcome.content,
        status: outcome.status,
        citations: (outcome.citations ?? []) as Prisma.InputJsonValue,
        charts: (outcome.charts ?? []) as Prisma.InputJsonValue,
        toolCalls: (outcome.toolCalls ?? []) as Prisma.InputJsonValue,
        errorCode: outcome.errorCode ?? null,
        inputTokens: outcome.inputTokens ?? null,
        outputTokens: outcome.outputTokens ?? null,
        model: outcome.model ?? null,
      },
    }),
    prisma.chatConversation.updateMany({
      where: { id: conversationId, activeTurnId: turnId },
      data: { activeTurnId: null, activeTurnStartedAt: null, updatedAt: new Date() },
    }),
  ]);
  return toMessageDto(message);
}
