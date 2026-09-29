/**
 * @file RiskEngine.ts
 * @description Centralized Risk Engine for Phase 6: Evaluates every arbitrage opportunity
 * across 14 independent safety gates before permitting simulation or execution.
 */

import { CircuitBreaker } from "./CircuitBreaker";
import { DEFAULT_RISK_CONFIG } from "./config";
import {
  CircuitBreakerState,
  RiskConfig,
  RiskDecisionStatus,
  RiskEvaluationInput,
  RiskEvaluationResultDetailed,
  RiskSeverity
} from "./types";

export class RiskEngine {
  private config: RiskConfig;
  private circuitBreaker: CircuitBreaker;
  private currentActiveExposureUsdt: number = 0;

  constructor(
    customConfig?: Partial<RiskConfig>,
    customCircuitBreaker?: CircuitBreaker
  ) {
    this.config = {
      ...DEFAULT_RISK_CONFIG,
      ...customConfig
    };
    this.circuitBreaker = customCircuitBreaker || new CircuitBreaker(
      this.config.circuitBreakerCooldownMs,
      this.config.maxConsecutiveFailures,
      this.config.maxDailyLossUsdt
    );
  }

  /**
   * Evaluates an arbitrage opportunity across all centralized risk parameters.
   * Collects all rejection reasons if multiple checks fail.
   */
  public evaluateOpportunity(input: RiskEvaluationInput): RiskEvaluationResultDetailed {
    const timestamp = Date.now();
    const rejectionReasons: string[] = [];

    // --- GATE 1: Circuit Breaker Status ---
    const cbState = this.circuitBreaker.getState();
    const circuitBreakerPassed = cbState !== "OPEN";
    if (!circuitBreakerPassed) {
      const cbStatus = this.circuitBreaker.getStatus();
      rejectionReasons.push(
        `Circuit breaker is OPEN: Execution blocked (${cbStatus.tripReason || "Abnormal market conditions"})`
      );
    }

    // --- GATE 2: Token Whitelist ---
    const baseUpper = input.baseSymbol.toUpperCase();
    const quoteUpper = input.quoteSymbol.toUpperCase();
    const baseWhitelisted = this.config.whitelistedTokens.includes(baseUpper);
    const quoteWhitelisted = this.config.whitelistedTokens.includes(quoteUpper);
    const tokenWhitelistPassed = baseWhitelisted && quoteWhitelisted;
    if (!tokenWhitelistPassed) {
      const nonWhitelisted = [
        !baseWhitelisted ? input.baseSymbol : null,
        !quoteWhitelisted ? input.quoteSymbol : null
      ].filter(Boolean).join(", ");
      rejectionReasons.push(`Non-whitelisted token(s) detected: ${nonWhitelisted}`);
    }

    // --- GATE 3: DEX / Router Whitelist ---
    const buyDexWhitelisted = this.config.whitelistedDexes.includes(input.buyDex);
    const sellDexWhitelisted = this.config.whitelistedDexes.includes(input.sellDex);
    const dexWhitelistPassed = buyDexWhitelisted && sellDexWhitelisted;
    if (!dexWhitelistPassed) {
      const nonWhitelistedDex = [
        !buyDexWhitelisted ? input.buyDex : null,
        !sellDexWhitelisted ? input.sellDex : null
      ].filter(Boolean).join(", ");
      rejectionReasons.push(`Non-whitelisted DEX(es) detected: ${nonWhitelistedDex}`);
    }

    // --- GATE 4: Minimum Net Profit ---
    const minNetProfitPassed = input.netProfitUsdt >= this.config.minNetProfitUsdt && input.netProfitUsdt > 0;
    if (!minNetProfitPassed) {
      rejectionReasons.push(
        `Net profit ($${input.netProfitUsdt.toFixed(4)} USDT) is below required minimum threshold ($${this.config.minNetProfitUsdt.toFixed(4)} USDT)`
      );
    }

    // --- GATE 5: Maximum Trade Size ---
    const maxTradeSizePassed = input.tradeSizeUsdt <= this.config.maxTradeSizeUsdt && input.tradeSizeUsdt > 0;
    if (!maxTradeSizePassed) {
      rejectionReasons.push(
        `Trade size ($${input.tradeSizeUsdt.toFixed(2)} USDT) exceeds maximum allowed size ($${this.config.maxTradeSizeUsdt.toFixed(2)} USDT)`
      );
    }

    // --- GATE 6: Maximum Slippage ---
    const maxSlippagePassed = input.expectedSlippagePct <= this.config.maxSlippagePct;
    if (!maxSlippagePassed) {
      rejectionReasons.push(
        `Expected slippage (${input.expectedSlippagePct.toFixed(2)}%) exceeds maximum tolerance (${this.config.maxSlippagePct.toFixed(2)}%)`
      );
    }

    // --- GATE 7: Maximum Price Impact ---
    const maxPriceImpactPassed = input.priceImpactPct <= this.config.maxPriceImpactPct;
    if (!maxPriceImpactPassed) {
      rejectionReasons.push(
        `Price impact (${input.priceImpactPct.toFixed(2)}%) exceeds safety limit (${this.config.maxPriceImpactPct.toFixed(2)}%)`
      );
    }

    // --- GATE 8: Maximum Gas Cost ---
    const maxGasCostPassed = input.gasCostUsdt <= this.config.maxGasCostUsdt;
    if (!maxGasCostPassed) {
      rejectionReasons.push(
        `Gas cost ($${input.gasCostUsdt.toFixed(4)} USDT) exceeds gas ceiling ($${this.config.maxGasCostUsdt.toFixed(4)} USDT)`
      );
    }

    // --- GATE 9: Minimum Pool Liquidity ---
    const minPoolLiq = Math.min(input.buyPoolLiquidityUsd, input.sellPoolLiquidityUsd);
    const minLiquidityPassed = minPoolLiq >= this.config.minLiquidityUsd;
    if (!minLiquidityPassed) {
      rejectionReasons.push(
        `Pool liquidity ($${minPoolLiq.toFixed(2)} USD) is below minimum required liquidity ($${this.config.minLiquidityUsd.toFixed(2)} USD)`
      );
    }

    // --- GATE 10: Maximum Capital Exposure ---
    const currentExp = input.currentExposureUsdt !== undefined ? input.currentExposureUsdt : this.currentActiveExposureUsdt;
    const totalProjectedExposure = currentExp + input.tradeSizeUsdt;
    const capitalExposurePassed = totalProjectedExposure <= this.config.maxCapitalExposureUsdt;
    if (!capitalExposurePassed) {
      rejectionReasons.push(
        `Projected capital exposure ($${totalProjectedExposure.toFixed(2)} USDT) exceeds exposure limit ($${this.config.maxCapitalExposureUsdt.toFixed(2)} USDT)`
      );
    }

    // --- GATE 11: Daily Loss Limit ---
    const cbStatus = this.circuitBreaker.getStatus();
    const dailyLossLimitPassed = cbStatus.currentDailyLossUsdt < this.config.maxDailyLossUsdt;
    if (!dailyLossLimitPassed) {
      rejectionReasons.push(
        `Cumulative daily loss ($${cbStatus.currentDailyLossUsdt.toFixed(2)} USDT) has reached maximum limit ($${this.config.maxDailyLossUsdt.toFixed(2)} USDT)`
      );
    }

    // --- GATE 12: Consecutive Failures ---
    const consecutiveFailuresPassed = cbStatus.consecutiveFailures < this.config.maxConsecutiveFailures;
    if (!consecutiveFailuresPassed) {
      rejectionReasons.push(
        `Consecutive failures (${cbStatus.consecutiveFailures}) reached maximum limit (${this.config.maxConsecutiveFailures})`
      );
    }

    // --- GATE 13: Opportunity Data Freshness ---
    const dataFreshnessPassed = input.dataAgeMs <= this.config.maxDataAgeMs;
    if (!dataFreshnessPassed) {
      rejectionReasons.push(
        `Market data is stale (age: ${input.dataAgeMs}ms > max allowed: ${this.config.maxDataAgeMs}ms)`
      );
    }

    // --- GATE 14: Safety Margin ---
    const safetyMarginPassed = input.netProfitUsdt >= this.config.safetyMarginUsdt;
    if (!safetyMarginPassed) {
      rejectionReasons.push(
        `Net profit ($${input.netProfitUsdt.toFixed(4)} USDT) is below required safety margin ($${this.config.safetyMarginUsdt.toFixed(4)} USDT)`
      );
    }

    // Final Approval Determination
    const isApproved = rejectionReasons.length === 0;
    const status: RiskDecisionStatus = isApproved ? "APPROVED" : "REJECTED";

    // Dynamic Risk Score Computation (0 - 100)
    const { riskScore, riskStatus } = this.calculateRiskScore({
      isApproved,
      rejectionCount: rejectionReasons.length,
      priceImpactPct: input.priceImpactPct,
      slippagePct: input.expectedSlippagePct,
      gasCostRatio: input.netProfitUsdt > 0 ? (input.gasCostUsdt / (input.netProfitUsdt + input.gasCostUsdt)) : 1.0,
      minPoolLiq,
      cbState
    });

    return {
      opportunityId: input.opportunityId,
      isApproved,
      status,
      riskScore,
      riskStatus,
      netProfitUsdt: input.netProfitUsdt,
      minRequiredProfitUsdt: this.config.minNetProfitUsdt,
      tradeSizeUsdt: input.tradeSizeUsdt,
      slippagePct: input.expectedSlippagePct,
      priceImpactPct: input.priceImpactPct,
      gasCostUsdt: input.gasCostUsdt,
      minPoolLiquidityUsd: minPoolLiq,
      capitalExposureUsdt: totalProjectedExposure,
      checksPassed: {
        minNetProfit: minNetProfitPassed,
        maxTradeSize: maxTradeSizePassed,
        maxSlippage: maxSlippagePassed,
        maxPriceImpact: maxPriceImpactPassed,
        maxGasCost: maxGasCostPassed,
        minLiquidity: minLiquidityPassed,
        tokenWhitelist: tokenWhitelistPassed,
        dexWhitelist: dexWhitelistPassed,
        capitalExposure: capitalExposurePassed,
        dailyLossLimit: dailyLossLimitPassed,
        consecutiveFailures: consecutiveFailuresPassed,
        dataFreshness: dataFreshnessPassed,
        safetyMargin: safetyMarginPassed,
        circuitBreaker: circuitBreakerPassed
      },
      rejectionReasons,
      circuitBreakerStatus: cbState,
      evaluationTimestamp: timestamp
    };
  }

