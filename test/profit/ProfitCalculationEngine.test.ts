import { expect } from "chai";
import { ethers } from "ethers";
import { ProfitCalculationEngine } from "../../src/profit/ProfitCalculationEngine";
import { ProfitCalculationParams } from "../../src/profit/types";

describe("Phase 5: ProfitCalculationEngine Unit & Edge Case Tests", () => {
  // Benchmark setup:
  // Buy DEX: Uniswap V2 (100 WETH / 300,000 USDT -> Spot = $3000.0)
  // Sell DEX: SushiSwap V2 (100 WETH / 306,000 USDT -> Spot = $3060.0, a 2.0% spread)
  const baseParams: ProfitCalculationParams = {
    opportunityId: "opp_unit_test",
    chainId: 8453,
    buyDex: "Uniswap_V2",
    sellDex: "SushiSwap_V2",
    baseSymbol: "WETH",
    quoteSymbol: "USDT",
    baseDecimals: 18,
    quoteDecimals: 6,
    tradeAmountFormatted: 50.0, // $50 trade
    buyPoolReserves: {
      reserveBase: ethers.parseUnits("100.0", 18),
      reserveQuote: ethers.parseUnits("300000.0", 6),
      feeBps: 30
    },
    sellPoolReserves: {
      reserveBase: ethers.parseUnits("100.0", 18),
      reserveQuote: ethers.parseUnits("306000.0", 6),
      feeBps: 30
    },
    gasPriceGwei: 0.006, // Base L2 sub-cent gas
    ethPriceUsdt: 3000.0,
    estimatedGasUnits: 250000n,
    l1DataFeeUsdt: 0.0005,
    slippageTolerancePct: 0.50,
    maxPriceImpactPct: 1.00,
    minProfitUsdt: 0.05,
    safetyMarginUsdt: 0.02,
    otherExecutionCostsUsdt: 0.0
  };

  it("should calculate complete profitability breakdown for a profitable trade", () => {
    const result = ProfitCalculationEngine.calculateProfitability(baseParams);

    // Initial Capital: $50.00
    expect(result.tradeSizeFormatted).to.equal(50.0);
    expect(result.initialCapitalRaw).to.equal(50000000n); // 50 * 10^6

    // Expected Output should be > Initial Capital on a 2% spread
    expect(result.expectedOutputFormatted).to.be.greaterThan(50.0);

    // Gross Profit = Output - Input
    expect(result.grossProfitUsdt).to.be.closeTo(result.expectedOutputFormatted - 50.0, 0.0001);
    expect(result.grossProfitUsdt).to.be.greaterThan(0);

    // Gas Cost should be around ~$0.005 on Base L2
    expect(result.gasCostUsdt).to.be.closeTo(0.005, 0.002);

    // Net Profit = Gross Profit - Gas Cost - Safety Margin ($0.02)
    const expectedNet = result.grossProfitUsdt - result.gasCostUsdt - 0.02;
    expect(result.netProfitUsdt).to.be.closeTo(expectedNet, 0.0001);

    // ROI = (Net Profit / 50.0) * 100
    const expectedRoi = (result.netProfitUsdt / 50.0) * 100.0;
    expect(result.roiPct).to.be.closeTo(expectedRoi, 0.01);

    // Check DEX Fees
    expect(result.totalDexFeesUsdt).to.be.greaterThan(0);

    // Verification status
    expect(result.status).to.equal("PROFITABLE");
    expect(result.isExecutable).to.be.true;
    expect(result.isEstimate).to.be.true;
  });

  it("should handle small micro-trade ($0.10) safely", () => {
    const result = ProfitCalculationEngine.calculateProfitability({
      ...baseParams,
      tradeAmountFormatted: 0.10,
      minProfitUsdt: 0.0001,
      safetyMarginUsdt: 0.0001
    });

    expect(result.tradeSizeFormatted).to.equal(0.10);
    expect(result.combinedPriceImpactPct).to.be.lessThan(0.01);
    expect(result.isEstimate).to.be.true;
  });

  it("should handle large trade ($500.00) and measure higher price impact", () => {
    const result = ProfitCalculationEngine.calculateProfitability({
      ...baseParams,
      tradeAmountFormatted: 500.0
    });

    expect(result.tradeSizeFormatted).to.equal(500.0);
    // Price impact on $500 trade should be greater than on $50 trade
    const smallResult = ProfitCalculationEngine.calculateProfitability(baseParams);
    expect(result.combinedPriceImpactPct).to.be.greaterThan(smallResult.combinedPriceImpactPct);
  });

  it("should reject trade when price impact exceeds max safety limit", () => {
    // Ultra shallow pool (e.g. only 0.01 WETH / 30 USDT)
    const result = ProfitCalculationEngine.calculateProfitability({
      ...baseParams,
      tradeAmountFormatted: 25.0, // $25 trade on $30 pool drains it!
      buyPoolReserves: {
        reserveBase: ethers.parseUnits("0.01", 18),
        reserveQuote: ethers.parseUnits("30.0", 6),
        feeBps: 30
      },
      maxPriceImpactPct: 1.00 // Strict 1.0% limit
    });

    expect(result.isExecutable).to.be.false;
    expect(result.status).to.equal("PRICE_IMPACT_EXCEEDED");
    expect(result.rejectionReason).to.include("Price impact");
  });

  it("should reject trade when net profit is negative due to fees and gas", () => {
    // Zero spread between pools (both at $3000.0) -> Output will be less than input after 0.6% fees
    const result = ProfitCalculationEngine.calculateProfitability({
      ...baseParams,
      sellPoolReserves: {
        reserveBase: ethers.parseUnits("100.0", 18),
        reserveQuote: ethers.parseUnits("300000.0", 6), // Same as buy pool
        feeBps: 30
      }
    });

    expect(result.isExecutable).to.be.false;
    expect(result.status).to.equal("UNPROFITABLE_NEGATIVE_NET");
    expect(result.netProfitUsdt).to.be.lessThan(0);
    expect(result.rejectionReason).to.include("negative");
  });

  it("should reject trade when net profit is below configured minimum threshold", () => {
    // Spread gives +$0.02 net profit, but minimum required is $0.10
    const result = ProfitCalculationEngine.calculateProfitability({
      ...baseParams,
      tradeAmountFormatted: 5.0,
      minProfitUsdt: 0.50 // High minimum profit threshold
    });

    expect(result.isExecutable).to.be.false;
    expect(result.status).to.equal("BELOW_MIN_PROFIT");
    expect(result.rejectionReason).to.include("below minimum threshold");
  });

  it("should correctly deduct additional execution costs (e.g. MEV tip)", () => {
    const withoutCost = ProfitCalculationEngine.calculateProfitability(baseParams);
    const withCost = ProfitCalculationEngine.calculateProfitability({
      ...baseParams,
      otherExecutionCostsUsdt: 0.15 // $0.15 MEV tip
    });

    expect(withCost.otherCostsUsdt).to.equal(0.15);
    expect(withCost.netProfitUsdt).to.be.closeTo(withoutCost.netProfitUsdt - 0.15, 0.0001);
  });
});
