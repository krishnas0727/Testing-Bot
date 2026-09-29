/**
 * @file types.ts
 * @description Types and schemas for Phase 6: Centralized Risk Management Engine
 */

import { SupportedChainId } from "../types";

export type CircuitBreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

export type RiskSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type RiskDecisionStatus = "APPROVED" | "REJECTED";

export interface RiskConfig {
  minNetProfitUsdt: number;            // MIN_NET_PROFIT (e.g. 0.01 USDT)
  maxTradeSizeUsdt: number;            // MAX_TRADE_SIZE (e.g. 1000.0 USDT)
  maxSlippagePct: number;              // MAX_SLIPPAGE (e.g. 1.0%)
  maxPriceImpactPct: number;          // MAX_PRICE_IMPACT (e.g. 2.0%)
  maxGasCostUsdt: number;              // MAX_GAS_COST (e.g. 0.25 USDT on L2)
  minLiquidityUsd: number;             // MIN_LIQUIDITY (e.g. 1000.0 USDT)
  maxCapitalExposureUsdt: number;      // MAX_CAPITAL_EXPOSURE (e.g. 2500.0 USDT)
  maxDailyLossUsdt: number;            // MAX_DAILY_LOSS (e.g. 10.0 USDT)
  maxConsecutiveFailures: number;      // MAX_CONSECUTIVE_FAILURES (e.g. 3)
  maxDataAgeMs: number;                // MAX_DATA_AGE (e.g. 15000 ms)
  safetyMarginUsdt: number;            // SAFETY_MARGIN (e.g. 0.02 USDT)
  whitelistedTokens: string[];         // Allowed symbols/addresses
  whitelistedDexes: string[];          // Allowed DEX names
  circuitBreakerCooldownMs: number;    // Cooldown duration before HALF_OPEN (e.g. 30000 ms)
}

export interface RiskEvaluationInput {
  opportunityId: string;
  chainId: SupportedChainId;
  tokenPair: string;
  baseSymbol: string;
  quoteSymbol: string;
  buyDex: string;
  sellDex: string;
  tradeSizeUsdt: number;
  netProfitUsdt: number;
  expectedSlippagePct: number;
  priceImpactPct: number;
  gasCostUsdt: number;
  buyPoolLiquidityUsd: number;
  sellPoolLiquidityUsd: number;
  currentExposureUsdt?: number;
  dataAgeMs: number;
  timestamp: number;
  isConfirmedProfitable?: boolean;
}

export interface RiskEvaluationResultDetailed {
  opportunityId: string;
  isApproved: boolean;
  status: RiskDecisionStatus;
  riskScore: number;                   // 0 (safest) to 100 (highest risk)
  riskStatus: RiskSeverity;
  
  // Market & Trade Metrics
  netProfitUsdt: number;
  minRequiredProfitUsdt: number;
  tradeSizeUsdt: number;
  slippagePct: number;
  priceImpactPct: number;
  gasCostUsdt: number;
  minPoolLiquidityUsd: number;
  capitalExposureUsdt: number;
  
  // Gate check results
  checksPassed: {
    minNetProfit: boolean;
    maxTradeSize: boolean;
    maxSlippage: boolean;
    maxPriceImpact: boolean;
    maxGasCost: boolean;
    minLiquidity: boolean;
    tokenWhitelist: boolean;
    dexWhitelist: boolean;
    capitalExposure: boolean;
    dailyLossLimit: boolean;
    consecutiveFailures: boolean;
    dataFreshness: boolean;
    safetyMargin: boolean;
    circuitBreaker: boolean;
  };

  rejectionReasons: string[];
  circuitBreakerStatus: CircuitBreakerState;
  evaluationTimestamp: number;
}

export interface CircuitBreakerStatus {
  state: CircuitBreakerState;
  tripReason?: string;
  consecutiveFailures: number;
  currentDailyLossUsdt: number;
  lastTripTimestamp?: number;
  lastStateChangeTimestamp: number;
}
