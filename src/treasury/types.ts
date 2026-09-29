/**
 * @file types.ts
 * @description Phase 11: Off-Chain Treasury Manager — Type Definitions
 *
 * Comprehensive TypeScript types for interacting with the on-chain Treasury.sol
 * contract from the off-chain bot service. Mirrors Solidity structs and enums,
 * and defines request/result/health/event/snapshot types.
 */

import { SupportedChainId } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// ENUMS
// ─────────────────────────────────────────────────────────────────────────────

/** Mirrors the on-chain ITreasury.Bucket enum */
export enum TreasuryBucket {
  TRADING_CAPITAL = 0,
  GAS_RESERVE = 1,
  PROFIT_RESERVE = 2,
  EMERGENCY_RESERVE = 3,
  REVENUE = 4,
}

/** Human-readable bucket name lookup */
export const BUCKET_NAMES: Record<TreasuryBucket, string> = {
  [TreasuryBucket.TRADING_CAPITAL]: "Trading Capital",
  [TreasuryBucket.GAS_RESERVE]: "Gas Reserve",
  [TreasuryBucket.PROFIT_RESERVE]: "Profit Reserve",
  [TreasuryBucket.EMERGENCY_RESERVE]: "Emergency Reserve",
  [TreasuryBucket.REVENUE]: "Revenue",
};

// ─────────────────────────────────────────────────────────────────────────────
// ON-CHAIN STRUCTS (bigint — raw contract values)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mirrors the Solidity `BucketBalances` struct.
 * All values are raw `bigint` (wei / token-base-units).
 */
export interface OnChainBucketBalances {
  tradingCapital: bigint;
  gasReserve: bigint;
  profitReserve: bigint;
  emergencyReserve: bigint;
  revenue: bigint;
  totalRealizedProfit: bigint;
  totalWithdrawn: bigint;
}

// ─────────────────────────────────────────────────────────────────────────────
// FORMATTED STRUCTS (number — human-readable, decimal-adjusted)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Human-readable bucket balances, converted from raw bigint using token decimals.
 */
