import { expect } from "chai";
import { RiskEngine } from "../../src/risk/RiskEngine";
import { RiskEvaluationInput } from "../../src/risk/types";

describe("Phase 6: Centralized Risk Engine Multi-Gate Safety Tests", () => {
  // Base golden standard input for an ideal, approved trade on Base L2
  const getBaseOpportunity = (): RiskEvaluationInput => ({
    opportunityId: "opp_golden_test_1",
    chainId: 8453,
    tokenPair: "WETH/USDT",
    baseSymbol: "WETH",
    quoteSymbol: "USDT",
    buyDex: "Uniswap_V2",
    sellDex: "SushiSwap_V2",
    tradeSizeUsdt: 50.0,
    netProfitUsdt: 0.85,             // Clean positive profit above min ($0.01) and safety margin ($0.02)
    expectedSlippagePct: 0.50,       // Below max 1.0%
    priceImpactPct: 0.15,           // Below max 2.0%
    gasCostUsdt: 0.005,             // Below max $0.25
    buyPoolLiquidityUsd: 150000.0,  // Above min $1,000
    sellPoolLiquidityUsd: 180000.0, // Above min $1,000
    currentExposureUsdt: 0.0,       // Total 50.0 < $2500 max
    dataAgeMs: 500,                 // Below max 15,000ms
    timestamp: Date.now(),
    isConfirmedProfitable: true
  });

  it("should approve a healthy, profitable opportunity passing all risk gates", () => {
    const engine = new RiskEngine();
    const result = engine.evaluateOpportunity(getBaseOpportunity());

    expect(result.isApproved).to.be.true;
    expect(result.status).to.equal("APPROVED");
    expect(result.rejectionReasons).to.be.empty;
    expect(result.riskScore).to.be.at.most(25);
    expect(result.riskStatus).to.equal("LOW");
    expect(result.circuitBreakerStatus).to.equal("CLOSED");
    expect(result.checksPassed.minNetProfit).to.be.true;
    expect(result.checksPassed.maxTradeSize).to.be.true;
    expect(result.checksPassed.maxSlippage).to.be.true;
    expect(result.checksPassed.maxPriceImpact).to.be.true;
    expect(result.checksPassed.maxGasCost).to.be.true;
    expect(result.checksPassed.minLiquidity).to.be.true;
    expect(result.checksPassed.tokenWhitelist).to.be.true;
    expect(result.checksPassed.dexWhitelist).to.be.true;
    expect(result.checksPassed.capitalExposure).to.be.true;
    expect(result.checksPassed.dailyLossLimit).to.be.true;
    expect(result.checksPassed.consecutiveFailures).to.be.true;
    expect(result.checksPassed.dataFreshness).to.be.true;
    expect(result.checksPassed.safetyMargin).to.be.true;
  });

  it("should reject opportunity with low net profit below minimum required threshold", () => {
    const engine = new RiskEngine({ minNetProfitUsdt: 0.05 });
    const opp = getBaseOpportunity();
    opp.netProfitUsdt = 0.005; // 0.005 < 0.05

    const result = engine.evaluateOpportunity(opp);
    expect(result.isApproved).to.be.false;
    expect(result.status).to.equal("REJECTED");
    expect(result.rejectionReasons).to.have.lengthOf.at.least(1);
    expect(result.rejectionReasons[0]).to.include("below required minimum threshold");
  });

  it("should reject opportunity with excessive trade size", () => {
    const engine = new RiskEngine({ maxTradeSizeUsdt: 500.0 });
    const opp = getBaseOpportunity();
    opp.tradeSizeUsdt = 1000.0; // 1000 > 500

    const result = engine.evaluateOpportunity(opp);
    expect(result.isApproved).to.be.false;
    expect(result.rejectionReasons.some((r) => r.includes("exceeds maximum allowed size"))).to.be.true;
  });

  it("should reject opportunity with excessive slippage tolerance", () => {
    const engine = new RiskEngine({ maxSlippagePct: 0.50 });
    const opp = getBaseOpportunity();
    opp.expectedSlippagePct = 1.50; // 1.5% > 0.5%

    const result = engine.evaluateOpportunity(opp);
    expect(result.isApproved).to.be.false;
    expect(result.rejectionReasons.some((r) => r.includes("exceeds maximum tolerance"))).to.be.true;
  });

  it("should reject opportunity with excessive price impact", () => {
    const engine = new RiskEngine({ maxPriceImpactPct: 1.0 });
    const opp = getBaseOpportunity();
    opp.priceImpactPct = 2.5; // 2.5% > 1.0%

    const result = engine.evaluateOpportunity(opp);
    expect(result.isApproved).to.be.false;
    expect(result.rejectionReasons.some((r) => r.includes("exceeds safety limit"))).to.be.true;
  });

  it("should reject opportunity with excessive gas cost", () => {
    const engine = new RiskEngine({ maxGasCostUsdt: 0.10 });
    const opp = getBaseOpportunity();
    opp.gasCostUsdt = 0.55; // $0.55 > $0.10

    const result = engine.evaluateOpportunity(opp);
    expect(result.isApproved).to.be.false;
    expect(result.rejectionReasons.some((r) => r.includes("exceeds gas ceiling"))).to.be.true;
  });

  it("should reject opportunity with low pool liquidity", () => {
    const engine = new RiskEngine({ minLiquidityUsd: 1000.0 });
    const opp = getBaseOpportunity();
    opp.buyPoolLiquidityUsd = 450.0; // $450 < $1000 min

    const result = engine.evaluateOpportunity(opp);
    expect(result.isApproved).to.be.false;
    expect(result.rejectionReasons.some((r) => r.includes("below minimum required liquidity"))).to.be.true;
  });

  it("should reject opportunity with non-whitelisted token", () => {
    const engine = new RiskEngine();
    const opp = getBaseOpportunity();
    opp.baseSymbol = "UNKNOWN_SHITCOIN";

    const result = engine.evaluateOpportunity(opp);
    expect(result.isApproved).to.be.false;
    expect(result.rejectionReasons.some((r) => r.includes("Non-whitelisted token(s) detected"))).to.be.true;
  });

  it("should reject opportunity with non-whitelisted DEX/router", () => {
    const engine = new RiskEngine();
    const opp = getBaseOpportunity();
    opp.buyDex = "Unverified_Shadow_Swap";

    const result = engine.evaluateOpportunity(opp);
    expect(result.isApproved).to.be.false;
    expect(result.rejectionReasons.some((r) => r.includes("Non-whitelisted DEX(es) detected"))).to.be.true;
  });

  it("should reject opportunity when projected capital exposure exceeds limit", () => {
    const engine = new RiskEngine({ maxCapitalExposureUsdt: 1000.0 });
    const opp = getBaseOpportunity();
    opp.tradeSizeUsdt = 300.0;
    opp.currentExposureUsdt = 800.0; // 800 + 300 = 1100 > 1000

    const result = engine.evaluateOpportunity(opp);
    expect(result.isApproved).to.be.false;
    expect(result.rejectionReasons.some((r) => r.includes("exceeds exposure limit"))).to.be.true;
  });

  it("should reject opportunity when cumulative daily loss limit is reached", () => {
    const engine = new RiskEngine({ maxDailyLossUsdt: 10.0 });
    // Simulate realized loss of $12
    engine.recordTradeResult(-12.0);

    const result = engine.evaluateOpportunity(getBaseOpportunity());
    expect(result.isApproved).to.be.false;
    expect(result.rejectionReasons.some((r) => r.includes("Daily loss limit reached") || r.includes("Circuit breaker is OPEN"))).to.be.true;
  });

  it("should reject opportunity with stale market data", () => {
    const engine = new RiskEngine({ maxDataAgeMs: 5000 });
    const opp = getBaseOpportunity();
    opp.dataAgeMs = 12000; // 12s > 5s

    const result = engine.evaluateOpportunity(opp);
    expect(result.isApproved).to.be.false;
    expect(result.rejectionReasons.some((r) => r.includes("Market data is stale"))).to.be.true;
  });

  it("should reject opportunity when consecutive failures reach threshold", () => {
    const engine = new RiskEngine({ maxConsecutiveFailures: 3 });

    engine.recordExecutionFailure("Revert 1");
    engine.recordExecutionFailure("Revert 2");
    engine.recordExecutionFailure("Revert 3");

    const result = engine.evaluateOpportunity(getBaseOpportunity());
    expect(result.isApproved).to.be.false;
    expect(result.circuitBreakerStatus).to.equal("OPEN");
    expect(result.rejectionReasons.some((r) => r.includes("Circuit breaker is OPEN"))).to.be.true;
  });

  it("should reject opportunity immediately upon manual circuit breaker activation", () => {
    const engine = new RiskEngine();
    engine.tripCircuitBreaker("Emergency halt triggered by user");

    const result = engine.evaluateOpportunity(getBaseOpportunity());
    expect(result.isApproved).to.be.false;
    expect(result.status).to.equal("REJECTED");
    expect(result.circuitBreakerStatus).to.equal("OPEN");
    expect(result.rejectionReasons.some((r) => r.includes("Circuit breaker is OPEN"))).to.be.true;
  });

  it("should recover and approve opportunities after administrative circuit breaker reset", () => {
    const engine = new RiskEngine();
    engine.tripCircuitBreaker("Manual trip");
    expect(engine.isExecutionBlocked()).to.be.true;

    engine.resetCircuitBreaker();
    expect(engine.isExecutionBlocked()).to.be.false;

    const result = engine.evaluateOpportunity(getBaseOpportunity());
    expect(result.isApproved).to.be.true;
    expect(result.status).to.equal("APPROVED");
  });

  it("should collect multiple simultaneous rejection reasons when multiple gates fail", () => {
    const engine = new RiskEngine();
    const opp = getBaseOpportunity();
    opp.netProfitUsdt = -0.50;           // Fail: Negative net profit
    opp.tradeSizeUsdt = 50000.0;         // Fail: Exceeds max trade size
    opp.expectedSlippagePct = 5.0;       // Fail: Exceeds max slippage
    opp.priceImpactPct = 8.0;           // Fail: Exceeds max price impact
    opp.gasCostUsdt = 10.0;              // Fail: Exceeds max gas
    opp.baseSymbol = "UNLISTED_TOKEN";   // Fail: Non-whitelisted token
    opp.buyDex = "UNKNOWN_EXCHANGE";     // Fail: Non-whitelisted DEX
    opp.dataAgeMs = 60000;               // Fail: Stale data

    const result = engine.evaluateOpportunity(opp);
    expect(result.isApproved).to.be.false;
    expect(result.status).to.equal("REJECTED");
    // Should accumulate multiple reasons, not just the first one encountered!
    expect(result.rejectionReasons.length).to.be.at.least(5);
    expect(result.riskScore).to.be.greaterThan(80);
    expect(result.riskStatus).to.equal("CRITICAL");
  });
});
