import { expect } from "chai";
import { ethers } from "ethers";
import { MarketDataService } from "../../src/market/MarketDataService";
import { RawPoolData } from "../../src/market/types";

describe("Phase 3: MarketDataService Integration & Failure Tests", () => {
  let service: MarketDataService;

  beforeEach(() => {
    service = new MarketDataService(60000, false); // Disable console logs in test runner
  });

  it("should process and normalize raw pool data across Uniswap and SushiSwap", () => {
    const rawUni: RawPoolData = {
      dexName: "Uniswap_V2",
      protocol: "UNISWAP_V2",
      chainId: 8453,
      poolAddress: "0x1111111111111111111111111111111111111111",
      token0Address: "0x4200000000000000000000000000000000000006",
      token1Address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      token0Symbol: "WETH",
      token1Symbol: "USDC",
      token0Decimals: 18,
      token1Decimals: 6,
      rawReserve0: ethers.parseUnits("100.0", 18),
      rawReserve1: ethers.parseUnits("300000.0", 6), // Spot = 3000.0
      feeBps: 30,
      blockNumber: 19800000,
      blockTimestamp: Math.floor(Date.now() / 1000),
      fetchedAt: Date.now()
    };

    const rawSushi: RawPoolData = {
      ...rawUni,
      dexName: "SushiSwap_V2",
      poolAddress: "0x2222222222222222222222222222222222222222",
      rawReserve0: ethers.parseUnits("100.0", 18),
      rawReserve1: ethers.parseUnits("303000.0", 6), // Spot = 3030.0 (1.0% higher)
    };

    const normUni = service.updatePool(rawUni, "WETH", "USDC");
    const normSushi = service.updatePool(rawSushi, "WETH", "USDC");

    expect(normUni.spotPrice).to.equal(3000.0);
    expect(normSushi.spotPrice).to.equal(3030.0);
  });

  it("should calculate multi-DEX snapshot with highest bid, lowest ask, and spread", async () => {
    // Populate two DEX pools with 1% spread
    const now = Date.now();
    const rawUni: RawPoolData = {
      dexName: "Uniswap_V2",
      protocol: "UNISWAP_V2",
      chainId: 8453,
      poolAddress: "0x1111111111111111111111111111111111111111",
      token0Address: "0x4200000000000000000000000000000000000006",
      token1Address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      token0Symbol: "WETH",
      token1Symbol: "USDC",
      token0Decimals: 18,
      token1Decimals: 6,
      rawReserve0: ethers.parseUnits("100.0", 18),
      rawReserve1: ethers.parseUnits("300000.0", 6), // Spot = 3000.0
      feeBps: 30,
      blockNumber: 19800000,
      blockTimestamp: Math.floor(now / 1000),
      fetchedAt: now
    };

    const rawSushi: RawPoolData = {
      ...rawUni,
      dexName: "SushiSwap_V2",
      rawReserve1: ethers.parseUnits("303000.0", 6), // Spot = 3030.0
    };

    service.updatePool(rawUni, "WETH", "USDC");
    service.updatePool(rawSushi, "WETH", "USDC");

    const snapshot = await service.getMultiDEXSnapshot({
      chainId: 8453,
      baseSymbol: "WETH",
      quoteSymbol: "USDC"
    });

    expect(snapshot.highestBid.dex).to.equal("SushiSwap_V2");
    expect(snapshot.highestBid.price).to.equal(3030.0);

    expect(snapshot.lowestAsk.dex).to.equal("Uniswap_V2");
    expect(snapshot.lowestAsk.price).to.equal(3000.0);

    expect(snapshot.spreadUsd).to.equal(30.0);
    expect(snapshot.spreadPct).to.equal(1.0);
    // 1.0% spread exceeds 0.60% (2x 0.30% fee), so arbitrage is executable
    expect(snapshot.hasExecutableArbitrage).to.be.true;
    expect(snapshot.allFresh).to.be.true;
  });

  it("should gracefully handle adapter failure and return cached state on RPC error", async () => {
    // 1. Pre-warm cache
    const rawUni: RawPoolData = {
      dexName: "Uniswap_V2",
      protocol: "UNISWAP_V2",
      chainId: 8453,
      poolAddress: "0x1111111111111111111111111111111111111111",
      token0Address: "0x4200000000000000000000000000000000000006",
      token1Address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      token0Symbol: "WETH",
      token1Symbol: "USDC",
      token0Decimals: 18,
      token1Decimals: 6,
      rawReserve0: ethers.parseUnits("100.0", 18),
      rawReserve1: ethers.parseUnits("300000.0", 6),
      feeBps: 30,
      blockNumber: 19800000,
      blockTimestamp: Math.floor(Date.now() / 1000),
      fetchedAt: Date.now() - 7000 // 7s ago (STALE)
    };
    service.updatePool(rawUni, "WETH", "USDC");

    // 2. Mock adapter failure
    const adapter = service.getAdapter("Uniswap_V2");
    if (adapter) {
      adapter.fetchPoolData = async () => {
        throw new Error("RPC Network Timeout / Rate Limit 429");
      };
    }

    // 3. Request pool state - should not throw, but return cached data with warning
    const pool = await service.getPoolState(8453, "Uniswap_V2", "WETH/USDC");
    expect(pool).to.not.be.null;
    expect(pool?.spotPrice).to.equal(3000.0);
    expect(pool?.freshness).to.equal("STALE");
  });
});
