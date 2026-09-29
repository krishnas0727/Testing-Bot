/**
 * @file IArbitrageEngine.ts
 * @description Phase 4 & 5 Interface: Opportunity Detection & Net Profit Calculus
 */

import { ArbitrageOpportunity, SupportedChainId } from "../types";

export interface IArbitrageEngine {
  /**
   * Scans cross-DEX routes and identifies profitable discrepancies
   */
  findOpportunities(
    chainId: SupportedChainId,
    tokenIn: string,
    tradeAmount: number
  ): Promise<ArbitrageOpportunity[]>;

  /**
   * Computes calculus-based optimal input notional x* maximizing net profit
   */
  calculateOptimalTradeSize(
    reserveInA: bigint,
    reserveOutA: bigint,
    reserveInB: bigint,
    reserveOutB: bigint
  ): bigint;

  /**
   * Calculates complete Net Profit: Gross Return - Input - Fees - Price Impact - Gas Cost
   */
  calculateNetProfit(
    amountIn: bigint,
    expectedAmountOut: bigint,
    gasUnits: bigint,
    gasPriceGwei: number,
    ethPriceUsdt: number
  ): { grossProfitUsdt: number; gasCostUsdt: number; netProfitUsdt: number; roiPct: number };
}
