/**
 * @file ITreasuryManager.ts
 * @description Phase 11 Interface: Off-Chain Treasury Manager Service
 *
 * Updated to reference Phase 11 types (TreasuryBucket, FormattedBucketBalances)
 * while maintaining backward compatibility with Phase 1 core types.
 */

import { RevenueAllocation, SupportedChainId, TreasuryStatus } from "../types";
import {
  TreasuryBucket,
  DepositRequest,
  DepositResult,
  WithdrawalRequest,
  WithdrawalResult,
  TreasuryHealthStatus,
  TreasurySnapshot,
  TreasuryEvent,
  AllocationRatios,
  FormattedBucketBalances,
} from "../treasury/types";

export interface ITreasuryManager {
  /**
   * Records a revenue allocation from realized arbitrage profits
   */
  allocateProfit(allocation: RevenueAllocation): Promise<number>;

  /**
   * Retrieves current status across all accounting buckets
   */
  getTreasuryStatus(chainId: SupportedChainId): Promise<TreasuryStatus>;

  /**
   * Deposits funds into a specific treasury bucket
   */
  deposit(request: DepositRequest): Promise<DepositResult>;

  /**
   * Withdraws profit from a specific bucket to an authorized recipient
   */
  withdraw(request: WithdrawalRequest): Promise<WithdrawalResult>;

  /**
   * Performs a comprehensive treasury health check
   */
  getHealthStatus(tokenAddresses: string[]): Promise<TreasuryHealthStatus>;

  /**
   * Creates a point-in-time treasury snapshot
   */
  createSnapshot(tokenAddresses: string[]): Promise<TreasurySnapshot>;

  /**
   * Gets bucket balances for a token (formatted)
   */
  getFormattedBucketBalances(tokenAddress: string, decimals?: number): Promise<FormattedBucketBalances>;

  /**
   * Gets current allocation ratios
   */
  getAllocationRatios(): Promise<AllocationRatios>;

  /**
   * Queries contract events in a block range
   */
  getEvents(fromBlock: number, toBlock?: number): Promise<TreasuryEvent[]>;
}
