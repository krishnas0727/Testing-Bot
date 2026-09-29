import { expect } from "chai";
import { ethers } from "ethers";
import { AMMSwapMath } from "../../src/profit/math/AMMSwapMath";

describe("Phase 5: AMMSwapMath Unit Tests", () => {
  it("should calculate exact Uniswap V2 constant-product swap output", () => {
    // Pool: 100 WETH (18 dec) / 300,000 USDT (6 dec)
    // Swap: 1,000 USDT in -> Expect ~0.3322 WETH out (after 0.30% fee)
    const reserveIn = ethers.parseUnits("300000.0", 6);
    const reserveOut = ethers.parseUnits("100.0", 18);
    const amountIn = ethers.parseUnits("1000.0", 6);

    const amountOutRaw = AMMSwapMath.getAmountOut(amountIn, reserveIn, reserveOut, 30);
    const amountOutFloat = AMMSwapMath.formatUnits(amountOutRaw, 18);

    // Theoretical: (100 * 997 * 1000) / (300000 * 10000 + 997 * 1000) = 99700 / 3000997 ≈ 0.332223 WETH
    expect(amountOutFloat).to.be.closeTo(0.332223, 0.0001);
    expect(amountOutRaw).to.be.greaterThan(0n);
  });

  it("should return zero output for zero input or zero reserves", () => {
    const reserve = ethers.parseUnits("1000.0", 18);
    expect(AMMSwapMath.getAmountOut(0n, reserve, reserve, 30)).to.equal(0n);
    expect(AMMSwapMath.getAmountOut(100n, 0n, reserve, 30)).to.equal(0n);
    expect(AMMSwapMath.getAmountOut(100n, reserve, 0n, 30)).to.equal(0n);
  });

  it("should calculate exact fee portion extracted by pool", () => {
    // 10,000 units with 30 bps (0.30%) fee -> 30 units
    const amountIn = 10000n;
    const fee = AMMSwapMath.calculateFee(amountIn, 30);
    expect(fee).to.equal(30n);

    // 1,000,000 USDT wei (1 USDT) with 30 bps -> 3,000 wei (0.003 USDT)
    const usdtIn = 1000000n;
    expect(AMMSwapMath.calculateFee(usdtIn, 30)).to.equal(3000n);
  });

  it("should calculate accurate price impact percentage", () => {
    // Small trade: $10 on $300,000 pool -> negligible impact (< 0.01%)
    const smallImpact = AMMSwapMath.calculatePriceImpact(10.0, 0.003333, 300000.0, 100.0);
    expect(smallImpact).to.be.lessThan(0.01);

    // Large trade: $150,000 on $300,000 pool (50% of pool) -> significant impact (~33%)
    const largeOut = (100.0 * 150000.0 * 0.997) / (300000.0 + 150000.0 * 0.997);
    const largeImpact = AMMSwapMath.calculatePriceImpact(150000.0, largeOut, 300000.0, 100.0);
    expect(largeImpact).to.be.greaterThan(30.0);
  });

  it("should apply slippage tolerance correctly to determine minimum output", () => {
    const amountOut = 1000000n; // 1.0 USDT
    // 0.5% slippage -> 99.5% minimum output
    const minOut = AMMSwapMath.applySlippage(amountOut, 0.50);
    expect(minOut).to.equal(995000n);

    // 1.0% slippage -> 99.0%
    expect(AMMSwapMath.applySlippage(amountOut, 1.00)).to.equal(990000n);
  });

  it("should handle multi-decimal conversions without rounding errors", () => {
    // 6 decimals (USDT/USDC)
    const raw6 = AMMSwapMath.parseUnits(12.345678, 6);
    expect(raw6).to.equal(12345678n);
    expect(AMMSwapMath.formatUnits(raw6, 6)).to.equal(12.345678);

    // 18 decimals (WETH/DAI)
    const raw18 = AMMSwapMath.parseUnits(1.5, 18);
    expect(raw18).to.equal(1500000000000000000n);
    expect(AMMSwapMath.formatUnits(raw18, 18)).to.equal(1.5);
  });
});
