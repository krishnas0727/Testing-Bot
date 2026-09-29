/**
 * @file RealTimeRecalculationEngine.ts
 * @description Phase 7 Core Engine: Refreshes pool reserves, recalculates gas, slippage,
 * price impact, and net profit immediately before execution, and re-runs the Risk Engine.
 */

import { ProfitCalculationEngine } from "../profit/ProfitCalculationEngine";
import { RiskEngine } from "../risk/RiskEngine";
import {
  ApprovedOpportunityBundle,
  DeltaAnalysis,
  FreshMarketDataPayload,
  RevalidationConfig,
  RevalidationDecision,
  RevalidationResult
} from "./types";

export class RealTimeRecalculationEngine {
  private config: Required<RevalidationConfig>;
  private riskEngine: RiskEngine;

  public static readonly DEFAULT_CONFIG: Required<RevalidationConfig> = {
    maxPendingTimeoutMs: 8000,
    maxDataAgeMs: 5000,
    minNetProfitUsdt: 0.01,
    maxNegativeProfitDivergencePct: 30.0,
    maxGasPriceIncreasePct: 100.0,
    recalculateOptimalTradeSize: false
  };

  constructor(
    customConfig?: Partial<RevalidationConfig>,
    customRiskEngine?: RiskEngine
  ) {
    this.config = {
      ...RealTimeRecalculationEngine.DEFAULT_CONFIG,
      ...customConfig
    };
    this.riskEngine = customRiskEngine || new RiskEngine();
  }

