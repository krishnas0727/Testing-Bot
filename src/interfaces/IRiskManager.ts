/**
 * @file IRiskManager.ts
 * @description Phase 6 & 7 Interface: 10-Gate Pre-Execution Risk Management & Circuit Breakers
 */

import { ArbitrageOpportunity, RiskEvaluationResult } from "../types";

export interface IRiskManager {
  /**
   * Validates all safety gates: token/router whitelists, slippage, price impact, gas ceiling, and daily loss
   */
  evaluateOpportunity(opportunity: ArbitrageOpportunity): Promise<RiskEvaluationResult>;

  /**
   * Triggers emergency stop circuit breaker
   */
  tripCircuitBreaker(reason: string): void;

  /**
   * Checks if emergency stop or daily loss limit is active
   */
  isExecutionBlocked(): boolean;

  /**
   * Records execution loss/gain against daily loss budget
   */
  recordTradeResult(netProfitUsdt: number): void;
}
