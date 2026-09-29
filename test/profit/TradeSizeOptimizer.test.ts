import { expect } from "chai";
import { ethers } from "ethers";
import { TradeSizeOptimizer } from "../../src/profit/TradeSizeOptimizer";

describe("Phase 5: TradeSizeOptimizer Unit Tests", () => {
  const baseParams = {
    opportunityId: "opp_optimizer_test",
    chainId: 8453 as const,
    buyDex: "Uniswap_V2",
    sellDex: "SushiSwap_V2",
    baseSymbol: "WETH",
    quoteSymbol: "USDT",
    baseDecimals: 18,
    quoteDecimals: 6,
    buyPoolReserves: {
      reserveBase: ethers.parseUnits("50.0", 18),
      reserveQuote: ethers.parseUnits("150000.0", 6), // Spot = $3000
      feeBps: 30
    },
    sellPoolReserves: {
      reserveBase: ethers.parseUnits("50.0", 18),
      reserveQuote: ethers.parseUnits("153000.0", 6), // Spot = $3060 (2.0% spread)
      feeBps: 30
    },
    gasPriceGwei: 0.006,
    ethPriceUsdt: 3000.0,
    minProfitUsdt: 0.01,
    maxPriceImpactPct: 1.00,
    safetyMarginUsdt: 0.01
  };

  it("should evaluate multiple trade sizes and pick the size with highest net profit", () => {
    const candidateSizes = [1.0, 5.0, 10.0, 25.0, 50.0, 100.0];
    const result = TradeSizeOptimizer.optimizeTradeSize(baseParams, candidateSizes);

    expect(result.allBreakdowns).to.have.lengthOf(candidateSizes.length);
    expect(result.optimalTradeSize).to.be.greaterThan(0);
    expect(result.maxNetProfitUsdt).to.be.greaterThan(0);
    expect(result.bestBreakdown).to.not.be.null;
    expect(result.bestBreakdown?.isExecutable).to.be.true;

    // Check that best breakdown has maximum net profit among all evaluated
    for (const b of result.allBreakdowns) {
      if (b.isExecutable) {
        expect(result.maxNetProfitUsdt).to.be.greaterThanOrEqual(b.netProfitUsdt);
      }
    }
  });

  it("should return zero optimal size when all sizes are unprofitable", () => {
    // Zero spread between pools
    const unprofitableParams = {
      ...baseParams,
      sellPoolReserves: {
        ...baseParams.buyPoolReserves
      }
    };

    const candidateSizes = [5.0, 10.0, 20.0];
    const result = TradeSizeOptimizer.optimizeTradeSize(unprofitableParams, candidateSizes);

    expect(result.optimalTradeSize).to.equal(0);
    expect(result.maxNetProfitUsdt).to.equal(0);
    expect(result.bestBreakdown).to.be.null;
  });

  it("should handle shallow liquidity by preferring small size over oversized trades", () => {
    // Very shallow pool ($500 liquidity): $1 trade works with < 1% impact, but $50 trade incurs > 10% impact
    const shallowParams = {
      ...baseParams,
      buyPoolReserves: {
        reserveBase: ethers.parseUnits("0.1", 18),
        reserveQuote: ethers.parseUnits("300.0", 6),
        feeBps: 30
      },
      sellPoolReserves: {
        reserveBase: ethers.parseUnits("0.1", 18),
        reserveQuote: ethers.parseUnits("315.0", 6), // 5% spread
        feeBps: 30
      },
      maxPriceImpactPct: 2.00
    };

    const result = TradeSizeOptimizer.optimizeTradeSize(shallowParams, [0.5, 1.0, 50.0, 100.0]);

    // $50 and $100 trades should fail due to price impact, while smaller trade is accepted
    const largeTrade = result.allBreakdowns.find(b => b.tradeSizeFormatted === 50.0);
    expect(largeTrade?.isExecutable).to.be.false;
    expect(largeTrade?.status).to.equal("PRICE_IMPACT_EXCEEDED");

    if (result.bestBreakdown) {
      expect(result.bestBreakdown.tradeSizeFormatted).to.be.lessThan(50.0);
    }
  });
});
