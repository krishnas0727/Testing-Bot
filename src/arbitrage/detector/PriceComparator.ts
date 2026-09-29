/**
 * @file PriceComparator.ts
 * @description Compares normalized spot prices across multiple DEXs and discovers directional spreads
 */

import { NormalizedPoolState } from "../../market/types";
import { CandidateRoute } from "../types";

export class PriceComparator {
  /**
   * Compares all pool pairs for a token pair and returns viable candidate routes
   * @param pools Map of DEX Name -> NormalizedPoolState (from Phase 3)
   * @param minSpreadPct Minimum raw spread percentage required to generate route
   */
  public static comparePrices(
    pools: Record<string, NormalizedPoolState>,
    minSpreadPct: number = 0.10
  ): CandidateRoute[] {
    const dexNames = Object.keys(pools);
    if (dexNames.length < 2) return [];

    const routes: CandidateRoute[] = [];
    const now = Date.now();

    for (let i = 0; i < dexNames.length; i++) {
      for (let j = 0; j < dexNames.length; j++) {
        if (i === j) continue;

        const poolA = pools[dexNames[i]];
        const poolB = pools[dexNames[j]];

        if (!poolA || !poolB) continue;
        if (!poolA.isValid || !poolB.isValid) continue;

        // Direction: Buy on A (lower price) -> Sell on B (higher price)
        if (poolA.spotPrice > 0 && poolB.spotPrice > poolA.spotPrice) {
          const rawSpreadUsd = poolB.spotPrice - poolA.spotPrice;
          const rawSpreadPct = (rawSpreadUsd / poolA.spotPrice) * 100.0;

          if (rawSpreadPct >= minSpreadPct) {
            const routeId = `route:${poolA.chainId}:${poolA.pairSymbol.replace("/", "-")}:${poolA.dexName}-${poolB.dexName}`;

            routes.push({
              id: routeId,
              chainId: poolA.chainId,
              pairSymbol: poolA.pairSymbol,
              baseSymbol: poolA.baseToken.symbol,
              quoteSymbol: poolA.quoteToken.symbol,
              buyDex: poolA.dexName,
              sellDex: poolB.dexName,
              buyPool: poolA,
              sellPool: poolB,
              rawSpreadUsd: Number(rawSpreadUsd.toFixed(4)),
              rawSpreadPct: Number(rawSpreadPct.toFixed(4)),
              detectionTimestamp: now
            });
          }
        }
      }
    }

    return routes;
  }
}
