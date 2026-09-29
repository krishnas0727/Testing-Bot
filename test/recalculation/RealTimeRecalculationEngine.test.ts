import { expect } from "chai";
import { ethers } from "ethers";
import { RealTimeRecalculationEngine } from "../../src/recalculation/RealTimeRecalculationEngine";
import { ApprovedOpportunityBundle, FreshMarketDataPayload } from "../../src/recalculation/types";
import { NormalizedPoolState } from "../../src/market/types";
import { RiskEngine } from "../../src/risk/RiskEngine";

describe("Phase 7: Real-Time Recalculation Engine Tests", () => {
  const createMockPool = (
    dexName: string,
    spotPrice: number,
    opts: {
      reserveQuote?: number;
      liquidityUsd?: number;
      isValid?: boolean;
      freshness?: "FRESH" | "STALE" | "EXPIRED";
      ageMs?: number;
    } = {}
  ): NormalizedPoolState => {
    const reserveQuote = opts.reserveQuote || 300000;
    const liquidityUsd = opts.liquidityUsd || (reserveQuote * 2);
    const isValid = opts.isValid !== undefined ? opts.isValid : true;
    const freshness = opts.freshness || "FRESH";
    const ageMs = opts.ageMs || 100;

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
      isValid
    };
  };

  const getApprovedOpportunity = (): ApprovedOpportunityBundle => ({
    opportunityId: "opp_approved_101",
    chainId: 8453,
    tokenPair: "WETH/USDT",
    baseSymbol: "WETH",
    quoteSymbol: "USDT",
    buyDex: "Uniswap_V2",
    sellDex: "SushiSwap_V2",
    tradeSizeUsdt: 50.0,
    expectedOutputUsdt: 50.70,
    netProfitUsdt: 0.68,
    grossProfitUsdt: 0.70,
    roiPct: 1.36,
    slippagePct: 0.50,
    priceImpactPct: 0.15,
    gasCostUsdt: 0.005,
    gasPriceGwei: 0.006,
    buyPoolLiquidityUsd: 600000.0,
    sellPoolLiquidityUsd: 612000.0,
    sourceBlock: 15000000,
    timestamp: Date.now() - 500,
    initialApprovalTimestamp: Date.now() - 500,
    riskStatus: "APPROVED",
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
    baseDecimals: 18,
    quoteDecimals: 6
  });

  const getFreshPayload = (overrides?: Partial<FreshMarketDataPayload>): FreshMarketDataPayload => ({
    buyPoolState: createMockPool("Uniswap_V2", 3000.0),
    sellPoolState: createMockPool("SushiSwap_V2", 3060.0), // 2.0% spread
    freshGasPriceGwei: 0.006,
    freshEthPriceUsdt: 3000.0,
    freshL1DataFeeUsdt: 0.0005,
    currentBlock: 15000001,
    fetchedAt: Date.now() - 100,
    ...overrides
  });

  it("should approve healthy opportunity and emit VALID_FOR_SIMULATION", () => {
    const engine = new RealTimeRecalculationEngine();
    const result = engine.revalidateOpportunity(getApprovedOpportunity(), getFreshPayload());

    expect(result.finalDecision).to.equal("VALID_FOR_SIMULATION");
    expect(result.newRiskStatus).to.equal("APPROVED");
    expect(result.newNetProfit).to.be.greaterThan(0);
    expect(result.rejectionReasons).to.be.empty;
    expect(result.currentBlock).to.equal(15000001);
  });

  it("should detect pool price change and reject when profit disappears", () => {
    const engine = new RealTimeRecalculationEngine();
    // Sell price dropped from 3060 to 3001 (spread narrowed so fees wipe profit)
    const payload = getFreshPayload({
      sellPoolState: createMockPool("SushiSwap_V2", 3001.0, { reserveQuote: 300100 })
    });

    const result = engine.revalidateOpportunity(getApprovedOpportunity(), payload);
    expect(result.finalDecision).to.equal("REJECTED");
    expect(result.rejectionReasons.some((r) => r.includes("unprofitable") || r.includes("below minimum threshold"))).to.be.true;
    expect(result.deltaAnalysis.netProfitDeltaUsdt).to.be.lessThan(0);
  });

  it("should detect pool liquidity change and reject on low liquidity", () => {
    const engine = new RealTimeRecalculationEngine();
    // Buy pool liquidity drained to $400 (< $1000 min)
    const payload = getFreshPayload({
      buyPoolState: createMockPool("Uniswap_V2", 3000.0, { liquidityUsd: 400.0, reserveQuote: 200.0 })
    });

    const result = engine.revalidateOpportunity(getApprovedOpportunity(), payload);
    expect(result.finalDecision).to.equal("REJECTED");
    expect(result.rejectionReasons.some((r) => r.includes("below minimum required liquidity"))).to.be.true;
    expect(result.deltaAnalysis.buyPoolLiquidityDeltaPct).to.be.lessThan(-50);
  });

  it("should detect gas price increase and reject when gas surges", () => {
    const engine = new RealTimeRecalculationEngine({ maxGasPriceIncreasePct: 100.0 });
    // Gas increased 100x from 0.006 to 0.60 Gwei
    const payload = getFreshPayload({
      freshGasPriceGwei: 0.60
    });

    const result = engine.revalidateOpportunity(getApprovedOpportunity(), payload);
    expect(result.finalDecision).to.equal("REJECTED");
    expect(result.rejectionReasons.some((r) => r.includes("Gas cost spiked") || r.includes("exceeds gas ceiling"))).to.be.true;
  });

  it("should detect gas price decrease and reflect profit increase", () => {
    const engine = new RealTimeRecalculationEngine();
    const payload = getFreshPayload({
      freshGasPriceGwei: 0.001 // Gas dropped significantly
    });

    const result = engine.revalidateOpportunity(getApprovedOpportunity(), payload);
    expect(result.finalDecision).to.equal("VALID_FOR_SIMULATION");
    expect(result.newGasEstimate).to.be.lessThan(result.previousGasEstimate);
  });

  it("should record profit decrease and reject if negative divergence exceeded", () => {
    const engine = new RealTimeRecalculationEngine({ maxNegativeProfitDivergencePct: 25.0 });
    // Sell price drops slightly (3060 -> 3045), reducing profit by > 25%
    const payload = getFreshPayload({
      sellPoolState: createMockPool("SushiSwap_V2", 3045.0, { reserveQuote: 304500 })
    });

    const result = engine.revalidateOpportunity(getApprovedOpportunity(), payload);
    expect(result.finalDecision).to.equal("REJECTED");
    expect(result.rejectionReasons.some((r) => r.includes("Profit degradation"))).to.be.true;
  });

  it("should record profit increase when spread widens", () => {
    const engine = new RealTimeRecalculationEngine();
    // Sell price jumped from 3060 to 3090 (3.0% spread)
    const payload = getFreshPayload({
      sellPoolState: createMockPool("SushiSwap_V2", 3090.0, { reserveQuote: 309000 })
    });

    const result = engine.revalidateOpportunity(getApprovedOpportunity(), payload);
    expect(result.finalDecision).to.equal("VALID_FOR_SIMULATION");
    expect(result.newNetProfit).to.be.greaterThan(result.previousNetProfit);
    expect(result.deltaAnalysis.netProfitDeltaUsdt).to.be.greaterThan(0);
  });

  it("should reject when recalculated price impact exceeds risk threshold", () => {
    const riskEngine = new RiskEngine({ maxPriceImpactPct: 0.50 });
    const engine = new RealTimeRecalculationEngine({}, riskEngine);

    // Thin reserves causing price impact > 0.50%
    const payload = getFreshPayload({
      buyPoolState: createMockPool("Uniswap_V2", 3000.0, { reserveQuote: 1500.0, liquidityUsd: 3000.0 })
    });

    const result = engine.revalidateOpportunity(getApprovedOpportunity(), payload);
    expect(result.finalDecision).to.equal("REJECTED");
    expect(result.rejectionReasons.some((r) => r.includes("Price impact"))).to.be.true;
  });

  it("should reject opportunity when fresh market data is STALE", () => {
    const engine = new RealTimeRecalculationEngine({ maxDataAgeMs: 2000 });
    const payload = getFreshPayload({
      fetchedAt: Date.now() - 5000 // 5 seconds old > 2s max
    });

    const result = engine.revalidateOpportunity(getApprovedOpportunity(), payload);
    expect(result.finalDecision).to.equal("REJECTED");
    expect(result.rejectionReasons.some((r) => r.includes("Fresh market data is stale"))).to.be.true;
  });

  it("should audit block number change from previous to fresh block", () => {
    const engine = new RealTimeRecalculationEngine();
    const payload = getFreshPayload({ currentBlock: 15000042 });

    const result = engine.revalidateOpportunity(getApprovedOpportunity(), payload);
    expect(result.finalDecision).to.equal("VALID_FOR_SIMULATION");
    expect(result.currentBlock).to.equal(15000042);
  });

  it("should reject opportunity when risk limit is crossed during re-evaluation", () => {
    const riskEngine = new RiskEngine();
    riskEngine.tripCircuitBreaker("Market volatility spike detected");
    const engine = new RealTimeRecalculationEngine({}, riskEngine);

    const result = engine.revalidateOpportunity(getApprovedOpportunity(), getFreshPayload());
    expect(result.finalDecision).to.equal("REJECTED");
    expect(result.rejectionReasons.some((r) => r.includes("Circuit breaker is OPEN"))).to.be.true;
  });

  it("should reject pending opportunity when opportunity timeout has expired", () => {
    const engine = new RealTimeRecalculationEngine({ maxPendingTimeoutMs: 3000 });
    const opp = getApprovedOpportunity();
    opp.initialApprovalTimestamp = Date.now() - 6000; // 6s ago > 3s timeout

    const result = engine.revalidateOpportunity(opp, getFreshPayload());
    expect(result.finalDecision).to.equal("REJECTED");
    expect(result.rejectionReasons.some((r) => r.includes("Opportunity pending timeout exceeded"))).to.be.true;
  });

  it("should handle multiple simultaneous updates (price, gas, block) accurately", () => {
    const engine = new RealTimeRecalculationEngine();
    const payload = getFreshPayload({
      sellPoolState: createMockPool("SushiSwap_V2", 3065.0, { reserveQuote: 306500 }), // Price changed
      freshGasPriceGwei: 0.004, // Gas changed
      currentBlock: 15000010 // Block changed
    });

    const result = engine.revalidateOpportunity(getApprovedOpportunity(), payload);
    expect(result.finalDecision).to.equal("VALID_FOR_SIMULATION");
    expect(result.currentBlock).to.equal(15000010);
    expect(result.deltaAnalysis.priceSpreadDeltaUsd).to.not.equal(0);
    expect(result.deltaAnalysis.gasCostDeltaUsdt).to.not.equal(0);
  });

  it("should reject safely upon RPC or pool state refresh failure", () => {
    const engine = new RealTimeRecalculationEngine();
    const payload = getFreshPayload({
      buyPoolState: createMockPool("Uniswap_V2", 3000.0, { isValid: false }) // Failed RPC validation
    });

    const result = engine.revalidateOpportunity(getApprovedOpportunity(), payload);
    expect(result.finalDecision).to.equal("REJECTED");
    expect(result.rejectionReasons.some((r) => r.includes("RPC or pool state refresh failure"))).to.be.true;
  });
});
