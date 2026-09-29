/**
 * @file ArbitrageDetectionEngine.ts
 * @description Phase 4 Core Engine: Detects cross-DEX arbitrage opportunities, validates liquidity,
 * checks freshness, deduplicates, and connects with Profit Calculation Engine.
 */

import { SupportedChainId } from "../types";
import { FreshnessStatus, NormalizedPoolState } from "../market/types";
import { MarketDataService } from "../market/MarketDataService";
import { ProfitCalculationEngine } from "../profit/ProfitCalculationEngine";
import { PriceComparator } from "./detector/PriceComparator";
import { LiquidityFilter } from "./detector/LiquidityFilter";
import { OpportunityDeduplicator } from "./deduplicator/OpportunityDeduplicator";
import {
  ArbitrageOpportunityCandidate,
  CandidateRoute,
  DetectionConfig,
  DetectionSummary,
  OpportunityStatus
} from "./types";

export interface DetectionContext {
  gasPriceGwei?: number;
  ethPriceUsdt?: number;
  l1DataFeeUsdt?: number;
  slippageTolerancePct?: number;
  minProfitUsdt?: number;
}

export class ArbitrageDetectionEngine {
  private deduplicator: OpportunityDeduplicator;
  private config: Required<DetectionConfig>;
  private marketDataService?: MarketDataService;

  public static readonly DEFAULT_CONFIG: Required<DetectionConfig> = {
    minSpreadPct: 0.15,
    minLiquidityUsd: 1000.0,
    maxDataAgeMs: 15000,
    deduplicationWindowMs: 5000,
    candidateSizes: [5.0, 10.0, 25.0, 50.0, 100.0]
  };

  constructor(
    config?: DetectionConfig,
    marketDataService?: MarketDataService
  ) {
    this.config = {
      ...ArbitrageDetectionEngine.DEFAULT_CONFIG,
      ...config
    };
    this.deduplicator = new OpportunityDeduplicator(this.config.deduplicationWindowMs);
    this.marketDataService = marketDataService;
  }

