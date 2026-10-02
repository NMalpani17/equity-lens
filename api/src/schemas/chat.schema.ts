/** Zod schemas for AI analyst chat input from the client. */
import { z } from "zod";

import { config } from "../config.js";

export const conversationIdSchema = z.string().uuid("invalid conversation id");

export const messageIdSchema = z.string().uuid("invalid message id");

const titleSchema = z
  .string()
  .trim()
  .min(1, "title is required")
  .max(100, "titles are limited to 100 characters");

export const createConversationSchema = z.object({ title: titleSchema.optional() });

export const renameConversationSchema = z.object({ title: titleSchema });

/** True for a valid IANA time zone such as "America/New_York". */
export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** The browser's time zone; unknown values are dropped (UTC is used). */
const timeZoneSchema = z
  .string()
  .max(64)
  .optional()
  .transform((value) => (value && isValidTimeZone(value) ? value : undefined));

export const sendMessageSchema = z.object({
  content: z
    .string()
    .trim()
    .min(1, "message is required")
    .max(
      config.chat.maxMessageChars,
      `Messages are limited to ${config.chat.maxMessageChars} characters.`,
    ),
  timeZone: timeZoneSchema,
});

export const retryMessageSchema = z.object({ timeZone: timeZoneSchema });

export type SendMessageInput = z.infer<typeof sendMessageSchema>;
