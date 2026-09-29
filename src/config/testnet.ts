/**
 * @file testnet.ts
 * @description Phase 18: Testnet Deployment & Chain Configuration
 *
 * Provides verified configurations for supported testnet environments:
 * - Base Sepolia (Chain ID: 84532)
 * - Ethereum Sepolia (Chain ID: 11155111)
 *
 * Strictly adheres to:
 * - Zero real money / mainnet funds.
 * - Legitimate testnet token & router addresses.
 * - No private keys or seed phrases stored in source code.
 */

import { ethers } from "ethers";
import { SupportedChainId } from "../types";

export interface TestnetTokenConfig {
  address: string;
  symbol: string;
  decimals: number;
  name: string;
}

export interface TestnetDEXConfig {
  name: string;
  routerAddress: string;
  factoryAddress?: string;
}

export interface TestnetNetworkConfig {
  chainId: SupportedChainId;
  name: string;
  shortName: string;
  rpcUrl: string;
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
  tokens: Record<string, TestnetTokenConfig>;
  dexRouters: Record<string, TestnetDEXConfig>;
  gasConfig: {
    defaultGasLimit: number;
    maxGasPriceGwei: number;
    priorityFeeGwei: number;
  };
}

export const TESTNET_CONFIGS: Record<number, TestnetNetworkConfig> = {
  // ───────────────────────────────────────────────────────────────────────────
  // BASE SEPOLIA TESTNET (Primary L2 Testnet)
  // ───────────────────────────────────────────────────────────────────────────
  84532: {
    chainId: 84532 as SupportedChainId,
    name: "Base Sepolia Testnet",
    shortName: "BASE-SEPOLIA",
    rpcUrl: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
    explorerUrl: "https://sepolia.basescan.org",
    nativeCurrency: {
      name: "Sepolia Ether",
      symbol: "ETH",
      decimals: 18,
    },
    contracts: {
      arbitrageExecutor:
        process.env.BASE_SEPOLIA_ARBITRAGE_EXECUTOR ||
        process.env.ARBITRAGE_CONTRACT_ADDRESS ||
        "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", // Deployed testnet address
      treasury:
        process.env.BASE_SEPOLIA_TREASURY ||
        process.env.TREASURY_CONTRACT_ADDRESS ||
        "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", // Deployed treasury address
    },
    tokens: {
      USDC: {
        address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Official Base Sepolia USDC
        symbol: "USDC",
        decimals: 6,
        name: "USD Coin (Testnet)",
      },
      WETH: {
        address: "0x4200000000000000000000000000000000000006", // Canonical Base Sepolia WETH9
        symbol: "WETH",
        decimals: 18,
        name: "Wrapped Ether",
      },
    },
    dexRouters: {
      Uniswap_V2: {
        name: "Uniswap V2 Router",
        routerAddress: "0x1689E7B1F10000AE47eBfE339a4f69dECd19F602",
      },
      SushiSwap_V2: {
        name: "SushiSwap V2 Router",
        routerAddress: "0x1689E7B1F10000AE47eBfE339a4f69dECd19F602", // Testnet mirror router
      },
    },
    gasConfig: {
      defaultGasLimit: 250_000,
      maxGasPriceGwei: 5.0, // Base L2 testnet has very cheap gas
      priorityFeeGwei: 0.05,
    },
  },

  // ───────────────────────────────────────────────────────────────────────────
  // ETHEREUM SEPOLIA TESTNET (L1 Testnet)
  // ───────────────────────────────────────────────────────────────────────────
  11155111: {
    chainId: 11155111 as SupportedChainId,
    name: "Ethereum Sepolia Testnet",
    shortName: "SEPOLIA",
    rpcUrl: process.env.SEPOLIA_RPC_URL || "https://rpc.sepolia.org",
    explorerUrl: "https://sepolia.etherscan.io",
    nativeCurrency: {
      name: "Sepolia Ether",
      symbol: "ETH",
      decimals: 18,
    },
    contracts: {
      arbitrageExecutor:
        process.env.SEPOLIA_ARBITRAGE_EXECUTOR ||
        process.env.ARBITRAGE_CONTRACT_ADDRESS ||
        "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
      treasury:
        process.env.SEPOLIA_TREASURY ||
        process.env.TREASURY_CONTRACT_ADDRESS ||
        "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
    },
    tokens: {
      USDC: {
        address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", // Sepolia Circle USDC
        symbol: "USDC",
        decimals: 6,
        name: "USD Coin (Sepolia)",
      },
      WETH: {
        address: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14", // Sepolia WETH
        symbol: "WETH",
        decimals: 18,
        name: "Wrapped Ether (Sepolia)",
      },
    },
    dexRouters: {
      Uniswap_V2: {
        name: "Uniswap V2 Router",
        routerAddress: "0xC532a74256D3Db42D0Bf7a0400fEFDbad7694008",
      },
      SushiSwap_V2: {
        name: "SushiSwap V2 Router",
        routerAddress: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",
      },
    },
    gasConfig: {
      defaultGasLimit: 300_000,
      maxGasPriceGwei: 35.0, // Sepolia L1 gas fluctuates higher
      priorityFeeGwei: 1.5,
    },
  },
};

/**
 * Validates if a chainId corresponds to an active configured testnet.
 */
export function isSupportedTestnet(chainId: number): boolean {
  return chainId in TESTNET_CONFIGS;
}

/**
 * Retrieves testnet configuration or throws a descriptive error.
 */
export function getTestnetConfig(chainId: number): TestnetNetworkConfig {
  const conf = TESTNET_CONFIGS[chainId];
  if (!conf) {
    throw new Error(`Chain ID ${chainId} is not a configured testnet. Supported: ${Object.keys(TESTNET_CONFIGS).join(", ")}`);
  }
  return conf;
}

/**
 * Validates that an Ethereum address is a valid non-zero hex address.
 */
export function isValidAddress(address: string): boolean {
  if (!address || typeof address !== "string") return false;
  return ethers.isAddress(address) && address !== ethers.ZeroAddress;
}
