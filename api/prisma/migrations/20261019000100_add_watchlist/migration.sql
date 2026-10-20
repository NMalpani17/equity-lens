-- CreateTable
CREATE TABLE "watchlist_items" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "ticker" TEXT NOT NULL,
    "added_price" DECIMAL(20,8),
    "added_price_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "watchlist_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "watchlist_items_user_id_created_at_idx" ON "watchlist_items"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "watchlist_items_user_id_ticker_key" ON "watchlist_items"("user_id", "ticker");

-- Demo users get a sample watchlist once; existing demo users (seeded before
-- this column existed) get it on their next watchlist load.
-- AlterTable
ALTER TABLE "demo_seeds" ADD COLUMN "watchlist_seeded_at" TIMESTAMP(3);

-- Row level security, like every public table (the api connects as the owner,
-- which bypasses it; the browser never reads this table directly).
ALTER TABLE "watchlist_items" ENABLE ROW LEVEL SECURITY;
