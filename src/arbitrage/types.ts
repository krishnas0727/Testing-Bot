/**
 * @file types.ts
 * @description Types and schemas for Phase 4: Arbitrage Detection Engine
 */

import { SupportedChainId } from "../types";
import { FreshnessStatus, NormalizedPoolState } from "../market/types";
import { ProfitCalculationBreakdown } from "../profit/types";

export type OpportunityStatus =
  | "DETECTED"
  | "PENDING_PROFIT_CALCULATION"
  | "PROFITABLE"
  | "UNPROFITABLE"
  | "REJECTED_STALE_DATA"
  | "REJECTED_LOW_LIQUIDITY"
  | "REJECTED_DUPLICATE";

export interface CandidateRoute {
  id: string;                      // e.g. "route:8453:WETH-USDC:UniV2-SushiV2"
  chainId: SupportedChainId;
  pairSymbol: string;              // e.g. "WETH/USDC"
  baseSymbol: string;
  quoteSymbol: string;
  buyDex: string;                  // DEX with lower ask/price
  sellDex: string;                 // DEX with higher bid/price
  buyPool: NormalizedPoolState;
  sellPool: NormalizedPoolState;
  rawSpreadUsd: number;            // sellPool.spotPrice - buyPool.spotPrice
  rawSpreadPct: number;            // (rawSpreadUsd / buyPool.spotPrice) * 100
  detectionTimestamp: number;
}

export interface DetectionConfig {
  minSpreadPct?: number;           // Minimum raw spread to consider (e.g. 0.20%)
  minLiquidityUsd?: number;        // Minimum required pool liquidity (e.g. $1,000)
  maxDataAgeMs?: number;           // Maximum allowed pool data age (e.g. 10,000ms)
  deduplicationWindowMs?: number;  // Window to suppress identical opportunities (e.g. 5,000ms)
  candidateSizes?: number[];       // Trade sizes to evaluate (e.g. [5.0, 10.0, 25.0, 50.0, 100.0])
}

export interface ArbitrageOpportunityCandidate {
  opportunityId: string;
  chainId: SupportedChainId;
  tokenPair: string;
  baseSymbol: string;
  quoteSymbol: string;
  inputToken: string;
  buyDex: string;
  sellDex: string;
  tradeSize: number;               // Candidate trade size in quote tokens (e.g. 10.0 USDT)
  
  // Market context
  buyPrice: number;
  sellPrice: number;
  rawSpreadUsd: number;
  rawSpreadPct: number;
  
  // Liquidity & Block Context
  buyPoolLiquidityUsd: number;
  sellPoolLiquidityUsd: number;
  sourceBlock: number;
  timestamp: number;
  dataFreshness: FreshnessStatus;

  // Evaluation & Pipeline
  status: OpportunityStatus;
  profitCalculation?: ProfitCalculationBreakdown;
  isConfirmedProfitable: boolean;  // Set true only when Phase 5 confirms Net Profit > 0
  rejectionReason?: string;
}

export interface DetectionSummary {
  chainId: SupportedChainId;
  scannedPairsCount: number;
  candidateRoutesGenerated: number;
  opportunitiesDetected: number;
  profitableCount: number;
  rejectedStaleCount: number;
  rejectedLowLiquidityCount: number;
  rejectedDuplicateCount: number;
  timestamp: number;
  opportunities: ArbitrageOpportunityCandidate[];
}
