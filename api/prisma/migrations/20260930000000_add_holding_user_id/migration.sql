-- Existing holdings are Phase-2 test data with no owner. Remove them before
-- adding the required user_id column (which has no default).
DELETE FROM "holdings";

-- AlterTable
ALTER TABLE "holdings" ADD COLUMN "user_id" UUID NOT NULL;

-- CreateIndex
CREATE INDEX "holdings_user_id_idx" ON "holdings"("user_id");
