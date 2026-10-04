-- AlterTable
ALTER TABLE "rag_tickers" ADD COLUMN     "freshness_checked_at" TIMESTAMP(3),
ADD COLUMN     "latest_call_date" DATE;

-- AlterTable
ALTER TABLE "rag_daily_usage" ADD COLUMN     "refresh_ingestions" INTEGER NOT NULL DEFAULT 0;

-- Backfill: the newest cached call per ticker is its newest indexed call.
UPDATE "rag_tickers" AS t
SET "latest_call_date" = (
    SELECT MAX(r."call_date")::date FROM "rag_transcripts" AS r WHERE r."ticker" = t."ticker"
);