export interface FormattedBucketBalances {
  tradingCapital: number;
  gasReserve: number;
  profitReserve: number;
  emergencyReserve: number;
  revenue: number;
  totalRealizedProfit: number;
  totalWithdrawn: number;
  /** Sum of all 5 bucket balances */
  totalBalance: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────

/** Configuration for TreasuryManager off-chain service */
export interface TreasuryManagerConfig {
  /** Deployed Treasury.sol contract address */
  treasuryAddress: string;
  /** Target chain */
  chainId: SupportedChainId;
  /** RPC endpoint URL */
  rpcUrl: string;
  /** Private key for write operations (optional — read-only without it) */
  privateKey?: string;
  /** Default token address for balance queries */
  defaultTokenAddress: string;
  /** Decimals of the default token */
  defaultTokenDecimals: number;
  /** How often to poll the contract for status (ms) */
  pollingIntervalMs: number;
  /** Max retry attempts for failed RPC calls */
  maxRetries: number;
  /** Delay between retries (ms) */
  retryDelayMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// ALLOCATION RATIOS
// ─────────────────────────────────────────────────────────────────────────────

/** On-chain allocation ratios in basis points (10000 = 100%) */
export interface AllocationRatios {
  tradingCapitalBps: number;
  gasReserveBps: number;
  profitReserveBps: number;
  emergencyReserveBps: number;
  revenueBps: number;
  /** Computed sum — should equal 10000 */
  total: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// WITHDRAWAL
// ─────────────────────────────────────────────────────────────────────────────

/** Per-token withdrawal limits from the contract */
export interface WithdrawalLimits {
  maxPerTx: bigint;
  maxDaily: bigint;
  remainingDaily: bigint;
}

/** Request to withdraw funds from a specific treasury bucket */
export interface WithdrawalRequest {
  token: string;
  amount: bigint;
  recipient: string;
  bucket: TreasuryBucket;
  /** Audit trail reason */
  reason: string;
}

/** Result of a withdrawal operation */
export interface WithdrawalResult {
  success: boolean;
  txHash?: string;
  bucket: TreasuryBucket;
  amount: bigint;
  amountFormatted: number;
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// DEPOSIT
// ─────────────────────────────────────────────────────────────────────────────

/** Request to deposit into a specific treasury bucket */
export interface DepositRequest {
  token: string;
  amount: bigint;
  bucket: TreasuryBucket;
}

/** Result of a deposit operation */
export interface DepositResult {
  success: boolean;
  txHash?: string;
  bucket: TreasuryBucket;
  amount: bigint;
  amountFormatted: number;
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// PROFIT DEPOSIT
// ─────────────────────────────────────────────────────────────────────────────

/** Request to deposit realized profit (from ArbitrageExecutor) */
export interface ProfitDepositRequest {
  token: string;
  amount: bigint;
  fromExecutor: string;
}

/** Result of a profit deposit — includes per-bucket allocation breakdown */
export interface ProfitDepositResult {
  success: boolean;
  txHash?: string;
  totalAmount: bigint;
  allocations: FormattedBucketBalances;
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// HEALTH STATUS
// ─────────────────────────────────────────────────────────────────────────────

/** Comprehensive treasury health check result */
export interface TreasuryHealthStatus {
  /** Overall health — false if any warning is critical */
  healthy: boolean;
  /** Whether the contract is paused */
  paused: boolean;
  /** Total value across all buckets (decimal-adjusted) */
  totalValueUsd: number;
  /** Current bucket balances (formatted) */
  buckets: FormattedBucketBalances;
  /** Current on-chain allocation ratios */
  allocationRatios: AllocationRatios;
  /** Per-token withdrawal limits */
  withdrawalLimits: Record<string, WithdrawalLimits>;
  /** Currently whitelisted tokens */
  whitelistedTokens: string[];
  /** Unix timestamp of this health check */
  lastChecked: number;
  /** Human-readable warnings/issues */
  warnings: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// EVENTS (Discriminated Union)
// ─────────────────────────────────────────────────────────────────────────────

/** Common fields for all treasury contract events */
interface TreasuryEventBase {
  blockNumber: number;
  txHash: string;
  timestamp: number;
}

export interface ProfitReceivedEvent extends TreasuryEventBase {
  type: "PROFIT_RECEIVED";
  executor: string;
  token: string;
  grossAmount: bigint;
  tradingCapitalAllocated: bigint;
  gasReserveAllocated: bigint;
  profitReserveAllocated: bigint;
  emergencyReserveAllocated: bigint;
  revenueAllocated: bigint;
}

export interface DepositEvent extends TreasuryEventBase {
  type: "DEPOSIT";
  depositor: string;
  token: string;
  amount: bigint;
  bucket: TreasuryBucket;
}

export interface WithdrawalEvent extends TreasuryEventBase {
  type: "WITHDRAWAL";
  recipient: string;
  token: string;
  amount: bigint;
  bucket: TreasuryBucket;
}

export interface EmergencyWithdrawalEvent extends TreasuryEventBase {
  type: "EMERGENCY_WITHDRAWAL";
  recipient: string;
  token: string;
  amount: bigint;
}

export interface PausedEvent extends TreasuryEventBase {
  type: "PAUSED";
  account: string;
}

export interface UnpausedEvent extends TreasuryEventBase {
  type: "UNPAUSED";
  account: string;
}

export interface TokenWhitelistedEvent extends TreasuryEventBase {
  type: "TOKEN_WHITELISTED";
  token: string;
  status: boolean;
}

export interface RoleGrantedEvent extends TreasuryEventBase {
  type: "ROLE_GRANTED";
  role: string;
  account: string;
  sender: string;
}

export interface RoleRevokedEvent extends TreasuryEventBase {
  type: "ROLE_REVOKED";
  role: string;
  account: string;
  sender: string;
}

export interface AllocationUpdatedEvent extends TreasuryEventBase {
  type: "ALLOCATION_UPDATED";
  tradingCapitalBps: number;
  gasReserveBps: number;
  profitReserveBps: number;
  emergencyReserveBps: number;
  revenueBps: number;
}

/** Discriminated union of all Treasury contract events */
export type TreasuryEvent =
  | ProfitReceivedEvent
  | DepositEvent
  | WithdrawalEvent
  | EmergencyWithdrawalEvent
  | PausedEvent
  | UnpausedEvent
  | TokenWhitelistedEvent
  | RoleGrantedEvent
  | RoleRevokedEvent
  | AllocationUpdatedEvent;

// ─────────────────────────────────────────────────────────────────────────────
// SNAPSHOT
// ─────────────────────────────────────────────────────────────────────────────

/** Point-in-time treasury snapshot for historical tracking */
export interface TreasurySnapshot {
  /** Chain this snapshot was taken from */
  chainId: SupportedChainId;
  /** Block number at snapshot time */
  blockNumber: number;
  /** Unix timestamp */
  timestamp: number;
  /** Per-token bucket balances */
  balances: Record<string, FormattedBucketBalances>;
  /** Health status at snapshot time */
  health: TreasuryHealthStatus;
}
