/**
 * @file types.ts
 * @description Phase 14: Frontend Dashboard Types & Presentation Specifications
 */

import { SupportedChainId, TradingMode } from "../types";
import { UserRole } from "../api/types";

export type DashboardPage =
  | "OVERVIEW"
  | "OPPORTUNITIES"
  | "TRADES"
  | "TREASURY"
  | "HEALTH"
  | "ALERTS";

export interface DashboardFilterState {
  page: number;
  limit: number;
  status?: string;
  minNetProfit?: number;
  token?: string;
  severity?: string;
  period?: "24h" | "7d" | "30d" | "all";
}

export interface KpiCardData {
  title: string;
  value: string;
  subValue?: string;
  changePct?: number;
  type: "positive" | "negative" | "neutral" | "highlight";
  tooltip?: string;
}

export interface ExplorerConfig {
  name: string;
  txUrlPrefix: string;
  addressUrlPrefix: string;
}

export const BLOCK_EXPLORERS: Record<SupportedChainId, ExplorerConfig> = {
  8453: {
    name: "Basescan",
    txUrlPrefix: "https://basescan.org/tx/",
    addressUrlPrefix: "https://basescan.org/address/",
  },
  84532: {
    name: "Base Sepolia Explorer",
    txUrlPrefix: "https://sepolia.basescan.org/tx/",
    addressUrlPrefix: "https://sepolia.basescan.org/address/",
  },
  137: {
    name: "Polygonscan",
    txUrlPrefix: "https://polygonscan.com/tx/",
    addressUrlPrefix: "https://polygonscan.com/address/",
  },
  42161: {
    name: "Arbiscan",
    txUrlPrefix: "https://arbiscan.io/tx/",
    addressUrlPrefix: "https://arbiscan.io/address/",
  },
  1: {
    name: "Etherscan",
    txUrlPrefix: "https://etherscan.io/tx/",
    addressUrlPrefix: "https://etherscan.io/address/",
  },
  11155111: {
    name: "Sepolia Etherscan",
    txUrlPrefix: "https://sepolia.etherscan.io/tx/",
    addressUrlPrefix: "https://sepolia.etherscan.io/address/",
  },
};

/**
 * Presentation helper: Safely formats currency values as USD string.
 */
export function formatCurrency(amount: number, decimals: number = 2): string {
  if (isNaN(amount) || amount === null || amount === undefined) return "$0.00";
  return `$${amount.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

/**
 * Presentation helper: Generates external block explorer URL for a tx hash.
 */
export function getTxExplorerUrl(chainId: SupportedChainId, txHash: string): string {
  const explorer = BLOCK_EXPLORERS[chainId] || BLOCK_EXPLORERS[8453];
  return `${explorer.txUrlPrefix}${txHash}`;
}

/**
 * Presentation helper: Truncates hash/address for clean UI display.
 */
export function truncateHash(hash: string, startChars: number = 6, endChars: number = 4): string {
  if (!hash) return "";
  if (hash.length <= startChars + endChars) return hash;
  return `${hash.substring(0, startChars)}...${hash.substring(hash.length - endChars)}`;
}
