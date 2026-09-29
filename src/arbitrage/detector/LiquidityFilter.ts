/**
 * @file LiquidityFilter.ts
 * @description Validates pool liquidity and reserve depth before considering candidate routes
 */

import { NormalizedPoolState } from "../../market/types";

export interface LiquidityCheckResult {
  hasSufficientLiquidity: boolean;
  rejectionReason?: string;
  buyPoolLiquidityUsd: number;
  sellPoolLiquidityUsd: number;
}

export class LiquidityFilter {
  public static readonly DEFAULT_MIN_LIQUIDITY_USD = 1000.0;
  public static readonly MAX_TRADE_SIZE_TO_POOL_RATIO = 0.25; // Trade size cannot exceed 25% of pool reserve

  /**
   * Verifies both pools meet liquidity requirements for trade size
   */
  public static checkLiquidity(
    buyPool: NormalizedPoolState,
    sellPool: NormalizedPoolState,
    tradeSizeUsd: number,
    minLiquidityUsd: number = this.DEFAULT_MIN_LIQUIDITY_USD
  ): LiquidityCheckResult {
    const buyLiq = buyPool.liquidityUsd || 0;
    const sellLiq = sellPool.liquidityUsd || 0;

    // 1. Minimum USD liquidity threshold check
    if (buyLiq < minLiquidityUsd) {
      return {
        hasSufficientLiquidity: false,
        rejectionReason: `Buy pool (${buyPool.dexName}) liquidity ($${buyLiq.toFixed(2)}) is below minimum requirement ($${minLiquidityUsd.toFixed(2)})`,
        buyPoolLiquidityUsd: buyLiq,
        sellPoolLiquidityUsd: sellLiq
      };
    }

    if (sellLiq < minLiquidityUsd) {
      return {
        hasSufficientLiquidity: false,
        rejectionReason: `Sell pool (${sellPool.dexName}) liquidity ($${sellLiq.toFixed(2)}) is below minimum requirement ($${minLiquidityUsd.toFixed(2)})`,
        buyPoolLiquidityUsd: buyLiq,
        sellPoolLiquidityUsd: sellLiq
      };
    }

    // 2. Ratio check: Trade size relative to pool quote reserve
    const maxAllowedTradeBuy = buyPool.quoteToken.reserve * this.MAX_TRADE_SIZE_TO_POOL_RATIO;
    const maxAllowedTradeSell = sellPool.quoteToken.reserve * this.MAX_TRADE_SIZE_TO_POOL_RATIO;

    if (tradeSizeUsd > maxAllowedTradeBuy) {
      return {
        hasSufficientLiquidity: false,
        rejectionReason: `Trade size ($${tradeSizeUsd.toFixed(2)}) exceeds 25% of buy pool quote reserve ($${buyPool.quoteToken.reserve.toFixed(2)})`,
        buyPoolLiquidityUsd: buyLiq,
        sellPoolLiquidityUsd: sellLiq
      };
    }

    if (tradeSizeUsd > maxAllowedTradeSell) {
      return {
        hasSufficientLiquidity: false,
        rejectionReason: `Trade size ($${tradeSizeUsd.toFixed(2)}) exceeds 25% of sell pool quote reserve ($${sellPool.quoteToken.reserve.toFixed(2)})`,
        buyPoolLiquidityUsd: buyLiq,
        sellPoolLiquidityUsd: sellLiq
      };
    }

    return {
      hasSufficientLiquidity: true,
      buyPoolLiquidityUsd: buyLiq,
      sellPoolLiquidityUsd: sellLiq
    };
  }
}
