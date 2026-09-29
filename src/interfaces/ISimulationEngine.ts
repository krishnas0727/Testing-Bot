/**
 * @file ISimulationEngine.ts
 * @description Phase 8 & 9 Interface: RPC Pre-Flight Simulation & Trace Verification
 */

import { ArbitrageOpportunity, SimulationResult } from "../types";

export interface ISimulationEngine {
  /**
   * Pre-flights an arbitrage transaction using eth_call against current state
   */
  simulateTrade(opportunity: ArbitrageOpportunity): Promise<SimulationResult>;

  /**
   * Rechecks fresh market price directly before broadcast
   */
  verifyFreshProfitability(opportunity: ArbitrageOpportunity): Promise<boolean>;
}
