/**
 * @file DataNormalizer.ts
 * @description Standardizes raw pool reserves from multiple DEXs into a unified NormalizedPoolState
 */

import { ethers } from "ethers";
import { FreshnessStatus, NormalizedPoolState, RawPoolData } from "../types";

export class DataNormalizer {
  public static readonly FRESH_THRESHOLD_MS = 6000;      // < 6s is FRESH
  public static readonly STALE_THRESHOLD_MS = 30000;     // 6s - 30s is STALE, > 30s is EXPIRED

  /**
   * Evaluates freshness status based on data age in milliseconds
   */
  public static evaluateFreshness(ageMs: number): FreshnessStatus {
    if (ageMs < 0) return "UNINITIALIZED";
    if (ageMs <= this.FRESH_THRESHOLD_MS) return "FRESH";
    if (ageMs <= this.STALE_THRESHOLD_MS) return "STALE";
    return "EXPIRED";
  }

  /**
   * Normalizes raw pool data into unified structure
   * @param raw Raw data collected from DEX adapter
   * @param baseSymbol The base symbol requested (e.g. "WETH")
   * @param quoteSymbol The quote symbol requested (e.g. "USDT" or "USDC")
   */
  public static normalize(
    raw: RawPoolData,
    baseSymbol: string,
    quoteSymbol: string
  ): NormalizedPoolState {
    const isToken0Base = raw.token0Symbol.toUpperCase() === baseSymbol.toUpperCase();

    // Map base and quote tokens
    const baseRaw = isToken0Base ? raw.rawReserve0 : raw.rawReserve1;
    const quoteRaw = isToken0Base ? raw.rawReserve1 : raw.rawReserve0;
    const baseDecimals = isToken0Base ? raw.token0Decimals : raw.token1Decimals;
    const quoteDecimals = isToken0Base ? raw.token1Decimals : raw.token0Decimals;
    const baseAddr = isToken0Base ? raw.token0Address : raw.token1Address;
    const quoteAddr = isToken0Base ? raw.token1Address : raw.token0Address;

    // Convert raw bigint to decimal float
    const baseReserveFloat = Number(ethers.formatUnits(baseRaw, baseDecimals));
    const quoteReserveFloat = Number(ethers.formatUnits(quoteRaw, quoteDecimals));

    // Calculate spot price (quote per base, e.g. 3200 USDT per 1 WETH)
    let spotPrice = 0.0;
    let inversePrice = 0.0;

    if (baseReserveFloat > 0 && quoteReserveFloat > 0) {
      spotPrice = quoteReserveFloat / baseReserveFloat;
      inversePrice = baseReserveFloat / quoteReserveFloat;
    }

    // Estimate total pool liquidity in USD (assuming quote is stablecoin or peg)
    const liquidityUsd = (quoteReserveFloat > 0) ? (quoteReserveFloat * 2.0) : 0.0;

    const now = Date.now();
    const ageMs = Math.max(0, now - raw.fetchedAt);
    const freshness = this.evaluateFreshness(ageMs);

    const feeBps = raw.feeBps || 30;
    const feePct = feeBps / 10000;

    const id = `${raw.chainId}:${raw.dexName}:${baseSymbol.toUpperCase()}-${quoteSymbol.toUpperCase()}`;

    return {
      id,
      chainId: raw.chainId,
      dexName: raw.dexName,
      protocol: raw.protocol,
      poolAddress: raw.poolAddress,
      pairSymbol: `${baseSymbol.toUpperCase()}/${quoteSymbol.toUpperCase()}`,
      baseToken: {
        address: baseAddr,
        symbol: baseSymbol.toUpperCase(),
        decimals: baseDecimals,
        reserve: baseReserveFloat,
        rawReserve: baseRaw
      },
      quoteToken: {
        address: quoteAddr,
        symbol: quoteSymbol.toUpperCase(),
        decimals: quoteDecimals,
        reserve: quoteReserveFloat,
        rawReserve: quoteRaw
      },
      spotPrice,
      inversePrice,
      liquidityUsd,
      feeBps,
      feePct,
      blockNumber: raw.blockNumber,
      blockTimestamp: raw.blockTimestamp,
      fetchedAt: raw.fetchedAt,
      ageMs,
      freshness,
      isValid: baseReserveFloat > 0 && quoteReserveFloat > 0 && spotPrice > 0
    };
  }
}
