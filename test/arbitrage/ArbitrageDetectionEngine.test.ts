import { expect } from "chai";
import { ethers } from "ethers";
import { ArbitrageDetectionEngine } from "../../src/arbitrage/ArbitrageDetectionEngine";
import { NormalizedPoolState } from "../../src/market/types";

describe("Phase 4: ArbitrageDetectionEngine Integration & Gating Tests", () => {
  const createMockPool = (
    dexName: string,
    spotPrice: number,
    opts: {
      reserveQuote?: number;
      liquidityUsd?: number;
      freshness?: "FRESH" | "STALE" | "EXPIRED";
      ageMs?: number;
    } = {}
  ): NormalizedPoolState => {
    const reserveQuote = opts.reserveQuote || 300000;
    const liquidityUsd = opts.liquidityUsd || (reserveQuote * 2);
    const freshness = opts.freshness || "FRESH";
    const ageMs = opts.ageMs || 500;

    return {
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
        reserve: reserveQuote / spotPrice,
        rawReserve: ethers.parseUnits((reserveQuote / spotPrice).toFixed(6), 18)
      },
      quoteToken: {
        address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
        symbol: "USDT",
        decimals: 6,
        reserve: reserveQuote,
        rawReserve: ethers.parseUnits(reserveQuote.toString(), 6)
      },
      spotPrice,
      inversePrice: 1 / spotPrice,
      liquidityUsd,
      feeBps: 30,
      feePct: 0.003,
      blockNumber: 15000000,
      blockTimestamp: Math.floor(Date.now() / 1000),
      fetchedAt: Date.now() - ageMs,
      ageMs,
      freshness,
      isValid: true
    };
  };

  it("should detect profitable arbitrage opportunity across multiple trade sizes", () => {
    const engine = new ArbitrageDetectionEngine({
      minSpreadPct: 0.20,
      minLiquidityUsd: 1000.0,
      candidateSizes: [10.0, 50.0]
    });

    // 2% spread between Uniswap ($3000) and Sushiswap ($3060)
    const poolsByPair = {
      "WETH/USDT": {
        Uniswap_V2: createMockPool("Uniswap_V2", 3000.0),
        SushiSwap_V2: createMockPool("SushiSwap_V2", 3060.0)
      }
    };

    const summary = engine.detectOpportunities(8453, poolsByPair, {
      gasPriceGwei: 0.005,
      ethPriceUsdt: 3000.0,
      minProfitUsdt: 0.01
    });

    expect(summary.scannedPairsCount).to.equal(1);
    expect(summary.candidateRoutesGenerated).to.equal(1);
    expect(summary.opportunities).to.have.lengthOf(2); // evaluated 10.0 and 50.0

    const opp50 = summary.opportunities.find((o) => o.tradeSize === 50.0);
    expect(opp50).to.not.be.undefined;
    expect(opp50?.buyDex).to.equal("Uniswap_V2");
    expect(opp50?.sellDex).to.equal("SushiSwap_V2");
    expect(opp50?.status).to.equal("PROFITABLE");
    expect(opp50?.isConfirmedProfitable).to.be.true;
    expect(opp50?.profitCalculation).to.not.be.undefined;
    expect(opp50?.profitCalculation?.netProfitUsdt).to.be.greaterThan(0);
  });

  it("should reject opportunities when pool data is STALE or EXPIRED", () => {
    const engine = new ArbitrageDetectionEngine({
      minSpreadPct: 0.20,
      candidateSizes: [10.0]
    });

    const poolsByPair = {
      "WETH/USDT": {
        Uniswap_V2: createMockPool("Uniswap_V2", 3000.0, { freshness: "STALE", ageMs: 12000 }),
        SushiSwap_V2: createMockPool("SushiSwap_V2", 3060.0, { freshness: "FRESH", ageMs: 500 })
      }
    };

    const summary = engine.detectOpportunities(8453, poolsByPair);
    expect(summary.rejectedStaleCount).to.be.greaterThan(0);

    const staleOpp = summary.opportunities.find((o) => o.status === "REJECTED_STALE_DATA");
    expect(staleOpp).to.not.be.undefined;
    expect(staleOpp?.isConfirmedProfitable).to.be.false;
    expect(staleOpp?.rejectionReason).to.include("stale or expired");
  });

  it("should reject candidate when pool liquidity is insufficient", () => {
    const engine = new ArbitrageDetectionEngine({
      minSpreadPct: 0.20,
      minLiquidityUsd: 5000.0,
      candidateSizes: [20.0]
    });

    // Buy pool has only $800 liquidity (< $5000 min)
    const poolsByPair = {
      "WETH/USDT": {
        Uniswap_V2: createMockPool("Uniswap_V2", 3000.0, { liquidityUsd: 800, reserveQuote: 400 }),
        SushiSwap_V2: createMockPool("SushiSwap_V2", 3060.0)
      }
    };

    const summary = engine.detectOpportunities(8453, poolsByPair);
    expect(summary.rejectedLowLiquidityCount).to.be.greaterThan(0);

    const liqOpp = summary.opportunities.find((o) => o.status === "REJECTED_LOW_LIQUIDITY");
    expect(liqOpp).to.not.be.undefined;
    expect(liqOpp?.isConfirmedProfitable).to.be.false;
  });

  it("should suppress duplicate opportunities in successive detection runs", () => {
    const engine = new ArbitrageDetectionEngine({
      minSpreadPct: 0.20,
      deduplicationWindowMs: 5000,
      candidateSizes: [10.0]
    });

    const poolsByPair = {
      "WETH/USDT": {
        Uniswap_V2: createMockPool("Uniswap_V2", 3000.0),
        SushiSwap_V2: createMockPool("SushiSwap_V2", 3060.0)
      }
    };

    // First run detects opportunity
    const summary1 = engine.detectOpportunities(8453, poolsByPair);
    expect(summary1.opportunities).to.have.lengthOf(1);
    expect(summary1.rejectedDuplicateCount).to.equal(0);

    // Second run with same spread is suppressed by deduplicator
    const summary2 = engine.detectOpportunities(8453, poolsByPair);
    expect(summary2.opportunities).to.have.lengthOf(0);
    expect(summary2.rejectedDuplicateCount).to.equal(1);
  });
});