  /**
   * Revalidates an approved opportunity with fresh, real-time market data
   */
  public revalidateOpportunity(
    approvedOpp: ApprovedOpportunityBundle,
    freshPayload: FreshMarketDataPayload
  ): RevalidationResult {
    const revalTimestamp = Date.now();
    const rejectionReasons: string[] = [];

    // --- STEP 1: Opportunity Pending Timeout Protection ---
    const pendingAgeMs = revalTimestamp - approvedOpp.initialApprovalTimestamp;
    if (pendingAgeMs > this.config.maxPendingTimeoutMs) {
      rejectionReasons.push(
        `Opportunity pending timeout exceeded (${pendingAgeMs}ms > max allowed: ${this.config.maxPendingTimeoutMs}ms)`
      );
    }

    // --- STEP 2: Fresh Market Data & RPC Failure Auditing ---
    if (
      !freshPayload ||
      !freshPayload.buyPoolState ||
      !freshPayload.sellPoolState ||
      !freshPayload.buyPoolState.isValid ||
      !freshPayload.sellPoolState.isValid
    ) {
      rejectionReasons.push("RPC or pool state refresh failure: Invalid or unavailable pool state");
      return this.buildRejectedResult(
        approvedOpp,
        approvedOpp.tradeSizeUsdt,
        0,
        0,
        approvedOpp.gasCostUsdt,
        freshPayload?.currentBlock || approvedOpp.sourceBlock,
        revalTimestamp,
        pendingAgeMs,
        rejectionReasons
      );
    }

    // --- STEP 3: Data Freshness Check ---
    const dataAgeMs = revalTimestamp - freshPayload.fetchedAt;
    if (
      dataAgeMs > this.config.maxDataAgeMs ||
      freshPayload.buyPoolState.freshness === "EXPIRED" ||
      freshPayload.sellPoolState.freshness === "EXPIRED" ||
      freshPayload.buyPoolState.freshness === "STALE" ||
      freshPayload.sellPoolState.freshness === "STALE"
    ) {
      rejectionReasons.push(
        `Fresh market data is stale (age: ${dataAgeMs}ms > max allowed: ${this.config.maxDataAgeMs}ms)`
      );
    }

    // --- STEP 4: Recalculate Complete Profitability Breakdown ---
    const tradeSizeToEvaluate = approvedOpp.tradeSizeUsdt;

    const freshProfit = ProfitCalculationEngine.calculateProfitability({
      opportunityId: `${approvedOpp.opportunityId}_reval`,
      chainId: approvedOpp.chainId,
      pairSymbol: approvedOpp.tokenPair,
      baseSymbol: approvedOpp.baseSymbol,
      quoteSymbol: approvedOpp.quoteSymbol,
      baseDecimals: approvedOpp.baseDecimals,
      quoteDecimals: approvedOpp.quoteDecimals,
      buyDex: approvedOpp.buyDex,
      sellDex: approvedOpp.sellDex,
      tradeAmountFormatted: tradeSizeToEvaluate,
      buyPoolReserves: {
        reserveBase: freshPayload.buyPoolState.baseToken.rawReserve,
        reserveQuote: freshPayload.buyPoolState.quoteToken.rawReserve,
        feeBps: freshPayload.buyPoolState.feeBps
      },
      sellPoolReserves: {
        reserveBase: freshPayload.sellPoolState.baseToken.rawReserve,
        reserveQuote: freshPayload.sellPoolState.quoteToken.rawReserve,
        feeBps: freshPayload.sellPoolState.feeBps
      },
      gasPriceGwei: freshPayload.freshGasPriceGwei,
      ethPriceUsdt: freshPayload.freshEthPriceUsdt,
      l1DataFeeUsdt: freshPayload.freshL1DataFeeUsdt || 0.0,
      slippageTolerancePct: approvedOpp.slippagePct,
      minProfitUsdt: this.config.minNetProfitUsdt,
      sourceBlock: freshPayload.currentBlock
    });

    // --- STEP 5: Delta Analysis (Previous vs New Calculations) ---
    const oldBuyPrice = approvedOpp.profitCalculation?.leg1Buy.spotPrice || 0;
    const oldSellPrice = approvedOpp.profitCalculation?.leg2Sell.spotPrice || 0;
    const oldSpreadUsd = oldSellPrice - oldBuyPrice;

    const freshBuyPrice = freshPayload.buyPoolState.spotPrice;
    const freshSellPrice = freshPayload.sellPoolState.spotPrice;
    const freshSpreadUsd = freshSellPrice - freshBuyPrice;

    const priceSpreadDeltaUsd = Number((freshSpreadUsd - oldSpreadUsd).toFixed(4));
    const priceSpreadDeltaPct = oldSpreadUsd > 0
      ? Number(((priceSpreadDeltaUsd / oldSpreadUsd) * 100.0).toFixed(2))
      : 0;

    const buyPoolLiquidityDeltaPct = approvedOpp.buyPoolLiquidityUsd > 0
      ? Number((((freshPayload.buyPoolState.liquidityUsd - approvedOpp.buyPoolLiquidityUsd) / approvedOpp.buyPoolLiquidityUsd) * 100.0).toFixed(2))
      : 0;

    const sellPoolLiquidityDeltaPct = approvedOpp.sellPoolLiquidityUsd > 0
      ? Number((((freshPayload.sellPoolState.liquidityUsd - approvedOpp.sellPoolLiquidityUsd) / approvedOpp.sellPoolLiquidityUsd) * 100.0).toFixed(2))
      : 0;

    const gasCostDeltaUsdt = Number((freshProfit.gasCostUsdt - approvedOpp.gasCostUsdt).toFixed(6));
    const gasCostDeltaPct = approvedOpp.gasCostUsdt > 0
      ? Number(((gasCostDeltaUsdt / approvedOpp.gasCostUsdt) * 100.0).toFixed(2))
      : 0;

    const grossProfitDeltaUsdt = Number((freshProfit.grossProfitUsdt - approvedOpp.grossProfitUsdt).toFixed(6));
    const netProfitDeltaUsdt = Number((freshProfit.netProfitUsdt - approvedOpp.netProfitUsdt).toFixed(6));
    const netProfitDivergencePct = approvedOpp.netProfitUsdt > 0
      ? Number(((netProfitDeltaUsdt / approvedOpp.netProfitUsdt) * 100.0).toFixed(2))
      : 0;

    const roiDeltaPct = Number((freshProfit.roiPct - approvedOpp.roiPct).toFixed(2));

    const deltaAnalysis: DeltaAnalysis = {
      priceSpreadDeltaUsd,
      priceSpreadDeltaPct,
      buyPoolLiquidityDeltaPct,
      sellPoolLiquidityDeltaPct,
      gasCostDeltaUsdt,
      gasCostDeltaPct,
      grossProfitDeltaUsdt,
      netProfitDeltaUsdt,
      netProfitDivergencePct,
      roiDeltaPct
    };

    // --- STEP 6: Recalculated Profitability Guard Checks ---
    if (!freshProfit.isExecutable || freshProfit.netProfitUsdt <= 0) {
      rejectionReasons.push(
        `Recalculated trade is unprofitable (Net profit: -$${Math.abs(freshProfit.netProfitUsdt).toFixed(4)} USDT)`
      );
    } else if (freshProfit.netProfitUsdt < this.config.minNetProfitUsdt) {
      rejectionReasons.push(
        `Recalculated net profit ($${freshProfit.netProfitUsdt.toFixed(4)} USDT) fell below minimum threshold ($${this.config.minNetProfitUsdt.toFixed(4)} USDT)`
      );
    }

    if (
      this.config.maxNegativeProfitDivergencePct !== undefined &&
      netProfitDivergencePct < -this.config.maxNegativeProfitDivergencePct
    ) {
      rejectionReasons.push(
        `Profit degradation (${Math.abs(netProfitDivergencePct).toFixed(2)}%) exceeds maximum allowed negative divergence (${this.config.maxNegativeProfitDivergencePct.toFixed(2)}%)`
      );
    }

    if (
      this.config.maxGasPriceIncreasePct !== undefined &&
      gasCostDeltaPct > this.config.maxGasPriceIncreasePct
    ) {
      rejectionReasons.push(
        `Gas cost spiked by +${gasCostDeltaPct.toFixed(2)}% exceeding surge tolerance (${this.config.maxGasPriceIncreasePct.toFixed(2)}%)`
      );
    }

    // --- STEP 7: Run Complete Phase 6 Risk Engine Again ---
    const freshRiskResult = this.riskEngine.evaluateOpportunity({
      opportunityId: approvedOpp.opportunityId,
      chainId: approvedOpp.chainId,
      tokenPair: approvedOpp.tokenPair,
      baseSymbol: approvedOpp.baseSymbol,
      quoteSymbol: approvedOpp.quoteSymbol,
      buyDex: approvedOpp.buyDex,
      sellDex: approvedOpp.sellDex,
      tradeSizeUsdt: tradeSizeToEvaluate,
      netProfitUsdt: freshProfit.netProfitUsdt,
      expectedSlippagePct: freshProfit.expectedSlippagePct,
      priceImpactPct: freshProfit.combinedPriceImpactPct,
      gasCostUsdt: freshProfit.gasCostUsdt,
      buyPoolLiquidityUsd: freshPayload.buyPoolState.liquidityUsd,
      sellPoolLiquidityUsd: freshPayload.sellPoolState.liquidityUsd,
      dataAgeMs,
      timestamp: revalTimestamp,
      isConfirmedProfitable: freshProfit.netProfitUsdt > 0
    });

    if (!freshRiskResult.isApproved) {
      rejectionReasons.push(...freshRiskResult.rejectionReasons);
    }

    // --- STEP 8: Final Decision ---
    const finalDecision: RevalidationDecision =
      rejectionReasons.length === 0 ? "VALID_FOR_SIMULATION" : "REJECTED";

    return {
      opportunityId: approvedOpp.opportunityId,
      previousTradeSize: approvedOpp.tradeSizeUsdt,
      newTradeSize: tradeSizeToEvaluate,
      previousExpectedOutput: approvedOpp.expectedOutputUsdt,
      newExpectedOutput: freshProfit.expectedOutputFormatted,
      previousNetProfit: approvedOpp.netProfitUsdt,
      newNetProfit: freshProfit.netProfitUsdt,
      previousGasEstimate: approvedOpp.gasCostUsdt,
      newGasEstimate: freshProfit.gasCostUsdt,
      previousRiskStatus: approvedOpp.riskStatus,
      newRiskStatus: freshRiskResult.status,
      dataAgeMs,
      currentBlock: freshPayload.currentBlock,
      revalidationTimestamp: revalTimestamp,
      finalDecision,
      rejectionReason: rejectionReasons[0],
      rejectionReasons,
      deltaAnalysis,
      freshProfitBreakdown: freshProfit,
      freshRiskEvaluation: freshRiskResult
    };
  }

