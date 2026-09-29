/**
 * @file config.ts
 * @description Centralized Risk Configuration for Phase 6: Risk Management Engine
 */

import { RiskConfig } from "./types";

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  minNetProfitUsdt: Number(process.env.MIN_NET_PROFIT || "0.01"),
  maxTradeSizeUsdt: Number(process.env.MAX_TRADE_SIZE || "1000.0"),
  maxSlippagePct: Number(process.env.MAX_SLIPPAGE || "1.0"),
  maxPriceImpactPct: Number(process.env.MAX_PRICE_IMPACT || "2.0"),
  maxGasCostUsdt: Number(process.env.MAX_GAS_COST || "0.25"),
  minLiquidityUsd: Number(process.env.MIN_LIQUIDITY || "1000.0"),
  maxCapitalExposureUsdt: Number(process.env.MAX_CAPITAL_EXPOSURE || "2500.0"),
  maxDailyLossUsdt: Number(process.env.MAX_DAILY_LOSS || "10.0"),
  maxConsecutiveFailures: Number(process.env.MAX_CONSECUTIVE_FAILURES || "3"),
  maxDataAgeMs: Number(process.env.MAX_DATA_AGE || "15000"),
  safetyMarginUsdt: Number(process.env.SAFETY_MARGIN || "0.02"),
  whitelistedTokens: [
    "WETH",
    "USDT",
    "USDC",
    "DAI",
    "CBETH",
    "WBTC"
  ],
  whitelistedDexes: [
    "Uniswap_V2",
    "SushiSwap_V2",
    "Aerodrome_V2",
    "QuickSwap_V2"
  ],
  circuitBreakerCooldownMs: Number(process.env.CIRCUIT_BREAKER_COOLDOWN_MS || "30000")
};
