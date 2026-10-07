-- AlterTable
ALTER TABLE "chat_usage_events" ADD COLUMN     "weight" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "research_reports" (
    "id" UUID NOT NULL,
    "ticker" TEXT NOT NULL,
    "fiscal_year" INTEGER NOT NULL,
    "fiscal_quarter" INTEGER NOT NULL,
    "company_name" TEXT,
    "content" JSONB,
    "generated_at" TIMESTAMP(3),
    "generating_since" TIMESTAMP(3),
    "generation_id" UUID,
    "trace_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "research_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "research_reports_ticker_generated_at_idx" ON "research_reports"("ticker", "generated_at");

-- CreateIndex
CREATE UNIQUE INDEX "research_reports_ticker_fiscal_year_fiscal_quarter_key" ON "research_reports"("ticker", "fiscal_year", "fiscal_quarter");

-- Row level security, like every public table: the publishable key can never
-- read or write reports through Supabase's Data API (the app connects as the
-- owner, which bypasses it).
ALTER TABLE "research_reports" ENABLE ROW LEVEL SECURITY;
