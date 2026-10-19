-- CreateTable
CREATE TABLE "market_daily_closes" (
    "ticker" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "close" DECIMAL(20,6) NOT NULL,

    CONSTRAINT "market_daily_closes_pkey" PRIMARY KEY ("ticker","date")
);

-- CreateTable
CREATE TABLE "market_history_coverage" (
    "ticker" TEXT NOT NULL,
    "covered_from" DATE NOT NULL,
    "fetched_through" DATE NOT NULL,
    "status" TEXT NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "market_history_coverage_pkey" PRIMARY KEY ("ticker")
);

-- CreateTable
CREATE TABLE "company_profiles" (
    "ticker" TEXT NOT NULL,
    "name" TEXT,
    "sector" TEXT,
    "industry" TEXT,
    "source" TEXT NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_profiles_pkey" PRIMARY KEY ("ticker")
);

-- Row level security, like every public table: the publishable key can never
-- read or write the cache through Supabase's Data API (the app connects as the
-- owner, which bypasses it).
ALTER TABLE "market_daily_closes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "market_history_coverage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_profiles" ENABLE ROW LEVEL SECURITY;
