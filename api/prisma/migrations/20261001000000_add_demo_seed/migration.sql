-- CreateTable
CREATE TABLE "demo_seeds" (
    "user_id" UUID NOT NULL,
    "seeded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "demo_seeds_pkey" PRIMARY KEY ("user_id")
);
