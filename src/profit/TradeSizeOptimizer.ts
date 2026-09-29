/**
 * @file TradeSizeOptimizer.ts
 * @description Evaluates multiple trade sizes and identifies the optimal notional with highest valid net profit
 */

import { ProfitCalculationEngine } from "./ProfitCalculationEngine";
import {
  ProfitCalculationBreakdown,
  ProfitCalculationParams,
  TradeSizeOptimizationResult
} from "./types";

export class TradeSizeOptimizer {
  public static readonly DEFAULT_CANDIDATE_SIZES = [
    0.50, 1.0, 2.5, 5.0, 10.0, 25.0, 50.0, 100.0, 250.0, 500.0
  ];

  /**
   * Evaluates an array of candidate trade sizes and selects the size yielding highest net profit
   */
  public static optimizeTradeSize(
    baseParams: Omit<ProfitCalculationParams, "tradeAmountFormatted">,
    candidateSizes: number[] = this.DEFAULT_CANDIDATE_SIZES
  ): TradeSizeOptimizationResult {
    const allBreakdowns: ProfitCalculationBreakdown[] = [];
    let bestBreakdown: ProfitCalculationBreakdown | null = null;
    let maxNetProfitUsdt = -Infinity;
    let maxRoiPct = 0.0;
    let optimalTradeSize = 0.0;

    for (const size of candidateSizes) {
      if (size <= 0) continue;

      const breakdown = ProfitCalculationEngine.calculateProfitability({
        ...baseParams,
        tradeAmountFormatted: size
      });

      allBreakdowns.push(breakdown);

      // Only consider sizes that pass all safety gates (positive net profit, min profit, impact limit)
      if (breakdown.isExecutable && breakdown.netProfitUsdt > maxNetProfitUsdt) {
        maxNetProfitUsdt = breakdown.netProfitUsdt;
        maxRoiPct = breakdown.roiPct;
        optimalTradeSize = size;
        bestBreakdown = breakdown;
      }
    }

    if (maxNetProfitUsdt === -Infinity) {
      maxNetProfitUsdt = 0.0;
    }

    return {
      evaluatedSizes: candidateSizes,
      optimalTradeSize,
      maxNetProfitUsdt,
      maxRoiPct,
      bestBreakdown,
      allBreakdowns
    };
  }
}
