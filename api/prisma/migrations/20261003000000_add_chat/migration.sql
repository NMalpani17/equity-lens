-- CreateEnum
CREATE TYPE "chat_role" AS ENUM ('user', 'assistant');

-- CreateEnum
CREATE TYPE "chat_message_status" AS ENUM ('streaming', 'complete', 'truncated', 'blocked', 'empty', 'refused', 'interrupted', 'error');

-- CreateTable
CREATE TABLE "chat_conversations" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'New chat',
    "active_turn_id" UUID,
    "active_turn_started_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_messages" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "chat_role" NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "status" "chat_message_status" NOT NULL DEFAULT 'complete',
    "citations" JSONB NOT NULL DEFAULT '[]',
    "tool_calls" JSONB NOT NULL DEFAULT '[]',
    "error_code" TEXT,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "model" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chat_conversations_user_id_updated_at_idx" ON "chat_conversations"("user_id", "updated_at");

-- CreateIndex
CREATE INDEX "chat_messages_conversation_id_created_at_idx" ON "chat_messages"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "chat_messages_user_id_role_created_at_idx" ON "chat_messages"("user_id", "role", "created_at");

-- CreateIndex
CREATE INDEX "chat_messages_role_created_at_idx" ON "chat_messages"("role", "created_at");

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "chat_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

