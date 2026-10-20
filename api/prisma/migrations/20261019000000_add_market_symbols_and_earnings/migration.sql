-- Company search and the earnings calendar: shared market data (no user data),
-- written and read by the ai-service.

-- Trigram matching for partial and misspelled company names. Supabase keeps
-- extensions in the "extensions" schema; every use below is schema-qualified,
-- so it works whatever the search_path.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

-- CreateTable
CREATE TABLE "market_symbols" (
    "ticker" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_raw" TEXT NOT NULL,
    "search_name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "exchange" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "market_symbols_pkey" PRIMARY KEY ("ticker")
);

-- CreateTable
CREATE TABLE "market_earnings" (
    "ticker" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "hour" TEXT,
    "fiscal_year" INTEGER,
    "fiscal_quarter" INTEGER,
    "eps_estimate" DECIMAL(20,6),
    "revenue_estimate" DECIMAL(24,2),
    "fetched_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "market_earnings_pkey" PRIMARY KEY ("ticker","date")
);

-- CreateTable
CREATE TABLE "market_refresh_state" (
    "dataset" TEXT NOT NULL,
    "refreshed_at" TIMESTAMP(3),
    "attempted_at" TIMESTAMP(3),
    "refreshing_since" TIMESTAMP(3),
    "refresh_id" UUID,
    "row_count" INTEGER NOT NULL DEFAULT 0,
    "covered_from" DATE,
    "covered_to" DATE,
    "last_error" TEXT,

    CONSTRAINT "market_refresh_state_pkey" PRIMARY KEY ("dataset")
);

-- CreateIndex
CREATE INDEX "market_symbols_ticker_idx" ON "market_symbols" USING GIN ("ticker" extensions.gin_trgm_ops);

-- CreateIndex
CREATE INDEX "market_symbols_search_name_idx" ON "market_symbols" USING GIN ("search_name" extensions.gin_trgm_ops);

-- CreateIndex
CREATE INDEX "market_earnings_date_idx" ON "market_earnings"("date");

-- Row level security, like every public table (the app connects as the owner,
-- which bypasses it).
ALTER TABLE "market_symbols" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "market_earnings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "market_refresh_state" ENABLE ROW LEVEL SECURITY;
