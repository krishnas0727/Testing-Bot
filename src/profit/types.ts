/**
 * @file types.ts
 * @description Types and schemas for Phase 5: Profit Calculation Engine
 */

import { SupportedChainId } from "../types";

export type ProfitabilityStatus =
  | "PROFITABLE"
  | "UNPROFITABLE_NEGATIVE_NET"
  | "BELOW_MIN_PROFIT"
  | "PRICE_IMPACT_EXCEEDED"
  | "SLIPPAGE_EXCEEDED"
  | "GAS_CEILING_EXCEEDED"
  | "INSUFFICIENT_LIQUIDITY";

export interface SwapLegQuote {
  dexName: string;
  tokenInSymbol: string;
  tokenOutSymbol: string;
  tokenInDecimals: number;
  tokenOutDecimals: number;
  amountInRaw: bigint;
  amountInFormatted: number;
  amountOutRaw: bigint;
  amountOutFormatted: number;
  feeRaw: bigint;
  feeFormatted: number;
  feeBps: number;
  spotPrice: number;
  executionPrice: number;
  priceImpactPct: number;
}

export interface ProfitCalculationParams {
  opportunityId?: string;
  chainId: SupportedChainId;
  buyDex: string;
  sellDex: string;
  baseSymbol: string;          // e.g. "WETH"
  quoteSymbol: string;         // e.g. "USDT" or "USDC"
  baseDecimals: number;        // e.g. 18
  quoteDecimals: number;       // e.g. 6
  tradeAmountFormatted: number;// Input notional in quote tokens (e.g. 10.0 USDT)
  
  // Pool Reserves (Raw Wei)
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

  // Gas & Network Parameters
  gasPriceGwei: number;
  ethPriceUsdt: number;
  estimatedGasUnits?: bigint;
  l1DataFeeUsdt?: number;

  // Risk & Policy Thresholds
  slippageTolerancePct?: number;   // e.g. 0.50%
  maxPriceImpactPct?: number;       // e.g. 1.00% on Mainnet, 3.00% on Testnet
  minProfitUsdt?: number;           // e.g. 0.01 USDT
  safetyMarginUsdt?: number;        // e.g. 0.02 USDT safety buffer
  otherExecutionCostsUsdt?: number; // e.g. Flash loan fee or MEV tip
  sourceBlock?: number;
}

export interface ProfitCalculationBreakdown {
  opportunityId: string;
  chainId: SupportedChainId;
  buyDex: string;
  sellDex: string;
  pairSymbol: string;
  sourceBlock: number;
  calculationTimestamp: number;

  // Trade Sizing
  tradeSizeFormatted: number;       // Input Notional (e.g. 10.0 USDT)
  initialCapitalRaw: bigint;        // Exact raw wei
  expectedOutputRaw: bigint;       // Final output raw wei
  expectedOutputFormatted: number;  // Final output in quote tokens

  // Execution Legs
  leg1Buy: SwapLegQuote;            // Swap Quote -> Base (e.g. USDT -> WETH on Buy DEX)
  leg2Sell: SwapLegQuote;           // Swap Base -> Quote (e.g. WETH -> USDT on Sell DEX)

  // Explicit Cost Breakdown
  totalDexFeesUsdt: number;         // Cumulative DEX swap fees across both legs
  combinedPriceImpactPct: number;   // Max/aggregate price impact across legs
  expectedSlippagePct: number;      // User configured slippage allowance
  minOutputWithSlippageFormatted: number; // Worst-case output after slippage

  // Gas & Overhead
  estimatedGasUnits: bigint;
  gasPriceGwei: number;
  gasCostUsdt: number;              // L2/L1 execution gas fee
  otherCostsUsdt: number;           // Flash loan, bribe, wrapper fees
  safetyMarginUsdt: number;         // Buffer reserved for price volatility

  // Bottom-Line Profitability
  grossProfitUsdt: number;          // Final Output - Initial Capital
  netProfitUsdt: number;            // Gross Profit - Gas - Other Costs - Safety Margin
  roiPct: number;                   // (Net Profit / Initial Capital) * 100

  // Evaluation & Gating
  minRequiredProfitUsdt: number;
  status: ProfitabilityStatus;
  isExecutable: boolean;
  rejectionReason?: string;

  // Disclaimer / Classification
  isEstimate: true;                 // Explicitly flagged as estimate until on-chain confirmation
}

export interface TradeSizeOptimizationResult {
  evaluatedSizes: number[];
  optimalTradeSize: number;
  maxNetProfitUsdt: number;
  maxRoiPct: number;
  bestBreakdown: ProfitCalculationBreakdown | null;
  allBreakdowns: ProfitCalculationBreakdown[];
}
