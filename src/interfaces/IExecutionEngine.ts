/**
 * @file IExecutionEngine.ts
 * @description Phase 10 & 11 Interface: On-Chain Atomic Execution via ArbitrageExecutor.sol
 */

import { ArbitrageOpportunity, ExecutionReceipt } from "../types";

export interface IExecutionEngine {
  /**
   * Executes atomic arbitrage through ArbitrageExecutor.sol
   * Reverts deterministically if Net Profit <= 0
   */
  executeAtomicTrade(opportunity: ArbitrageOpportunity): Promise<ExecutionReceipt>;

  /**
   * Routes trade to client-side non-custodial signer (MetaMask) or isolated signer
   */
  prepareTransactionData(opportunity: ArbitrageOpportunity): Promise<{
    to: string;
    data: string;
    gasLimit: bigint;
    value: bigint;
  }>;
}
