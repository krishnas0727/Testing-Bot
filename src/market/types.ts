/**
 * @file types.ts
 * @description Type definitions for Phase 3: Market Data Engine
 */

import { SupportedChainId } from "../types";

export type DEXProtocol = "UNISWAP_V2" | "SUSHISWAP_V2" | "UNISWAP_V3" | "QUICKSWAP_V2" | "AERODROME_V2";

export type FreshnessStatus = "FRESH" | "STALE" | "EXPIRED" | "UNINITIALIZED";

export interface RawPoolData {
  dexName: string;
  protocol: DEXProtocol;
  chainId: SupportedChainId;
  poolAddress: string;
  token0Address: string;
  token1Address: string;
  token0Symbol: string;
  token1Symbol: string;
  token0Decimals: number;
  token1Decimals: number;
  rawReserve0: bigint;
  rawReserve1: bigint;
  feeBps: number;              // Fee in basis points (e.g. 30 = 0.30%)
  blockNumber: number;
  blockTimestamp: number;      // Unix timestamp (seconds)
  fetchedAt: number;           // Milliseconds timestamp
}

export interface NormalizedPoolState {
  id: string;                  // e.g. "8453:Uniswap_V2:WETH-USDC"
  chainId: SupportedChainId;
  dexName: string;
  protocol: DEXProtocol;
  poolAddress: string;
  
  // Token Metadata
  pairSymbol: string;          // e.g. "WETH/USDT"
  baseToken: {
    address: string;
    symbol: string;
    decimals: number;
    reserve: number;           // Normalized floating point
    rawReserve: bigint;        // Exact raw wei integer
  };
  quoteToken: {
    address: string;
    symbol: string;
    decimals: number;
    reserve: number;           // Normalized floating point
    rawReserve: bigint;        // Exact raw wei integer
  };

  // Pricing & Liquidity
  spotPrice: number;           // Price of base in terms of quote (e.g. 3200.50 USDC per WETH)
  inversePrice: number;        // Price of quote in terms of base (e.g. 0.0003125 WETH per USDC)
  liquidityUsd: number;        // Estimated total pool liquidity in USD
  feeBps: number;              // e.g. 30 (0.30%)
  feePct: number;              // e.g. 0.003

  // Block & Freshness Auditing
  blockNumber: number;
  blockTimestamp: number;
  fetchedAt: number;           // Local machine timestamp in ms
  ageMs: number;               // Milliseconds since fetched
  freshness: FreshnessStatus;  // FRESH (< 6000ms), STALE (6000ms - 30000ms), EXPIRED (> 30000ms)
  isValid: boolean;
  validationError?: string;
}

export interface PoolValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

export interface MarketDataQuery {
  chainId: SupportedChainId;
  baseSymbol: string;
  quoteSymbol: string;
  maxAgeMs?: number;           // Desired freshness limit (default: 10,000ms)
  excludeDEXs?: string[];
}

export interface MultiDEXPoolSnapshot {
  pairSymbol: string;
  chainId: SupportedChainId;
  pools: Record<string, NormalizedPoolState>;
  highestBid: {
    dex: string;
    price: number;
  };
  lowestAsk: {
    dex: string;
    price: number;
  };
  spreadUsd: number;
  spreadPct: number;
  hasExecutableArbitrage: boolean;
  timestamp: number;
  allFresh: boolean;
}
