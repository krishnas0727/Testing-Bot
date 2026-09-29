/**
 * @file config.ts
 * @description Phase 11: Off-Chain Treasury Manager — Configuration & ABI Constants
 *
 * Contains the minimal ABI for Treasury.sol interaction, pre-computed role hashes,
 * default configuration, and ERC-20 minimal ABI.
 */

import { SupportedChainId } from "../types";
import { TreasuryManagerConfig } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// TREASURY.SOL MINIMAL ABI
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal ABI for Treasury.sol — includes only the function and event signatures
 * needed by the off-chain TreasuryManager service.
 */
export const TREASURY_ABI = [
  // ── Write Functions ──
  "function depositProfit(address token, uint256 amount) external",
  "function deposit(address token, uint256 amount, uint8 bucket) external",
  "function withdraw(address token, uint256 amount, address recipient, uint8 bucket) external",
  "function emergencyWithdraw(address token, uint256 amount, address recipient) external",
  "function pause() external",
  "function unpause() external",
  "function setTokenWhitelist(address token, bool status) external",
  "function setWithdrawalLimits(address token, uint256 maxPerTx, uint256 maxDaily) external",
  "function setAllocationRatios(uint256 _tradingCapitalBps, uint256 _gasReserveBps, uint256 _profitReserveBps, uint256 _emergencyReserveBps, uint256 _revenueBps) external",
  "function setThreeBucketAllocation(uint256 tradingCapitalBps, uint256 reserveBps, uint256 revenueBps) external",
  "function grantRole(bytes32 role, address account) external",
  "function revokeRole(bytes32 role, address account) external",

  // ── View Functions ──
  "function getBucketBalances(address token) external view returns (uint256 tradingCapital, uint256 gasReserve, uint256 profitReserve, uint256 emergencyReserve, uint256 revenue, uint256 totalRealizedProfit, uint256 totalWithdrawn)",
  "function getRemainingDailyLimit(address token) external view returns (uint256)",
  "function hasRole(bytes32 role, address account) external view returns (bool)",
  "function paused() external view returns (bool)",
  "function isTokenWhitelisted(address token) external view returns (bool)",
  "function tradingCapitalBps() external view returns (uint256)",
  "function gasReserveBps() external view returns (uint256)",
  "function profitReserveBps() external view returns (uint256)",
  "function emergencyReserveBps() external view returns (uint256)",
  "function revenueBps() external view returns (uint256)",
  "function tokenWithdrawalLimits(address token) external view returns (uint256 maxPerTx, uint256 maxDaily)",

  // ── Events ──
  "event ProfitReceived(address indexed executor, address indexed token, uint256 grossAmount, uint256 tradingCapitalAllocated, uint256 gasReserveAllocated, uint256 profitReserveAllocated, uint256 emergencyReserveAllocated, uint256 revenueAllocated, uint256 timestamp)",
  "event Deposit(address indexed depositor, address indexed token, uint256 amount, uint8 bucket, uint256 timestamp)",
  "event Withdrawal(address indexed recipient, address indexed token, uint256 amount, uint8 bucket, uint256 timestamp)",
  "event EmergencyWithdrawal(address indexed recipient, address indexed token, uint256 amount, uint256 timestamp)",
  "event Paused(address account)",
  "event Unpaused(address account)",
  "event TokenWhitelisted(address indexed token, bool status)",
  "event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)",
  "event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)",
  "event AllocationUpdated(uint256 tradingCapitalBps, uint256 gasReserveBps, uint256 profitReserveBps, uint256 emergencyReserveBps, uint256 revenueBps, uint256 timestamp)",
  "event ThreeBucketAllocationUpdated(uint256 tradingCapitalBps, uint256 reserveBps, uint256 revenueBps, uint256 timestamp)",
  "event TreasuryConfigurationUpdated(string parameter, uint256 value, uint256 timestamp)",
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// ROLE HASHES (pre-computed keccak256)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pre-computed keccak256 hashes for Treasury.sol roles.
 * These match `keccak256(abi.encodePacked("ROLE_NAME"))` in Solidity.
 */
export const ROLE_HASHES = {
  ADMIN_ROLE:
    "0xa49807205ce4d355092ef5a8a18f56e8913cf4a201fbe287825b095693c21775",
  TREASURY_MANAGER_ROLE:
    "0x9a17e5afe2e7e4fbb5e5643c0509f990e5764aba3d01e91b1ece8e2b3a3ebf04",
  ARBITRAGE_EXECUTOR_ROLE:
    "0x3d9c2581d2f34eaa2249d54d112e41d3174dc6fd18e8ba36edff3f5f8e12a1a4",
  PAUSER_ROLE:
    "0x65d7a28e3265b37a6474929f336521b332c1681b933f6cb9f3376673440d862a",
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// ERC-20 MINIMAL ABI
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal ERC-20 ABI for balance, allowance, approve, decimals, and symbol calls */
export const ERC20_MINIMAL_ABI = [
  "function balanceOf(address account) external view returns (uint256)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function decimals() external view returns (uint8)",
  "function symbol() external view returns (string)",
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// DEFAULT CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Default TreasuryManager configuration.
 * Reads from environment variables with sensible testnet defaults.
 */
export const DEFAULT_TREASURY_CONFIG: TreasuryManagerConfig = {
  treasuryAddress: process.env.TREASURY_CONTRACT_ADDRESS || "",
  chainId: (Number(process.env.CHAIN_ID) || 84532) as SupportedChainId,
  rpcUrl: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
  privateKey: process.env.TREASURY_MANAGER_PRIVATE_KEY || undefined,
  defaultTokenAddress:
    process.env.DEFAULT_TOKEN_ADDRESS ||
    "0x0000000000000000000000000000000000000000",
  defaultTokenDecimals: 18,
  pollingIntervalMs: 30_000,
  maxRetries: 3,
  retryDelayMs: 1_000,
};
