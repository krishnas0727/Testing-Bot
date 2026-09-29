/**
 * @file GasCostCalculator.ts
 * @description Computes multi-chain transaction execution gas and L1 data availability fees in USD
 */

import { SupportedChainId } from "../../types";

export class GasCostCalculator {
  public static readonly DEFAULT_ARBITRAGE_GAS_UNITS = 250000n; // 2-hop atomic execution

  /**
   * Calculates total execution gas fee in USD
   * @param gasUnits Estimated gas units consumed by smart contract
   * @param gasPriceGwei Live gas price in Gwei
   * @param ethPriceUsdt Live native ETH / POL price in USD
   * @param chainId Blockchain network identifier
   * @param l1DataFeeUsdt Additional L1 rollup submission fee (Base/Arbitrum)
   */
  public static calculateGasCost(
    gasUnits: bigint = this.DEFAULT_ARBITRAGE_GAS_UNITS,
    gasPriceGwei: number,
    ethPriceUsdt: number,
    _chainId: SupportedChainId = 8453,
    l1DataFeeUsdt: number = 0.0
  ): { gasCostUsdt: number; gasUnits: bigint; l1FeeUsdt: number } {
    if (gasUnits <= 0n || gasPriceGwei <= 0 || ethPriceUsdt <= 0) {
      return { gasCostUsdt: 0.0, gasUnits, l1FeeUsdt: 0.0 };
    }

    // gasCostNative = gasUnits * (gasPriceGwei * 1e-9)
    const gasPriceEth = gasPriceGwei * 1e-9;
    const l2ExecutionCostNative = Number(gasUnits) * gasPriceEth;
    const l2ExecutionCostUsd = l2ExecutionCostNative * ethPriceUsdt;

    const totalGasCostUsd = l2ExecutionCostUsd + Math.max(0, l1DataFeeUsdt);

    return {
      gasCostUsdt: Number(totalGasCostUsd.toFixed(6)),
      gasUnits,
      l1FeeUsdt: l1DataFeeUsdt
    };
  }
}
