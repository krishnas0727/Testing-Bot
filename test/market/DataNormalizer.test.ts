import { expect } from "chai";
import { ethers } from "ethers";
import { DataNormalizer } from "../../src/market/normalizer/DataNormalizer";
import { RawPoolData } from "../../src/market/types";

describe("Phase 3: DataNormalizer Unit Tests", () => {
  const baseRaw: RawPoolData = {
    dexName: "Uniswap_V2",
    protocol: "UNISWAP_V2",
    chainId: 8453,
    poolAddress: "0x1111111111111111111111111111111111111111",
    token0Address: "0x4200000000000000000000000000000000000006", // WETH
    token1Address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC
    token0Symbol: "WETH",
    token1Symbol: "USDC",
    token0Decimals: 18,
    token1Decimals: 6,
    // 100 WETH (18 dec), 320,000 USDC (6 dec) -> Spot Price = 3,200 USDC / WETH
    rawReserve0: ethers.parseUnits("100.0", 18),
    rawReserve1: ethers.parseUnits("320000.0", 6),
    feeBps: 30, // 0.30%
    blockNumber: 19800000,
    blockTimestamp: Math.floor(Date.now() / 1000),
    fetchedAt: Date.now()
  };

  it("should accurately normalize 18/6 decimal pairs (WETH/USDC)", () => {
    const normalized = DataNormalizer.normalize(baseRaw, "WETH", "USDC");

    expect(normalized.pairSymbol).to.equal("WETH/USDC");
    expect(normalized.baseToken.symbol).to.equal("WETH");
    expect(normalized.baseToken.decimals).to.equal(18);
    expect(normalized.baseToken.reserve).to.equal(100.0);

    expect(normalized.quoteToken.symbol).to.equal("USDC");
    expect(normalized.quoteToken.decimals).to.equal(6);
    expect(normalized.quoteToken.reserve).to.equal(320000.0);

    // Spot Price = 320,000 / 100 = 3200.0
    expect(normalized.spotPrice).to.equal(3200.0);
    expect(normalized.inversePrice).to.be.closeTo(1 / 3200.0, 0.000001);

    // Liquidity USD = 2 * 320,000 = 640,000
    expect(normalized.liquidityUsd).to.equal(640000.0);

    expect(normalized.feeBps).to.equal(30);
    expect(normalized.feePct).to.equal(0.003);
    expect(normalized.isValid).to.be.true;
    expect(normalized.freshness).to.equal("FRESH");
  });

  it("should handle inverted token ordering correctly (USDC as base, WETH as quote)", () => {
    const normalized = DataNormalizer.normalize(baseRaw, "USDC", "WETH");

    expect(normalized.pairSymbol).to.equal("USDC/WETH");
    expect(normalized.baseToken.symbol).to.equal("USDC");
    expect(normalized.baseToken.reserve).to.equal(320000.0);

    expect(normalized.quoteToken.symbol).to.equal("WETH");
    expect(normalized.quoteToken.reserve).to.equal(100.0);

    // Spot Price = 100 / 320,000 = 0.0003125 WETH per USDC
    expect(normalized.spotPrice).to.be.closeTo(1 / 3200.0, 0.000001);
  });

  it("should correctly evaluate freshness lifecycle (FRESH, STALE, EXPIRED)", () => {
    expect(DataNormalizer.evaluateFreshness(2000)).to.equal("FRESH");
    expect(DataNormalizer.evaluateFreshness(5999)).to.equal("FRESH");
    expect(DataNormalizer.evaluateFreshness(6001)).to.equal("STALE");
    expect(DataNormalizer.evaluateFreshness(25000)).to.equal("STALE");
    expect(DataNormalizer.evaluateFreshness(30001)).to.equal("EXPIRED");
    expect(DataNormalizer.evaluateFreshness(100000)).to.equal("EXPIRED");
    expect(DataNormalizer.evaluateFreshness(-5)).to.equal("UNINITIALIZED");
  });
});
