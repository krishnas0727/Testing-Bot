import { expect } from "chai";
import { ethers } from "ethers";
import { PoolStateCache } from "../../src/market/cache/PoolStateCache";
import { NormalizedPoolState } from "../../src/market/types";

describe("Phase 3: PoolStateCache Unit Tests", () => {
  let cache: PoolStateCache;

  const mockPool: NormalizedPoolState = {
    id: "8453:Uniswap_V2:WETH-USDT",
    chainId: 8453,
    dexName: "Uniswap_V2",
    protocol: "UNISWAP_V2",
    poolAddress: "0x1111111111111111111111111111111111111111",
    pairSymbol: "WETH/USDT",
    baseToken: {
      address: "0x4200000000000000000000000000000000000006",
      symbol: "WETH",
      decimals: 18,
      reserve: 10.0,
      rawReserve: ethers.parseUnits("10.0", 18)
    },
    quoteToken: {
      address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
      symbol: "USDT",
      decimals: 6,
      reserve: 30000.0,
      rawReserve: ethers.parseUnits("30000.0", 6)
    },
    spotPrice: 3000.0,
    inversePrice: 1 / 3000.0,
    liquidityUsd: 60000.0,
    feeBps: 30,
    feePct: 0.003,
    blockNumber: 19800000,
    blockTimestamp: Math.floor(Date.now() / 1000),
    fetchedAt: Date.now(),
    ageMs: 100,
    freshness: "FRESH",
    isValid: true
  };

  beforeEach(() => {
    cache = new PoolStateCache(5000); // 5s TTL
  });

  it("should store and retrieve pool state by chain, dex, and pair", () => {
    cache.set(mockPool);
    expect(cache.size()).to.equal(1);

    const retrieved = cache.get(8453, "Uniswap_V2", "WETH/USDT");
    expect(retrieved).to.not.be.null;
    expect(retrieved?.spotPrice).to.equal(3000.0);
    expect(retrieved?.dexName).to.equal("Uniswap_V2");
  });

  it("should track cache hits, misses, and hit rate", () => {
    cache.set(mockPool);

    // Hit
    cache.get(8453, "Uniswap_V2", "WETH/USDT");
    // Miss
    cache.get(8453, "SushiSwap_V2", "WETH/USDT");

    const stats = cache.getStats();
    expect(stats.hits).to.equal(1);
    expect(stats.misses).to.equal(1);
    expect(stats.hitRate).to.equal(50.0);
  });

  it("should retrieve all pools for a given pair across multiple DEXs", () => {
    const mockSushiPool: NormalizedPoolState = {
      ...mockPool,
      id: "8453:SushiSwap_V2:WETH-USDT",
      dexName: "SushiSwap_V2",
      spotPrice: 3015.0
    };

    cache.set(mockPool);
    cache.set(mockSushiPool);

    const pools = cache.getForPair(8453, "WETH/USDT");
    expect(Object.keys(pools)).to.have.lengthOf(2);
    expect(pools["Uniswap_V2"].spotPrice).to.equal(3000.0);
    expect(pools["SushiSwap_V2"].spotPrice).to.equal(3015.0);
  });

  it("should prune expired cache entries beyond TTL", async () => {
    const expiredPool: NormalizedPoolState = {
      ...mockPool,
      fetchedAt: Date.now() - 10000 // 10s ago, exceeds 5s TTL
    };

    cache.set(expiredPool);
    const pruned = cache.prune();
    expect(pruned).to.equal(1);
    expect(cache.size()).to.equal(0);
  });
});
