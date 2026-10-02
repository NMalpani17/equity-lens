-- Inline charts (price history, portfolio allocation) saved with each reply.
ALTER TABLE "chat_messages" ADD COLUMN "charts" JSONB NOT NULL DEFAULT '[]';
