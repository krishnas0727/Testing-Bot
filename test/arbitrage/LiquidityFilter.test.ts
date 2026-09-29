import { expect } from "chai";
import { ethers } from "ethers";
import { LiquidityFilter } from "../../src/arbitrage/detector/LiquidityFilter";
import { NormalizedPoolState } from "../../src/market/types";

describe("Phase 4: LiquidityFilter Unit Tests", () => {
  const createMockPool = (
    dexName: string,
    reserveQuote: number,
    liquidityUsd: number
  ): NormalizedPoolState => ({
    id: `8453:${dexName}:WETH-USDT`,
    chainId: 8453,
    dexName,
    protocol: "UNISWAP_V2",
    poolAddress: "0x1111111111111111111111111111111111111111",
    pairSymbol: "WETH/USDT",
    baseToken: {
      address: "0x4200000000000000000000000000000000000006",
      symbol: "WETH",
      decimals: 18,
      reserve: 10,
      rawReserve: ethers.parseUnits("10.0", 18)
    },
    quoteToken: {
      address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
      symbol: "USDT",
      decimals: 6,
      reserve: reserveQuote,
      rawReserve: ethers.parseUnits(reserveQuote.toString(), 6)
    },
    spotPrice: 3000.0,
    inversePrice: 1 / 3000.0,
    liquidityUsd,
    feeBps: 30,
    feePct: 0.003,
    blockNumber: 15000000,
    blockTimestamp: Math.floor(Date.now() / 1000),
    fetchedAt: Date.now(),
    ageMs: 500,
    freshness: "FRESH",
    isValid: true
  });

  it("should approve trades when liquidity and depth are sufficient", () => {
    // Both pools have $50,000 liquidity, $25,000 quote reserve
    const buyPool = createMockPool("Uniswap_V2", 25000, 50000);
    const sellPool = createMockPool("SushiSwap_V2", 25000, 50000);

    const result = LiquidityFilter.checkLiquidity(buyPool, sellPool, 50.0, 1000.0);
    expect(result.hasSufficientLiquidity).to.be.true;
    expect(result.rejectionReason).to.be.undefined;
  });

  it("should reject when buy pool liquidity is below minimum requirement", () => {
    const buyPool = createMockPool("Uniswap_V2", 400, 800); // Only $800 liquidity (< $1000 min)
    const sellPool = createMockPool("SushiSwap_V2", 25000, 50000);

    const result = LiquidityFilter.checkLiquidity(buyPool, sellPool, 50.0, 1000.0);
    expect(result.hasSufficientLiquidity).to.be.false;
    expect(result.rejectionReason).to.include("below minimum requirement");
    expect(result.rejectionReason).to.include("Uniswap_V2");
  });

  it("should reject when sell pool liquidity is below minimum requirement", () => {
    const buyPool = createMockPool("Uniswap_V2", 25000, 50000);
    const sellPool = createMockPool("SushiSwap_V2", 300, 600); // Only $600 liquidity

    const result = LiquidityFilter.checkLiquidity(buyPool, sellPool, 50.0, 1000.0);
    expect(result.hasSufficientLiquidity).to.be.false;
    expect(result.rejectionReason).to.include("below minimum requirement");
    expect(result.rejectionReason).to.include("SushiSwap_V2");
  });

  it("should reject when trade size exceeds 25% of pool quote reserve", () => {
    // Pool quote reserve is 100 USDT (25% max allowed is 25 USDT)
    const buyPool = createMockPool("Uniswap_V2", 100, 2000);
    const sellPool = createMockPool("SushiSwap_V2", 25000, 50000);

    const result = LiquidityFilter.checkLiquidity(buyPool, sellPool, 30.0, 1000.0); // 30 > 25
    expect(result.hasSufficientLiquidity).to.be.false;
    expect(result.rejectionReason).to.include("exceeds 25% of buy pool quote reserve");
  });
});
