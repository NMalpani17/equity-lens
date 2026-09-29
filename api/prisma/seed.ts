/**
 * Seed sample holdings for the shared demo account.
 *
 * The demo user is a real Supabase Auth user; its id (the JWT `sub`) must be
 * provided via the DEMO_USER_ID env var so the seeded rows are owned by, and
 * visible to, anyone who signs in with the demo account ("Try demo").
 *
 * Idempotent: it clears the demo user's existing holdings first, so re-running
 * always yields the same sample portfolio. It never touches other users' data.
 *
 * Run with: npm run db:seed
 */
import { PrismaClient, Prisma } from "@prisma/client";
import dotenv from "dotenv";

// This is a standalone ops script (not app code), so it loads api/.env itself
// for DATABASE_URL and DEMO_USER_ID rather than importing the app config.
dotenv.config();

const prisma = new PrismaClient();

interface SampleLot {
  ticker: string;
  shares: number;
  buyPrice: number;
  purchaseDate: string; // YYYY-MM-DD
}

// A small, diversified sample portfolio with a couple of multi-lot positions.
const SAMPLE_LOTS: SampleLot[] = [
  { ticker: "AAPL", shares: 10, buyPrice: 172.4, purchaseDate: "2024-02-12" },
  { ticker: "AAPL", shares: 5, buyPrice: 210.15, purchaseDate: "2024-11-04" },
  { ticker: "MSFT", shares: 8, buyPrice: 402.75, purchaseDate: "2024-03-19" },
  { ticker: "NVDA", shares: 15, buyPrice: 118.6, purchaseDate: "2024-08-27" },
  { ticker: "VOO", shares: 12, buyPrice: 505.3, purchaseDate: "2025-01-15" },
  { ticker: "TSLA", shares: 6, buyPrice: 248.5, purchaseDate: "2024-06-10" },
];

async function main(): Promise<void> {
  const userId = process.env.DEMO_USER_ID;
  if (!userId) {
    throw new Error(
      "DEMO_USER_ID is not set. Add it to api/.env (the demo auth user's UUID) " +
        "before running the seed.",
    );
  }

  const removed = await prisma.holding.deleteMany({ where: { userId } });

  await prisma.holding.createMany({
    data: SAMPLE_LOTS.map((lot) => ({
      userId,
      ticker: lot.ticker,
      shares: new Prisma.Decimal(lot.shares),
      buyPrice: new Prisma.Decimal(lot.buyPrice),
      purchaseDate: new Date(`${lot.purchaseDate}T00:00:00.000Z`),
    })),
  });

  console.log(
    `Seeded ${SAMPLE_LOTS.length} demo holdings for user ${userId} ` +
      `(removed ${removed.count} existing).`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
