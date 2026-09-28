-- CreateTable
CREATE TABLE "holdings" (
    "id" TEXT NOT NULL,
    "ticker" TEXT NOT NULL,
    "shares" DECIMAL(20,8) NOT NULL,
    "buy_price" DECIMAL(20,8) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "holdings_pkey" PRIMARY KEY ("id")
);
