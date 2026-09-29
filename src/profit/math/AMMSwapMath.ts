/**
 * @file AMMSwapMath.ts
 * @description Precise integer/fixed-point arithmetic for constant-product AMM swaps, fees, and price impact
 */

import { ethers } from "ethers";

export class AMMSwapMath {
  public static readonly BPS_DENOMINATOR = 10000n;

  /**
   * Calculates swap output amount using Uniswap V2 constant-product integer arithmetic:
   * dy = (reserveOut * amountInWithFee) / (reserveIn * 10000 + amountInWithFee)
   */
  public static getAmountOut(
    amountIn: bigint,
    reserveIn: bigint,
    reserveOut: bigint,
    feeBps: number = 30
  ): bigint {
    if (amountIn <= 0n) return 0n;
    if (reserveIn <= 0n || reserveOut <= 0n) return 0n;

    const feeMultiplier = this.BPS_DENOMINATOR - BigInt(feeBps);
    const amountInWithFee = amountIn * feeMultiplier;
    const numerator = amountInWithFee * reserveOut;
    const denominator = (reserveIn * this.BPS_DENOMINATOR) + amountInWithFee;

    if (denominator <= 0n) return 0n;
    return numerator / denominator;
  }

  /**
   * Calculates swap fee portion extracted by the AMM pool
   */
  public static calculateFee(amountIn: bigint, feeBps: number = 30): bigint {
    if (amountIn <= 0n) return 0n;
    return (amountIn * BigInt(feeBps)) / this.BPS_DENOMINATOR;
  }

  /**
   * Computes price impact percentage: |spotPrice - executionPrice| / spotPrice * 100
   */
  public static calculatePriceImpact(
    amountInFloat: number,
    amountOutFloat: number,
    reserveInFloat: number,
    reserveOutFloat: number
  ): number {
    if (amountInFloat <= 0 || reserveInFloat <= 0 || reserveOutFloat <= 0) return 0.0;

    const spotPrice = reserveOutFloat / reserveInFloat;
    const executionPrice = amountOutFloat / amountInFloat;

    if (spotPrice <= 0) return 0.0;
    const impact = Math.abs((spotPrice - executionPrice) / spotPrice) * 100.0;
    return Math.max(0.0, Number(impact.toFixed(4)));
  }

  /**
   * Calculates minimum output after slippage tolerance
   */
  public static applySlippage(amountOut: bigint, slippagePct: number): bigint {
    if (amountOut <= 0n) return 0n;
    const slippageBps = BigInt(Math.max(0, Math.min(5000, Math.round(slippagePct * 100))));
    return (amountOut * (this.BPS_DENOMINATOR - slippageBps)) / this.BPS_DENOMINATOR;
  }

  /**
   * Formats raw wei bigint to floating point number
   */
  public static formatUnits(amountRaw: bigint, decimals: number): number {
    return Number(ethers.formatUnits(amountRaw, decimals));
  }

  /**
   * Parses floating point number to raw wei bigint
   */
  public static parseUnits(amountFloat: number, decimals: number): bigint {
    if (isNaN(amountFloat) || amountFloat <= 0) return 0n;
    const fixedStr = amountFloat.toFixed(Math.min(decimals, 18));
    return ethers.parseUnits(fixedStr, decimals);
  }
}