  /**
   * Computes risk score (0-100) and severity band
   */
  private calculateRiskScore(params: {
    isApproved: boolean;
    rejectionCount: number;
    priceImpactPct: number;
    slippagePct: number;
    gasCostRatio: number;
    minPoolLiq: number;
    cbState: CircuitBreakerState;
  }): { riskScore: number; riskStatus: RiskSeverity } {
    if (!params.isApproved) {
      if (params.cbState === "OPEN" || params.rejectionCount >= 3) {
        return { riskScore: 95, riskStatus: "CRITICAL" };
      }
      return { riskScore: Math.min(60 + (params.rejectionCount * 10), 90), riskStatus: "HIGH" };
    }

    let score = 10; // Baseline approved risk
    if (params.priceImpactPct > 1.0) score += 15;
    if (params.slippagePct > 0.5) score += 10;
    if (params.gasCostRatio > 0.4) score += 15;
    if (params.minPoolLiq < 5000) score += 10;
    if (params.cbState === "HALF_OPEN") score += 20;

    score = Math.min(Math.max(score, 0), 100);

    let riskStatus: RiskSeverity = "LOW";
    if (score > 75) riskStatus = "CRITICAL";
    else if (score > 50) riskStatus = "HIGH";
    else if (score > 25) riskStatus = "MEDIUM";

    return { riskScore: score, riskStatus };
  }

