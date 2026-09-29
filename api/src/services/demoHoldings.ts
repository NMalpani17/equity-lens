/**
 * Sample demo portfolio.
 *
 * Anonymous ("Try demo") visitors each get their own temporary user; on first
 * load the API seeds these holdings so the dashboard has something to show. Kept
 * as plain data plus a builder so both the service and its tests can reuse it.
 */
import { Prisma } from "@prisma/client";

interface DemoLot {
  ticker: string;
  shares: number;
  buyPrice: number;
  purchaseDate: string; // YYYY-MM-DD
}

// A small, diversified sample portfolio with a couple of multi-lot positions.
export const SAMPLE_DEMO_LOTS: DemoLot[] = [
  { ticker: "AAPL", shares: 10, buyPrice: 172.4, purchaseDate: "2024-02-12" },
  { ticker: "AAPL", shares: 5, buyPrice: 210.15, purchaseDate: "2024-11-04" },
  { ticker: "MSFT", shares: 8, buyPrice: 402.75, purchaseDate: "2024-03-19" },
  { ticker: "NVDA", shares: 15, buyPrice: 118.6, purchaseDate: "2024-08-27" },
  { ticker: "VOO", shares: 12, buyPrice: 505.3, purchaseDate: "2025-01-15" },
  { ticker: "TSLA", shares: 6, buyPrice: 248.5, purchaseDate: "2024-06-10" },
];

/** Build Prisma `createMany` data for the demo portfolio, owned by `userId`. */
export function buildDemoHoldingData(userId: string) {
  return SAMPLE_DEMO_LOTS.map((lot) => ({
    userId,
    ticker: lot.ticker,
    shares: new Prisma.Decimal(lot.shares),
    buyPrice: new Prisma.Decimal(lot.buyPrice),
    purchaseDate: new Date(`${lot.purchaseDate}T00:00:00.000Z`),
  }));
}