  private buildRejectedResult(
    approvedOpp: ApprovedOpportunityBundle,
    newTradeSize: number,
    newExpectedOutput: number,
    newNetProfit: number,
    newGasEstimate: number,
    currentBlock: number,
    revalTimestamp: number,
    dataAgeMs: number,
    rejectionReasons: string[]
  ): RevalidationResult {
    return {
      opportunityId: approvedOpp.opportunityId,
      previousTradeSize: approvedOpp.tradeSizeUsdt,
      newTradeSize,
      previousExpectedOutput: approvedOpp.expectedOutputUsdt,
      newExpectedOutput,
      previousNetProfit: approvedOpp.netProfitUsdt,
      newNetProfit,
      previousGasEstimate: approvedOpp.gasCostUsdt,
      newGasEstimate,
      previousRiskStatus: approvedOpp.riskStatus,
      newRiskStatus: "REJECTED",
      dataAgeMs,
      currentBlock,
      revalidationTimestamp: revalTimestamp,
      finalDecision: "REJECTED",
      rejectionReason: rejectionReasons[0],
      rejectionReasons,
      deltaAnalysis: {
        priceSpreadDeltaUsd: 0,
        priceSpreadDeltaPct: 0,
        buyPoolLiquidityDeltaPct: 0,
        sellPoolLiquidityDeltaPct: 0,
        gasCostDeltaUsdt: 0,
        gasCostDeltaPct: 0,
        grossProfitDeltaUsdt: 0,
        netProfitDeltaUsdt: -approvedOpp.netProfitUsdt,
        netProfitDivergencePct: -100,
        roiDeltaPct: -approvedOpp.roiPct
      }
    };
  }
}