  /**
   * Scans a dictionary of pools for a given chainId and returns detected arbitrage opportunities
   * @param chainId Target network
   * @param poolsByPair Map of pair symbol (e.g. "WETH/USDT") -> Record of DEX Name -> NormalizedPoolState
   * @param context Market execution context (gas price, ETH price, slippage)
   */
  public detectOpportunities(
    chainId: SupportedChainId,
    poolsByPair: Record<string, Record<string, NormalizedPoolState>>,
    context: DetectionContext = {}
  ): DetectionSummary {
    const summaryTimestamp = Date.now();
    const candidateRoutes: CandidateRoute[] = [];
    const opportunities: ArbitrageOpportunityCandidate[] = [];

    let profitableCount = 0;
    let rejectedStaleCount = 0;
    let rejectedLowLiquidityCount = 0;
    let rejectedDuplicateCount = 0;

    const pairSymbols = Object.keys(poolsByPair);

    for (const pairSymbol of pairSymbols) {
      const dexPools = poolsByPair[pairSymbol];
      if (!dexPools) continue;

      // 1. Cross-DEX Directional Price Comparison (Buy A -> Sell B, Buy B -> Sell A)
      const routes = PriceComparator.comparePrices(dexPools, this.config.minSpreadPct);
      candidateRoutes.push(...routes);

      // 2. Evaluate each candidate route across multiple trade sizes
      for (const route of routes) {
        const { buyPool, sellPool, rawSpreadUsd, rawSpreadPct } = route;

        // Freshness & Expiration Check
        const isBuyFresh = this.isPoolFresh(buyPool);
        const isSellFresh = this.isPoolFresh(sellPool);

        if (!isBuyFresh || !isSellFresh) {
          rejectedStaleCount++;
          const staleOpp: ArbitrageOpportunityCandidate = {
            opportunityId: `opp_stale_${route.id}_${Date.now()}`,
            chainId,
            tokenPair: route.pairSymbol,
            baseSymbol: route.baseSymbol,
            quoteSymbol: route.quoteSymbol,
            inputToken: route.quoteSymbol,
            buyDex: route.buyDex,
            sellDex: route.sellDex,
            tradeSize: this.config.candidateSizes[0] || 10.0,
            buyPrice: buyPool.spotPrice,
            sellPrice: sellPool.spotPrice,
            rawSpreadUsd,
            rawSpreadPct,
            buyPoolLiquidityUsd: buyPool.liquidityUsd,
            sellPoolLiquidityUsd: sellPool.liquidityUsd,
            sourceBlock: Math.max(buyPool.blockNumber, sellPool.blockNumber),
            timestamp: summaryTimestamp,
            dataFreshness: (!isBuyFresh ? buyPool.freshness : sellPool.freshness) as FreshnessStatus,
            status: "REJECTED_STALE_DATA",
            isConfirmedProfitable: false,
            rejectionReason: `Pool data is stale or expired (Buy age: ${buyPool.ageMs}ms, Sell age: ${sellPool.ageMs}ms)`
          };
          opportunities.push(staleOpp);
          continue;
        }

        // Evaluate across configured candidate sizes
        for (const tradeSize of this.config.candidateSizes) {
          const oppId = `opp_${chainId}_${route.pairSymbol.replace("/", "-")}_${route.buyDex}_${route.sellDex}_${tradeSize}_${Date.now()}`;

          // Deduplication Check
          const isDuplicate = this.deduplicator.isDuplicate(
            chainId,
            route.pairSymbol,
            route.buyDex,
            route.sellDex,
            tradeSize,
            rawSpreadPct
          );

          if (isDuplicate) {
            rejectedDuplicateCount++;
            continue;
          }

          // Liquidity Depth Validation
          const liqCheck = LiquidityFilter.checkLiquidity(
            buyPool,
            sellPool,
            tradeSize,
            this.config.minLiquidityUsd
          );

          if (!liqCheck.hasSufficientLiquidity) {
            rejectedLowLiquidityCount++;
            opportunities.push({
              opportunityId: oppId,
              chainId,
              tokenPair: route.pairSymbol,
              baseSymbol: route.baseSymbol,
              quoteSymbol: route.quoteSymbol,
              inputToken: route.quoteSymbol,
              buyDex: route.buyDex,
              sellDex: route.sellDex,
              tradeSize,
              buyPrice: buyPool.spotPrice,
              sellPrice: sellPool.spotPrice,
              rawSpreadUsd,
              rawSpreadPct,
              buyPoolLiquidityUsd: liqCheck.buyPoolLiquidityUsd,
              sellPoolLiquidityUsd: liqCheck.sellPoolLiquidityUsd,
              sourceBlock: Math.max(buyPool.blockNumber, sellPool.blockNumber),
              timestamp: summaryTimestamp,
              dataFreshness: buyPool.freshness,
              status: "REJECTED_LOW_LIQUIDITY",
              isConfirmedProfitable: false,
              rejectionReason: liqCheck.rejectionReason
            });
            continue;
          }

          // Send Candidate to Phase 5 Profit Calculation Engine
          const gasPriceGwei = context.gasPriceGwei || 0.05;
          const ethPriceUsdt = context.ethPriceUsdt || 3200.0;
          const l1DataFeeUsdt = context.l1DataFeeUsdt || 0.005;
          const slippageTolerancePct = context.slippageTolerancePct || 0.50;
          const minProfitUsdt = context.minProfitUsdt || 0.01;

          const profitCalc = ProfitCalculationEngine.calculateProfitability({
            opportunityId: oppId,
            chainId,
            pairSymbol: route.pairSymbol,
            baseSymbol: route.baseSymbol,
            quoteSymbol: route.quoteSymbol,
            baseDecimals: buyPool.baseToken.decimals,
            quoteDecimals: buyPool.quoteToken.decimals,
            buyDex: route.buyDex,
            sellDex: route.sellDex,
            tradeAmountFormatted: tradeSize,
            buyPoolReserves: {
              reserveBase: buyPool.baseToken.rawReserve,
              reserveQuote: buyPool.quoteToken.rawReserve,
              feeBps: buyPool.feeBps
            },
            sellPoolReserves: {
              reserveBase: sellPool.baseToken.rawReserve,
              reserveQuote: sellPool.quoteToken.rawReserve,
              feeBps: sellPool.feeBps
            },
            gasPriceGwei,
            ethPriceUsdt,
            l1DataFeeUsdt,
            slippageTolerancePct,
            minProfitUsdt
          });

          const isProfitable = profitCalc.isExecutable && profitCalc.netProfitUsdt > 0;
          const status: OpportunityStatus = isProfitable ? "PROFITABLE" : "UNPROFITABLE";

          if (isProfitable) {
            profitableCount++;
          }

          opportunities.push({
            opportunityId: oppId,
            chainId,
            tokenPair: route.pairSymbol,
            baseSymbol: route.baseSymbol,
            quoteSymbol: route.quoteSymbol,
            inputToken: route.quoteSymbol,
            buyDex: route.buyDex,
            sellDex: route.sellDex,
            tradeSize,
            buyPrice: buyPool.spotPrice,
            sellPrice: sellPool.spotPrice,
            rawSpreadUsd,
            rawSpreadPct,
            buyPoolLiquidityUsd: liqCheck.buyPoolLiquidityUsd,
            sellPoolLiquidityUsd: liqCheck.sellPoolLiquidityUsd,
            sourceBlock: Math.max(buyPool.blockNumber, sellPool.blockNumber),
            timestamp: summaryTimestamp,
            dataFreshness: buyPool.freshness,
            status,
            profitCalculation: profitCalc,
            isConfirmedProfitable: isProfitable,
            rejectionReason: profitCalc.rejectionReason
          });
        }
      }
    }

    return {
      chainId,
      scannedPairsCount: pairSymbols.length,
      candidateRoutesGenerated: candidateRoutes.length,
      opportunitiesDetected: opportunities.length,
      profitableCount,
      rejectedStaleCount,
      rejectedLowLiquidityCount,
      rejectedDuplicateCount,
      timestamp: summaryTimestamp,
      opportunities
    };
  }

  /**
   * Helper to check pool data freshness against configured max age
   */
  private isPoolFresh(pool: NormalizedPoolState): boolean {
    if (!pool.isValid) return false;
    if (pool.freshness === "EXPIRED" || pool.freshness === "STALE") {
      return false;
    }
    const currentAge = Date.now() - pool.fetchedAt;
    return currentAge <= this.config.maxDataAgeMs;
  }

  /**
   * Cleans internal deduplicator cache
   */
  public pruneCache(): number {
    return this.deduplicator.prune();
  }

  public getDeduplicator(): OpportunityDeduplicator {
    return this.deduplicator;
  }
}
