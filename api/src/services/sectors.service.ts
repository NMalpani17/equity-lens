/**
 * Sector allocation: the portfolio's market value grouped by sector.
 *
 * Positions are priced by the portfolio summary; sectors come from the AI
 * service's company profiles (Finnhub, then yfinance, mapped onto 11 GICS
 * sectors plus "Funds"). An unknown sector groups under "Other". Positions
 * without a live price are left out, so the weights describe priced value only.
 */
import { getPortfolioSummary } from "./portfolio.service.js";
import { getCompanyProfiles, type CompanyProfiles } from "./companyProfiles.service.js";
import type { PortfolioPosition, SectorAllocation, SectorSlice } from "../types.js";

export const OTHER_SECTOR = "Other";

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Pure computation: group priced positions by sector.
 * Kept side-effect free so it can be unit-tested without any I/O.
 */
export function groupBySector(
  positions: PortfolioPosition[],
  profiles: CompanyProfiles,
): SectorAllocation {
  const bySector = new Map<string, SectorSlice["holdings"]>();
  const unpricedTickers: string[] = [];
  let total = 0;

  for (const position of positions) {
    if (position.marketValue === null) {
      unpricedTickers.push(position.ticker);
      continue;
    }
    const profile = profiles.profiles[position.ticker];
    const sector = profile?.sector ?? OTHER_SECTOR;
    const holdings = bySector.get(sector) ?? [];
    holdings.push({
      ticker: position.ticker,
      name: position.name ?? profile?.name ?? null,
      marketValue: position.marketValue,
    });
    bySector.set(sector, holdings);
    total += position.marketValue;
  }

  const sectors = [...bySector].map(([sector, holdings]): SectorSlice => {
    const marketValue = holdings.reduce((sum, h) => sum + h.marketValue, 0);
    return {
      sector,
      marketValue: round2(marketValue),
      weightPercent: total > 0 ? round2((marketValue / total) * 100) : 0,
      holdings: holdings.sort((a, b) => b.marketValue - a.marketValue),
    };
  });
  sectors.sort((a, b) => {
    if (a.sector === OTHER_SECTOR) return 1;
    if (b.sector === OTHER_SECTOR) return -1;
    return b.marketValue - a.marketValue || a.sector.localeCompare(b.sector);
  });

  return {
    totalMarketValue: round2(total),
    sectors,
    unpricedTickers,
    pendingTickers: [...profiles.pending],
  };
}

/** Orchestrator: price the user's positions, look up sectors, and group. */
export async function getSectorAllocation(userId: string): Promise<SectorAllocation> {
  const { positions } = await getPortfolioSummary(userId);
  const tickers = positions.filter((p) => p.marketValue !== null).map((p) => p.ticker);
  const profiles = await getCompanyProfiles(tickers);
  return groupBySector(positions, profiles);
}
