/**
 * @file ProfitCalculationEngine.ts
 * @description Phase 5 Core Engine: Computes executable swap output, fees, impact, slippage, gas, and net profit
 */

import { AMMSwapMath } from "./math/AMMSwapMath";
import { GasCostCalculator } from "./math/GasCostCalculator";
import {
  ProfitCalculationBreakdown,
  ProfitCalculationParams,
  ProfitabilityStatus,
  SwapLegQuote
} from "./types";

export class ProfitCalculationEngine {
  /**
   * Computes complete profitability breakdown for an arbitrage opportunity
   */
  public static calculateProfitability(
    params: ProfitCalculationParams
  ): ProfitCalculationBreakdown {
    const oppId = params.opportunityId || `opp_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const calcTimestamp = Date.now();
    const sourceBlock = params.sourceBlock || 0;
    const pairSymbol = `${params.baseSymbol}/${params.quoteSymbol}`;

    // 1. Initial Capital Conversion to Raw Wei
    const initialCapitalRaw = AMMSwapMath.parseUnits(
      params.tradeAmountFormatted,
      params.quoteDecimals
    );

    // 2. Leg 1: Buy Swap Quote (Swap Quote -> Base on Buy DEX)
    // In Leg 1, we put in Quote tokens (e.g. USDT) and receive Base tokens (e.g. WETH)
    const buyFeeBps = params.buyPoolReserves.feeBps || 30;
    const leg1AmountOutRaw = AMMSwapMath.getAmountOut(
      initialCapitalRaw,
      params.buyPoolReserves.reserveQuote,
      params.buyPoolReserves.reserveBase,
      buyFeeBps
    );

    const leg1FeeRaw = AMMSwapMath.calculateFee(initialCapitalRaw, buyFeeBps);
    const leg1AmountInFormatted = params.tradeAmountFormatted;
    const leg1AmountOutFormatted = AMMSwapMath.formatUnits(leg1AmountOutRaw, params.baseDecimals);
    const leg1FeeFormatted = AMMSwapMath.formatUnits(leg1FeeRaw, params.quoteDecimals);

    const buyReserveBaseFloat = AMMSwapMath.formatUnits(params.buyPoolReserves.reserveBase, params.baseDecimals);
    const buyReserveQuoteFloat = AMMSwapMath.formatUnits(params.buyPoolReserves.reserveQuote, params.quoteDecimals);

    const leg1SpotPrice = buyReserveBaseFloat > 0 ? (buyReserveQuoteFloat / buyReserveBaseFloat) : 0;
    const leg1ExecutionPrice = leg1AmountOutFormatted > 0 ? (leg1AmountInFormatted / leg1AmountOutFormatted) : 0;
    const leg1PriceImpact = AMMSwapMath.calculatePriceImpact(
      leg1AmountInFormatted,
      leg1AmountOutFormatted,
      buyReserveQuoteFloat,
      buyReserveBaseFloat
    );

    const leg1Buy: SwapLegQuote = {
      dexName: params.buyDex,
      tokenInSymbol: params.quoteSymbol,
      tokenOutSymbol: params.baseSymbol,
      tokenInDecimals: params.quoteDecimals,
      tokenOutDecimals: params.baseDecimals,
      amountInRaw: initialCapitalRaw,
      amountInFormatted: leg1AmountInFormatted,
      amountOutRaw: leg1AmountOutRaw,
      amountOutFormatted: leg1AmountOutFormatted,
      feeRaw: leg1FeeRaw,
      feeFormatted: leg1FeeFormatted,
      feeBps: buyFeeBps,
      spotPrice: leg1SpotPrice,
      executionPrice: leg1ExecutionPrice,
      priceImpactPct: leg1PriceImpact
    };

    // 3. Leg 2: Sell Swap Quote (Swap Base -> Quote on Sell DEX)
    // In Leg 2, we put in Base tokens received from Leg 1 and receive Quote tokens back
    const sellFeeBps = params.sellPoolReserves.feeBps || 30;
    const leg2AmountOutRaw = AMMSwapMath.getAmountOut(
      leg1AmountOutRaw,
      params.sellPoolReserves.reserveBase,
      params.sellPoolReserves.reserveQuote,
      sellFeeBps
    );

    const leg2FeeRaw = AMMSwapMath.calculateFee(leg1AmountOutRaw, sellFeeBps);
    const leg2AmountInFormatted = leg1AmountOutFormatted;
    const leg2AmountOutFormatted = AMMSwapMath.formatUnits(leg2AmountOutRaw, params.quoteDecimals);
    const leg2FeeRawInQuote = (leg2FeeRaw * params.sellPoolReserves.reserveQuote) / (params.sellPoolReserves.reserveBase > 0n ? params.sellPoolReserves.reserveBase : 1n);
    const leg2FeeFormatted = AMMSwapMath.formatUnits(leg2FeeRawInQuote, params.quoteDecimals);

    const sellReserveBaseFloat = AMMSwapMath.formatUnits(params.sellPoolReserves.reserveBase, params.baseDecimals);
    const sellReserveQuoteFloat = AMMSwapMath.formatUnits(params.sellPoolReserves.reserveQuote, params.quoteDecimals);

    const leg2SpotPrice = sellReserveBaseFloat > 0 ? (sellReserveQuoteFloat / sellReserveBaseFloat) : 0;
    const leg2ExecutionPrice = leg2AmountInFormatted > 0 ? (leg2AmountOutFormatted / leg2AmountInFormatted) : 0;
    const leg2PriceImpact = AMMSwapMath.calculatePriceImpact(
      leg2AmountInFormatted,
      leg2AmountOutFormatted,
      sellReserveBaseFloat,
      sellReserveQuoteFloat
    );

    const leg2Sell: SwapLegQuote = {
      dexName: params.sellDex,
      tokenInSymbol: params.baseSymbol,
      tokenOutSymbol: params.quoteSymbol,
      tokenInDecimals: params.baseDecimals,
      tokenOutDecimals: params.quoteDecimals,
      amountInRaw: leg1AmountOutRaw,
      amountInFormatted: leg2AmountInFormatted,
      amountOutRaw: leg2AmountOutRaw,
      amountOutFormatted: leg2AmountOutFormatted,
      feeRaw: leg2FeeRaw,
      feeFormatted: leg2FeeFormatted,
      feeBps: sellFeeBps,
      spotPrice: leg2SpotPrice,
      executionPrice: leg2ExecutionPrice,
      priceImpactPct: leg2PriceImpact
    };

    // 4. Expected Output & Slippage
    const expectedOutputRaw = leg2AmountOutRaw;
    const expectedOutputFormatted = leg2AmountOutFormatted;
    const slippagePct = params.slippageTolerancePct || 0.50;
    const minOutputWithSlippageRaw = AMMSwapMath.applySlippage(expectedOutputRaw, slippagePct);
    const minOutputWithSlippageFormatted = AMMSwapMath.formatUnits(minOutputWithSlippageRaw, params.quoteDecimals);

    // 5. Total DEX Fees in Quote Terms
    const totalDexFeesUsdt = Number((leg1FeeFormatted + leg2FeeFormatted).toFixed(6));
    const combinedPriceImpactPct = Number(Math.max(leg1PriceImpact, leg2PriceImpact).toFixed(4));

    // 6. Gas Estimation
    const gasUnits = params.estimatedGasUnits || GasCostCalculator.DEFAULT_ARBITRAGE_GAS_UNITS;
    const gasResult = GasCostCalculator.calculateGasCost(
      gasUnits,
      params.gasPriceGwei,
      params.ethPriceUsdt,
      params.chainId,
      params.l1DataFeeUsdt || 0.0
    );
    const gasCostUsdt = gasResult.gasCostUsdt;

    // 7. Other Costs & Safety Margin
    const otherCostsUsdt = Number((params.otherExecutionCostsUsdt || 0.0).toFixed(6));
    const safetyMarginUsdt = Number((params.safetyMarginUsdt || 0.0).toFixed(6));
    const minRequiredProfitUsdt = Number((params.minProfitUsdt || 0.01).toFixed(6));
    const maxAllowedImpact = params.maxPriceImpactPct || 1.0;

    // 8. Gross Profit, Net Profit, and ROI Calculation
    // Gross Profit = Expected Output - Initial Capital
    const grossProfitUsdt = Number((expectedOutputFormatted - params.tradeAmountFormatted).toFixed(6));

    // Net Profit = Final Output - Initial Capital - Gas Cost - Other Execution Costs - Safety Margin
    const netProfitUsdt = Number((grossProfitUsdt - gasCostUsdt - otherCostsUsdt - safetyMarginUsdt).toFixed(6));

    // ROI (%) = (Net Profit / Initial Capital) * 100
    const roiPct = params.tradeAmountFormatted > 0
      ? Number(((netProfitUsdt / params.tradeAmountFormatted) * 100.0).toFixed(4))
      : 0.0;

    // 9. Status & Risk Gating Evaluation
    let status: ProfitabilityStatus = "PROFITABLE";
    let isExecutable = true;
    let rejectionReason: string | undefined = undefined;

    if (leg1AmountOutRaw <= 0n || leg2AmountOutRaw <= 0n) {
      status = "INSUFFICIENT_LIQUIDITY";
      isExecutable = false;
      rejectionReason = "Pool liquidity insufficient to compute positive swap output";
    } else if (combinedPriceImpactPct > maxAllowedImpact) {
      status = "PRICE_IMPACT_EXCEEDED";
      isExecutable = false;
      rejectionReason = `Price impact (${combinedPriceImpactPct.toFixed(2)}%) exceeds safety limit (${maxAllowedImpact.toFixed(2)}%)`;
    } else if (netProfitUsdt <= 0) {
      status = "UNPROFITABLE_NEGATIVE_NET";
      isExecutable = false;
      rejectionReason = `Expected net profit is negative (-$${Math.abs(netProfitUsdt).toFixed(4)} USDT) after gas and protocol fees`;
    } else if (netProfitUsdt < minRequiredProfitUsdt) {
      status = "BELOW_MIN_PROFIT";
      isExecutable = false;
      rejectionReason = `Net profit ($${netProfitUsdt.toFixed(4)} USDT) is below minimum threshold ($${minRequiredProfitUsdt.toFixed(4)} USDT)`;
    }

    return {
      opportunityId: oppId,
      chainId: params.chainId,
      buyDex: params.buyDex,
      sellDex: params.sellDex,
      pairSymbol,
      sourceBlock,
      calculationTimestamp: calcTimestamp,

      tradeSizeFormatted: params.tradeAmountFormatted,
      initialCapitalRaw,
      expectedOutputRaw,
      expectedOutputFormatted,

      leg1Buy,
      leg2Sell,

      totalDexFeesUsdt,
      combinedPriceImpactPct,
      expectedSlippagePct: slippagePct,
      minOutputWithSlippageFormatted,

      estimatedGasUnits: gasUnits,
      gasPriceGwei: params.gasPriceGwei,
      gasCostUsdt,
      otherCostsUsdt,
      safetyMarginUsdt,

      grossProfitUsdt,
      netProfitUsdt,
      roiPct,

      minRequiredProfitUsdt,
      status,
      isExecutable,
      rejectionReason,

      isEstimate: true
    };
  }
}
