/**
 * @file index.ts
 * @description Strongly-typed configuration loader for DEX Arbitrage & Treasury System
 */

import * as dotenv from "dotenv";
import { ChainConfig, SupportedChainId, TradingMode } from "../types";

dotenv.config();

export interface BotConfig {
  tradingMode: TradingMode;
  autoTradeEnabled: boolean;
  liveTradingArmed: boolean;
  emergencyStop: boolean;
  chainId: SupportedChainId;
  defaultTradeAmount: number;
  minTradeAmount: number;
  maxTradeAmount: number;
  minProfitUsdt: number;
  minProfitPercent: number;
  slippagePct: number;
  maxPriceImpactPct: number;
  maxGasPriceGwei: number;
  maxDailyLossUsdt: number;
  autoTradeCooldownSec: number;
  walletAddress: string;
  arbitrageContractAddress: string;
  treasuryContractAddress: string;
  chains: Record<SupportedChainId, ChainConfig>;
}

export const SUPPORTED_CHAINS: Record<SupportedChainId, ChainConfig> = {
  8453: {
    chainId: 8453,
    name: "Base L2 Mainnet",
    shortName: "BASE",
    rpcUrl: process.env.BASE_RPC_URL || "https://mainnet.base.org",
    explorerUrl: "https://basescan.org",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    dexRouters: {
      Uniswap_V2: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
      SushiSwap_V2: "0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891",
    },
    isTestnet: false,
  },
  84532: {
    chainId: 84532,
    name: "Base Sepolia Testnet",
    shortName: "BASE-SEP",
    rpcUrl: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
    explorerUrl: "https://sepolia.basescan.org",
    nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
    dexRouters: {
      Uniswap_V2: "0x1689E7B1F10000AE47eBfE339a4f69dECd19F602",
      SushiSwap_V2: "0x1689E7B1F10000AE47eBfE339a4f69dECd19F602",
    },
    isTestnet: true,
  },
  137: {
    chainId: 137,
    name: "Polygon PoS",
    shortName: "POLYGON",
    rpcUrl: process.env.POLYGON_RPC_URL || "https://polygon-rpc.com",
    explorerUrl: "https://polygonscan.com",
    nativeCurrency: { name: "Polygon", symbol: "POL", decimals: 18 },
    dexRouters: {
      QuickSwap_V2: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
      SushiSwap_V2: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",
    },
    isTestnet: false,
  },
  42161: {
    chainId: 42161,
    name: "Arbitrum One",
    shortName: "ARB",
    rpcUrl: process.env.ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc",
    explorerUrl: "https://arbiscan.io",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    dexRouters: {
      SushiSwap_V2: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",
      Uniswap_V2: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
    },
    isTestnet: false,
  },
  1: {
    chainId: 1,
    name: "Ethereum Mainnet",
    shortName: "ETH",
    rpcUrl: process.env.ETHEREUM_RPC_URL || "https://cloudflare-eth.com",
    explorerUrl: "https://etherscan.io",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    dexRouters: {
      Uniswap_V2: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
      SushiSwap_V2: "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F",
    },
    isTestnet: false,
  },
  11155111: {
    chainId: 11155111,
    name: "Sepolia Testnet",
    shortName: "SEPOLIA",
    rpcUrl: process.env.SEPOLIA_RPC_URL || "https://rpc.sepolia.org",
    explorerUrl: "https://sepolia.etherscan.io",
    nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
    dexRouters: {
      Uniswap_V2: "0xC532a74256D3Db42D0Bf7a0400fEFDbad7694008",
      SushiSwap_V2: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",
    },
    isTestnet: true,
  },
};

export function loadConfig(): BotConfig {
  const envChainId = Number(process.env.CHAIN_ID || 8453) as SupportedChainId;
  const activeChainId: SupportedChainId = SUPPORTED_CHAINS[envChainId] ? envChainId : 8453;
  const isTestnet = SUPPORTED_CHAINS[activeChainId].isTestnet;

  return {
    tradingMode: (process.env.TRADING_MODE as TradingMode) || "MOCK",
    autoTradeEnabled: process.env.AUTO_TRADE_ENABLED === "true",
    liveTradingArmed: process.env.LIVE_TRADING_ARMED === "true",
    emergencyStop: process.env.EMERGENCY_STOP === "true",
    chainId: activeChainId,
    defaultTradeAmount: Number(process.env.DEFAULT_TRADE_AMOUNT || 10.0),
    minTradeAmount: Number(process.env.MIN_TRADE_AMOUNT || 0.10),
    maxTradeAmount: Number(process.env.MAX_TRADE_AMOUNT || 500.0),
    minProfitUsdt: Number(process.env.MIN_PROFIT_USDT || 0.01),
    minProfitPercent: Number(process.env.MIN_PROFIT_PERCENT || 0.10),
    slippagePct: Number(process.env.SLIPPAGE_PCT || 0.50),
    // Allow up to 3.0% on testnet where liquidity is shallow; strict 1.0% on mainnet
    maxPriceImpactPct: Number(process.env.MAX_PRICE_IMPACT_PCT || (isTestnet ? 3.0 : 1.0)),
    maxGasPriceGwei: Number(process.env.MAX_GAS_PRICE_GWEI || 20.0),
    maxDailyLossUsdt: Number(process.env.MAX_DAILY_LOSS_USDT || 10.00),
    autoTradeCooldownSec: Number(process.env.AUTO_TRADE_COOLDOWN || 15),
    walletAddress: process.env.WALLET_ADDRESS || "",
    arbitrageContractAddress: process.env.ARBITRAGE_CONTRACT_ADDRESS || "",
    treasuryContractAddress: process.env.TREASURY_CONTRACT_ADDRESS || "",
    chains: SUPPORTED_CHAINS,
  };
}

export const config = loadConfig();
