/**
 * @file types.ts
 * @description Types and schemas for Phase 7: Real-Time Recalculation Engine
 */

import { SupportedChainId } from "../types";
import { NormalizedPoolState } from "../market/types";
import { RiskDecisionStatus, RiskEvaluationResultDetailed } from "../risk/types";
import { ProfitCalculationBreakdown } from "../profit/types";

export type RevalidationDecision = "VALID_FOR_SIMULATION" | "REJECTED";

export interface RevalidationConfig {
  maxPendingTimeoutMs: number;               // Max age of the pending opportunity before expiration (e.g. 8000ms)
  maxDataAgeMs: number;                      // Max allowed age of refreshed market data (e.g. 5000ms)
  minNetProfitUsdt: number;                  // Minimum acceptable net profit after recalculation (e.g. 0.01 USDT)
  maxNegativeProfitDivergencePct?: number;   // Reject if profit dropped by more than X% (e.g. 30%)
  maxGasPriceIncreasePct?: number;           // Reject if gas price spiked by more than X% (e.g. 100%)
  recalculateOptimalTradeSize?: boolean;     // Whether to re-optimize trade size
}

export interface ApprovedOpportunityBundle {
  opportunityId: string;
  chainId: SupportedChainId;
  tokenPair: string;
  baseSymbol: string;
  quoteSymbol: string;
  buyDex: string;
  sellDex: string;
  tradeSizeUsdt: number;
  initialCapitalRaw?: bigint;
  expectedOutputUsdt: number;
  expectedOutputRaw?: bigint;
  netProfitUsdt: number;
  grossProfitUsdt: number;
  roiPct: number;
  slippagePct: number;
  priceImpactPct: number;
  gasCostUsdt: number;
  gasPriceGwei: number;
  buyPoolLiquidityUsd: number;
  sellPoolLiquidityUsd: number;
  sourceBlock: number;
  timestamp: number;
  initialApprovalTimestamp: number;
  riskStatus: RiskDecisionStatus;
  profitCalculation?: ProfitCalculationBreakdown;
  buyPoolReserves: {
    reserveBase: bigint;
    reserveQuote: bigint;
    feeBps?: number;
  };
  sellPoolReserves: {
    reserveBase: bigint;
    reserveQuote: bigint;
    feeBps?: number;
  };
  baseDecimals: number;
  quoteDecimals: number;
}

export interface FreshMarketDataPayload {
  buyPoolState: NormalizedPoolState;
  sellPoolState: NormalizedPoolState;
  freshGasPriceGwei: number;
  freshEthPriceUsdt: number;
  freshL1DataFeeUsdt?: number;
  currentBlock: number;
  fetchedAt: number;
}

export interface DeltaAnalysis {
  priceSpreadDeltaUsd: number;
  priceSpreadDeltaPct: number;
  buyPoolLiquidityDeltaPct: number;
  sellPoolLiquidityDeltaPct: number;
  gasCostDeltaUsdt: number;
  gasCostDeltaPct: number;
  grossProfitDeltaUsdt: number;
  netProfitDeltaUsdt: number;
  netProfitDivergencePct: number;
  roiDeltaPct: number;
}

export interface RevalidationResult {
  opportunityId: string;
  
  // Previous vs New Trade Size
  previousTradeSize: number;
  newTradeSize: number;

  // Previous vs New Output
  previousExpectedOutput: number;
  newExpectedOutput: number;

  // Previous vs New Net Profit
  previousNetProfit: number;
  newNetProfit: number;

  // Previous vs New Gas Cost
  previousGasEstimate: number;
  newGasEstimate: number;

  // Previous vs New Risk Status
  previousRiskStatus: RiskDecisionStatus | string;
  newRiskStatus: RiskDecisionStatus | string;

  // Market & Block Context
  dataAgeMs: number;
  currentBlock: number;
  revalidationTimestamp: number;

  // Decision & Audit Details
  finalDecision: RevalidationDecision;
  rejectionReason?: string;
  rejectionReasons: string[];
  
  deltaAnalysis: DeltaAnalysis;
  freshProfitBreakdown?: ProfitCalculationBreakdown;
  freshRiskEvaluation?: RiskEvaluationResultDetailed;
}
