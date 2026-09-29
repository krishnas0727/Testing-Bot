/**
 * @file PoolDataValidator.ts
 * @description Validates pool data for missing, zero, invalid, or inconsistent states
 */

import { ethers } from "ethers";
import { NormalizedPoolState, PoolValidationResult } from "../types";

export class PoolDataValidator {
  public static readonly MAX_TIMESTAMP_DRIFT_SEC = 86400; // 24 hours
  public static readonly MIN_VALID_DECIMALS = 1;
  public static readonly MAX_VALID_DECIMALS = 18;

  /**
   * Performs rigorous safety validation on a normalized pool state
   */
  public static validate(pool: NormalizedPoolState): PoolValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // 1. Zero & Negative Reserve Checks
    if (pool.baseToken.reserve <= 0 || pool.baseToken.rawReserve <= 0n) {
      errors.push(`Base token (${pool.baseToken.symbol}) reserve is zero or negative`);
    }
    if (pool.quoteToken.reserve <= 0 || pool.quoteToken.rawReserve <= 0n) {
      errors.push(`Quote token (${pool.quoteToken.symbol}) reserve is zero or negative`);
    }

    // 2. Pricing Sanity
    if (isNaN(pool.spotPrice) || !isFinite(pool.spotPrice) || pool.spotPrice <= 0) {
      errors.push(`Calculated spot price is invalid (${pool.spotPrice})`);
    }

    // 3. Address Sanity
    if (pool.baseToken.address.toLowerCase() === pool.quoteToken.address.toLowerCase()) {
      errors.push("Base token address identical to quote token address");
    }
    if (!ethers.isAddress(pool.baseToken.address) && pool.baseToken.address !== "0x0000000000000000000000000000000000000001") {
      errors.push(`Invalid base token address: ${pool.baseToken.address}`);
    }
    if (!ethers.isAddress(pool.quoteToken.address) && pool.quoteToken.address !== "0x0000000000000000000000000000000000000001") {
      errors.push(`Invalid quote token address: ${pool.quoteToken.address}`);
    }

    // 4. Decimals Sanity
    if (pool.baseToken.decimals < this.MIN_VALID_DECIMALS || pool.baseToken.decimals > this.MAX_VALID_DECIMALS) {
      errors.push(`Base token decimals out of bounds: ${pool.baseToken.decimals}`);
    }
    if (pool.quoteToken.decimals < this.MIN_VALID_DECIMALS || pool.quoteToken.decimals > this.MAX_VALID_DECIMALS) {
      errors.push(`Quote token decimals out of bounds: ${pool.quoteToken.decimals}`);
    }

    // 5. Data Freshness Warnings
    if (pool.freshness === "EXPIRED") {
      warnings.push(`Data is expired (age: ${(pool.ageMs / 1000).toFixed(1)}s)`);
    } else if (pool.freshness === "STALE") {
      warnings.push(`Data is stale (age: ${(pool.ageMs / 1000).toFixed(1)}s)`);
    }

    // 6. Liquidity Warning
    if (pool.liquidityUsd < 100.0) {
      warnings.push(`Extremely low pool depth (Liquidity: $${pool.liquidityUsd.toFixed(2)} USD)`);
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }
}
