/**
 * @file mainnet.ts
 * @description Phase 22: Controlled Mainnet Launch Configuration
 *
 * Dedicated production configuration for Base L2 Mainnet (Chain ID: 8453).
 *
 * CRITICAL SAFETY RULES:
 * 1. Mainnet addresses are strictly isolated from testnet addresses.
 * 2. LIVE trading requires explicit multi-gate arming (LIVE_TRADING_ARMED=true).
 * 3. Never hardcode or print private keys or seed phrases.
 * 4. Controlled first trade size is capped at 5.0 - 25.0 USDC.
 */

import { ethers } from "ethers";
import { SupportedChainId } from "../types";

export interface MainnetTokenConfig {
  address: string;
  symbol: string;
  decimals: number;
  name: string;
}

export interface MainnetDEXConfig {
  name: string;
  routerAddress: string;
  factoryAddress?: string;
}

export interface MainnetNetworkConfig {
  chainId: SupportedChainId;
  name: string;
  shortName: string;
  rpcUrl: string;
  fallbackRpcs: string[];
  explorerUrl: string;
  nativeCurrency: {
    name: string;
    symbol: string;
    decimals: number;
  };
  contracts: {
    arbitrageExecutor: string;
    treasury: string;
  };
  tokens: Record<string, MainnetTokenConfig>;
  dexRouters: Record<string, MainnetDEXConfig>;
  safetyGates: {
    minTradeAmountUsd: number;
    maxTradeAmountUsd: number;
    minNetProfitUsd: number;
    maxPriceImpactPct: number;
    maxSlippagePct: number;
    maxGasPriceGwei: number;
    defaultGasLimit: number;
  };
}

export const MAINNET_CONFIGS: Record<number, MainnetNetworkConfig> = {
  // ───────────────────────────────────────────────────────────────────────────
  // BASE L2 MAINNET (Chain ID: 8453)
  // ───────────────────────────────────────────────────────────────────────────
  8453: {
    chainId: 8453 as SupportedChainId,
    name: "Base L2 Mainnet",
    shortName: "BASE",
    rpcUrl: process.env.BASE_RPC_URL || "https://mainnet.base.org",
    fallbackRpcs: [
      "https://base.llamarpc.com",
      "https://1rpc.io/base",
      "https://base-rpc.publicnode.com",
    ],
    explorerUrl: "https://basescan.org",
    nativeCurrency: {
      name: "Ether",
      symbol: "ETH",
      decimals: 18,
    },
    contracts: {
      arbitrageExecutor:
        process.env.MAINNET_ARBITRAGE_EXECUTOR ||
        process.env.ARBITRAGE_CONTRACT_ADDRESS ||
        "",
      treasury:
        process.env.MAINNET_TREASURY ||
        process.env.TREASURY_CONTRACT_ADDRESS ||
        "",
    },
    tokens: {
      USDC: {
        address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Native Base USDC (Circle)
        symbol: "USDC",
        decimals: 6,
        name: "USD Coin",
      },
      WETH: {
        address: "0x4200000000000000000000000000000000000006", // Canonical Base WETH9
        symbol: "WETH",
        decimals: 18,
        name: "Wrapped Ether",
      },
      DAI: {
        address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", // Canonical Base DAI
        symbol: "DAI",
        decimals: 18,
        name: "Dai Stablecoin",
      },
    },
    dexRouters: {
      Uniswap_V2: {
        name: "Uniswap V2 Router (Base)",
        routerAddress: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
      },
      SushiSwap_V2: {
        name: "SushiSwap V2 Router (Base)",
        routerAddress: "0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891",
      },
    },
    safetyGates: {
      minTradeAmountUsd: 5.0, // Controlled first trade minimum
      maxTradeAmountUsd: 100.0, // Controlled launch maximum cap
      minNetProfitUsd: 0.10, // Strict net profit threshold ($0.10)
      maxPriceImpactPct: 1.0, // 1.00% max price impact
      maxSlippagePct: 0.50, // 0.50% strict slippage
      maxGasPriceGwei: 5.0, // 5.0 Gwei Base gas ceiling
      defaultGasLimit: 250_000,
    },
  },
};

/**
 * Checks if a chain ID corresponds to an authorized production mainnet.
 */
export function isSupportedMainnet(chainId: number): boolean {
  return chainId in MAINNET_CONFIGS;
}

/**
 * Retrieves mainnet configuration or throws a descriptive error.
 */
export function getMainnetConfig(chainId: number = 8453): MainnetNetworkConfig {
  const conf = MAINNET_CONFIGS[chainId];
  if (!conf) {
    throw new Error(`Chain ID ${chainId} is not an authorized mainnet network. Supported: ${Object.keys(MAINNET_CONFIGS).join(", ")}`);
  }
  return conf;
}

/**
 * Validates whether live trading is explicitly armed in the environment.
 */
export function isLiveTradingArmed(): boolean {
  return (
    process.env.LIVE_TRADING_ARMED === "true" &&
    process.env.TRADING_MODE === "LIVE" &&
    process.env.EMERGENCY_STOP !== "true"
  );
}
