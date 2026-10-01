-- CreateEnum
CREATE TYPE "rag_ticker_status" AS ENUM ('indexing', 'indexed', 'failed', 'unavailable');

-- CreateEnum
CREATE TYPE "rag_job_status" AS ENUM ('queued', 'running', 'succeeded', 'failed');

-- CreateTable
CREATE TABLE "rag_tickers" (
    "ticker" TEXT NOT NULL,
    "company_name" TEXT,
    "status" "rag_ticker_status" NOT NULL,
    "chunk_count" INTEGER NOT NULL DEFAULT 0,
    "quarters" JSONB NOT NULL DEFAULT '[]',
    "last_error" TEXT,
    "last_job_id" UUID,
    "indexed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rag_tickers_pkey" PRIMARY KEY ("ticker")
);

-- CreateTable
CREATE TABLE "rag_ingestion_jobs" (
    "id" UUID NOT NULL,
    "ticker" TEXT NOT NULL,
    "status" "rag_job_status" NOT NULL,
    "trigger" TEXT NOT NULL,
    "chunk_count" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "rag_ingestion_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rag_daily_usage" (
    "day" DATE NOT NULL,
    "new_ticker_ingestions" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rag_daily_usage_pkey" PRIMARY KEY ("day")
);

-- CreateTable
CREATE TABLE "rag_transcripts" (
    "ticker" TEXT NOT NULL,
    "fiscal_year" INTEGER NOT NULL,
    "fiscal_quarter" INTEGER NOT NULL,
    "event_title" TEXT,
    "call_date" TIMESTAMP(3),
    "payload" JSONB NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rag_transcripts_pkey" PRIMARY KEY ("ticker","fiscal_year","fiscal_quarter")
);

-- CreateIndex
CREATE INDEX "rag_ingestion_jobs_ticker_created_at_idx" ON "rag_ingestion_jobs"("ticker", "created_at");

