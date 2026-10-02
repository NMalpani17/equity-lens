-- CreateTable
CREATE TABLE "chat_usage_events" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_usage_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chat_usage_events_user_id_created_at_idx" ON "chat_usage_events"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "chat_usage_events_created_at_idx" ON "chat_usage_events"("created_at");


-- Backfill: existing user messages were the turns counted by the daily caps.
INSERT INTO "chat_usage_events" ("id", "user_id", "kind", "created_at")
SELECT gen_random_uuid(), "user_id", 'message', "created_at"
FROM "chat_messages"
WHERE "role" = 'user';