  // --- External State & Lifecycle Management ---

  public tripCircuitBreaker(reason: string): void {
    this.circuitBreaker.trip(reason);
  }

  public resetCircuitBreaker(): void {
    this.circuitBreaker.reset();
  }

  public recordTradeResult(netProfitUsdt: number): void {
    this.circuitBreaker.recordTradePnl(netProfitUsdt);
    if (netProfitUsdt > 0) {
      this.circuitBreaker.recordSuccess();
    }
  }

  public recordExecutionFailure(reason: string): void {
    this.circuitBreaker.recordFailure(reason);
  }

  public recordExecutionSuccess(): void {
    this.circuitBreaker.recordSuccess();
  }

  public isExecutionBlocked(): boolean {
    return this.circuitBreaker.isBlocked();
  }

  public getCircuitBreaker(): CircuitBreaker {
    return this.circuitBreaker;
  }

  public getConfig(): RiskConfig {
    return { ...this.config };
  }

  public updateConfig(partial: Partial<RiskConfig>): void {
    this.config = {
      ...this.config,
      ...partial
    };
  }

  public setActiveExposure(amountUsdt: number): void {
    this.currentActiveExposureUsdt = Math.max(0, amountUsdt);
  }

  public getActiveExposure(): number {
    return this.currentActiveExposureUsdt;
  }
}
