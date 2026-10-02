/** Zod schemas for AI analyst chat input from the client. */
import { z } from "zod";

import { config } from "../config.js";

export const conversationIdSchema = z.string().uuid("invalid conversation id");

const titleSchema = z
  .string()
  .trim()
  .min(1, "title is required")
  .max(100, "titles are limited to 100 characters");

export const createConversationSchema = z.object({ title: titleSchema.optional() });

export const renameConversationSchema = z.object({ title: titleSchema });

export const sendMessageSchema = z.object({
  content: z
    .string()
    .trim()
    .min(1, "message is required")
    .max(
      config.chat.maxMessageChars,
      `Messages are limited to ${config.chat.maxMessageChars} characters.`,
    ),
});

export type SendMessageInput = z.infer<typeof sendMessageSchema>;
