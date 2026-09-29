import { expect } from "chai";
import { ethers } from "ethers";
import { PriceComparator } from "../../src/arbitrage/detector/PriceComparator";
import { NormalizedPoolState } from "../../src/market/types";

describe("Phase 4: PriceComparator Unit Tests", () => {
  const createMockPool = (
    dexName: string,
    spotPrice: number,
    isValid: boolean = true
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
      reserve: 100,
      rawReserve: ethers.parseUnits("100.0", 18)
    },
    quoteToken: {
      address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
      symbol: "USDT",
      decimals: 6,
      reserve: 100 * spotPrice,
      rawReserve: ethers.parseUnits((100 * spotPrice).toString(), 6)
    },
    spotPrice,
    inversePrice: 1 / spotPrice,
    liquidityUsd: 100 * spotPrice * 2,
    feeBps: 30,
    feePct: 0.003,
    blockNumber: 15000000,
    blockTimestamp: Math.floor(Date.now() / 1000),
    fetchedAt: Date.now(),
    ageMs: 500,
    freshness: "FRESH",
    isValid
  });

  it("should generate directional routes when price difference exceeds minSpreadPct", () => {
    const pools: Record<string, NormalizedPoolState> = {
      Uniswap_V2: createMockPool("Uniswap_V2", 3000.0),
      SushiSwap_V2: createMockPool("SushiSwap_V2", 3030.0) // 1.0% higher
    };

    const routes = PriceComparator.comparePrices(pools, 0.20);
    expect(routes).to.have.lengthOf(1);

    const route = routes[0];
    expect(route.buyDex).to.equal("Uniswap_V2");
    expect(route.sellDex).to.equal("SushiSwap_V2");
    expect(route.rawSpreadUsd).to.equal(30.0);
    expect(route.rawSpreadPct).to.equal(1.0);
  });

  it("should generate reverse directional route when price on DEX B is lower than DEX A", () => {
    const pools: Record<string, NormalizedPoolState> = {
      Uniswap_V2: createMockPool("Uniswap_V2", 3050.0),
      SushiSwap_V2: createMockPool("SushiSwap_V2", 3000.0) // Uniswap is higher
    };

    const routes = PriceComparator.comparePrices(pools, 0.20);
    expect(routes).to.have.lengthOf(1);

    const route = routes[0];
    // Buy on SushiSwap (3000), Sell on Uniswap (3050)
    expect(route.buyDex).to.equal("SushiSwap_V2");
    expect(route.sellDex).to.equal("Uniswap_V2");
    expect(route.rawSpreadUsd).to.equal(50.0);
  });

  it("should filter out routes with spread below minSpreadPct", () => {
    const pools: Record<string, NormalizedPoolState> = {
      Uniswap_V2: createMockPool("Uniswap_V2", 3000.0),
      SushiSwap_V2: createMockPool("SushiSwap_V2", 3001.0) // 0.033% spread
    };

    const routes = PriceComparator.comparePrices(pools, 0.20); // Requires 0.20%
    expect(routes).to.have.lengthOf(0);
  });

  it("should ignore invalid pools", () => {
    const pools: Record<string, NormalizedPoolState> = {
      Uniswap_V2: createMockPool("Uniswap_V2", 3000.0, true),
      SushiSwap_V2: createMockPool("SushiSwap_V2", 3050.0, false) // Invalid pool
    };

    const routes = PriceComparator.comparePrices(pools, 0.20);
    expect(routes).to.have.lengthOf(0);
  });

  it("should handle multi-DEX comparison across 3+ DEXs", () => {
    const pools: Record<string, NormalizedPoolState> = {
      DEX_A: createMockPool("DEX_A", 3000.0),
      DEX_B: createMockPool("DEX_B", 3030.0), // 1.0% over A
      DEX_C: createMockPool("DEX_C", 3060.0)  // 2.0% over A, ~0.99% over B
    };

    const routes = PriceComparator.comparePrices(pools, 0.50);
    // Viable pairs: A->B, A->C, B->C
    expect(routes.length).to.be.at.least(3);
    const buyDexes = routes.map(r => r.buyDex);
    expect(buyDexes).to.include("DEX_A");
    expect(buyDexes).to.include("DEX_B");
  });
});
