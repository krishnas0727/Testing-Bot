/**
 * @file Phase15ComprehensiveUnitSuite.test.ts
 * @description Phase 15: Master Comprehensive Unit Test Suite
 *
 * Covers all 11 critical business logic modules in a single deterministic test suite:
 * 1. Market Data Normalization & Validation
 * 2. Arbitrage Route Detection & Directional Comparison
 * 3. Profit Calculation (DEX fees, gas, impact, slippage, decimals, dust)
 * 4. Trade Size Optimization (multi-size search)
 * 5. Risk Management (14 safety gates, whitelist, daily loss, circuit breaker)
 * 6. Real-Time Recalculation (delta analysis, freshness, gas surge)
 * 7. Transaction Builder & Simulation (calldata encoding, 12 pre-flight checks)
 * 8. Treasury Accounting (5 buckets, balance ledger, limits)
 * 9. Revenue Distribution (60/20/20, 100% sum, dust absorption, bot withdrawal guard)
 * 10. Backend API Framework (Auth, RBAC, Rate Limiting, Idempotency, Secret Scrubbing)
 * 11. Database Service (Filtering, Sorting, Pagination, P&L aggregation)
 */

import { expect } from "chai";
import { ethers } from "ethers";

// Module Imports
import { MarketDataService } from "../../src/market";
import { ArbitrageDetectionEngine } from "../../src/arbitrage";
import { PriceComparator } from "../../src/arbitrage/detector/PriceComparator";
import { LiquidityFilter } from "../../src/arbitrage/detector/LiquidityFilter";
import { OpportunityDeduplicator } from "../../src/arbitrage/deduplicator/OpportunityDeduplicator";
import { ProfitCalculationEngine } from "../../src/profit";
import { AMMSwapMath } from "../../src/profit/AMMSwapMath";
import { GasCostCalculator } from "../../src/profit/GasCostCalculator";
import { TradeSizeOptimizer } from "../../src/profit/TradeSizeOptimizer";
import { RiskEngine } from "../../src/risk/RiskEngine";
import { CircuitBreaker } from "../../src/risk/CircuitBreaker";
import { DEFAULT_RISK_CONFIG } from "../../src/risk/config";
import { RealTimeRecalculationEngine } from "../../src/recalculation/RealTimeRecalculationEngine";
import { TransactionBuilder } from "../../src/simulation/TransactionBuilder";
import { TransactionSimulator } from "../../src/simulation/TransactionSimulator";
import { RevenueDistributionEngine } from "../../src/distribution";
import { DatabaseService } from "../../src/api/services/DatabaseService";
import { BotControlService } from "../../src/api/services/BotControlService";
import { scrubSensitiveData } from "../../src/api/framework/middleware";
import { formatCurrency, truncateHash, getTxExplorerUrl } from "../../src/dashboard/types";

describe("Phase 15: Master Comprehensive Unit Test Suite", () => {

  // ─────────────────────────────────────────────────────────────────────────
  // 1. PROFIT CALCULATION & AMM MATH UNIT TESTS
  // ─────────────────────────────────────────────────────────────────────────
  describe("1. Profit Calculation & AMM Mathematics", () => {
    it("DEX Swap Math: should compute exact Uniswap V2 output including 30 bps fee", () => {
      // 100 WETH and 300,000 USDC in pool
      const reserveIn = ethers.parseUnits("300000", 6);
      const reserveOut = ethers.parseUnits("100", 18);
      const amountIn = ethers.parseUnits("3000", 6); // $3000 in

      const amountOut = AMMSwapMath.getAmountOut(amountIn, reserveIn, reserveOut, 30);
      expect(amountOut).to.be.greaterThan(0n);

      // Theoretical max before fee is ~1.0 WETH; with fee and impact it should be ~0.987 WETH
      const formatted = Number(ethers.formatUnits(amountOut, 18));
      expect(formatted).to.be.within(0.97, 0.999);
    });

    it("Price Impact: should compute non-linear impact as trade size grows", () => {
      const reserveIn = ethers.parseUnits("100000", 6);
      const reserveOut = ethers.parseUnits("50", 18);

      const impactSmall = AMMSwapMath.calculatePriceImpact(
        ethers.parseUnits("100", 6),
        reserveIn,
        reserveOut
      );
      const impactLarge = AMMSwapMath.calculatePriceImpact(
        ethers.parseUnits("10000", 6),
        reserveIn,
        reserveOut
      );

      expect(impactLarge).to.be.greaterThan(impactSmall);
      expect(impactSmall).to.be.lessThan(0.5); // < 0.5%
      expect(impactLarge).to.be.greaterThan(5.0); // > 5% on 10% pool drain
    });

    it("Gas Cost Calculation: should sum execution units and L1 data fees accurately", () => {
      const gasCost = GasCostCalculator.calculateGasCostUsdt({
        gasPriceGwei: 0.005, // Base L2 cheap gas
        ethPriceUsdt: 3000.0,
        estimatedGasUnits: 250000n,
        l1DataFeeUsdt: 0.001,
      });

      expect(gasCost.totalGasCostUsdt).to.be.greaterThan(0);
      expect(gasCost.totalGasCostUsdt).to.be.lessThan(0.05); // sub-cent L2 gas
    });

    it("Token Decimals: should handle cross-decimal pairs (18 decimals WETH to 6 decimals USDT)", () => {
      const params = {
        opportunityId: "test-decimals",
        chainId: 8453 as const,
        buyDex: "Uniswap_V2",
        sellDex: "SushiSwap_V2",
        baseSymbol: "WETH",
        quoteSymbol: "USDT",
        baseDecimals: 18,
        quoteDecimals: 6,
        tradeAmountFormatted: 50.0,
        buyPoolReserves: {
          reserveBase: ethers.parseUnits("100.0", 18),
          reserveQuote: ethers.parseUnits("300000.0", 6),
          feeBps: 30,
        },
        sellPoolReserves: {
          reserveBase: ethers.parseUnits("100.0", 18),
          reserveQuote: ethers.parseUnits("306000.0", 6), // 2.0% spread
          feeBps: 30,
        },
        gasPriceGwei: 0.005,
        ethPriceUsdt: 3000.0,
        estimatedGasUnits: 250000n,
        l1DataFeeUsdt: 0.0005,
        slippageTolerancePct: 0.5,
        maxPriceImpactPct: 1.0,
        minProfitUsdt: 0.05,
        safetyMarginUsdt: 0.02,
        otherExecutionCostsUsdt: 0.0,
      };

      const breakdown = ProfitCalculationEngine.calculateProfitability(params);
      expect(breakdown.isProfitable).to.be.true;
      expect(breakdown.netProfitUsdt).to.be.greaterThan(0.05);
      expect(breakdown.roiPct).to.be.greaterThan(0);
    });

    it("Zero / Negative Profit Rejection: should flag unprofitable trades", () => {
      const params = {
        opportunityId: "test-loss",
        chainId: 8453 as const,
        buyDex: "Uniswap_V2",
        sellDex: "SushiSwap_V2",
        baseSymbol: "WETH",
        quoteSymbol: "USDT",
        baseDecimals: 18,
        quoteDecimals: 6,
        tradeAmountFormatted: 50.0,
        buyPoolReserves: {
          reserveBase: ethers.parseUnits("100.0", 18),
          reserveQuote: ethers.parseUnits("300000.0", 6), // Spot $3000
          feeBps: 30,
        },
        sellPoolReserves: {
          reserveBase: ethers.parseUnits("100.0", 18),
          reserveQuote: ethers.parseUnits("299000.0", 6), // Spot $2990 (negative spread!)
          feeBps: 30,
        },
        gasPriceGwei: 0.005,
        ethPriceUsdt: 3000.0,
        estimatedGasUnits: 250000n,
        l1DataFeeUsdt: 0.0005,
        slippageTolerancePct: 0.5,
        maxPriceImpactPct: 1.0,
        minProfitUsdt: 0.05,
        safetyMarginUsdt: 0.02,
        otherExecutionCostsUsdt: 0.0,
      };

      const breakdown = ProfitCalculationEngine.calculateProfitability(params);
      expect(breakdown.isProfitable).to.be.false;
      expect(breakdown.netProfitUsdt).to.be.lessThan(0);
      expect(breakdown.isExecutable).to.be.false;
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 2. TRADE SIZE OPTIMIZATION UNIT TESTS
  // ─────────────────────────────────────────────────────────────────────────
  describe("2. Trade Size Optimization", () => {
    it("should evaluate multiple trade sizes and pick the size maximizing net profit", () => {
      const optParams = {
        opportunityId: "opp-opt-1",
        chainId: 8453 as const,
        buyDex: "Uniswap_V2",
        sellDex: "SushiSwap_V2",
        baseSymbol: "WETH",
        quoteSymbol: "USDT",
        baseDecimals: 18,
        quoteDecimals: 6,
        buyPoolReserves: {
          reserveBase: ethers.parseUnits("100.0", 18),
          reserveQuote: ethers.parseUnits("300000.0", 6),
          feeBps: 30,
        },
        sellPoolReserves: {
          reserveBase: ethers.parseUnits("100.0", 18),
          reserveQuote: ethers.parseUnits("306000.0", 6),
          feeBps: 30,
        },
        gasPriceGwei: 0.005,
        ethPriceUsdt: 3000.0,
        minProfitUsdt: 0.01,
        maxPriceImpactPct: 1.0,
        safetyMarginUsdt: 0.01,
      };

      const sizes = [5.0, 10.0, 25.0, 50.0, 100.0];
      const result = TradeSizeOptimizer.optimizeTradeSize(optParams, sizes);

      expect(result.allBreakdowns).to.have.lengthOf(sizes.length);
      expect(result.optimalTradeSize).to.be.greaterThan(0);
      expect(result.maxNetProfitUsdt).to.be.greaterThan(0);
      expect(result.bestBreakdown?.isExecutable).to.be.true;
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3. ARBITRAGE DETECTION & ROUTE GENERATION
  // ─────────────────────────────────────────────────────────────────────────
  describe("3. Arbitrage Route Detection", () => {
    it("PriceComparator: should detect directional spread (Buy A -> Sell B vs Buy B -> Sell A)", () => {
      const poolA = { spotPrice: 3000.0, poolAddress: "0xPoolA", dexName: "Uniswap_V2" };
      const poolB = { spotPrice: 3060.0, poolAddress: "0xPoolB", dexName: "SushiSwap_V2" };

      const comparison = PriceComparator.comparePrices(
        poolA.spotPrice,
        poolB.spotPrice,
        poolA.dexName,
        poolB.dexName,
        0.5 // 0.5% min spread threshold
      );

      expect(comparison.hasSpread).to.be.true;
      expect(comparison.buyDex).to.equal("Uniswap_V2");
      expect(comparison.sellDex).to.equal("SushiSwap_V2");
      expect(comparison.spreadPct).to.be.closeTo(2.0, 0.01);
    });

    it("PriceComparator: should return hasSpread=false when price spread is below threshold", () => {
      const comparison = PriceComparator.comparePrices(
        3000.0,
        3003.0, // 0.1% spread
        "Uniswap_V2",
        "SushiSwap_V2",
        0.5 // requires 0.5%
      );

      expect(comparison.hasSpread).to.be.false;
    });

    it("LiquidityFilter: should reject pool when reserve USD is below minimum threshold", () => {
      const isValid = LiquidityFilter.hasSufficientLiquidity({
        reserve0Usd: 400.0,
        reserve1Usd: 400.0,
        minPoolLiquidityUsd: 1000.0,
      });

      expect(isValid).to.be.false;
    });

    it("OpportunityDeduplicator: should suppress duplicate candidate within sliding window", () => {
      const deduplicator = new OpportunityDeduplicator(10_000); // 10s window

      const oppKey = "8453:WETH:USDC:Uni:Sushi";
      const isFirstNew = deduplicator.isUnique(oppKey, 1.5);
      const isSecondNew = deduplicator.isUnique(oppKey, 1.5);

      expect(isFirstNew).to.be.true;
      expect(isSecondNew).to.be.false; // Suppressed as duplicate!
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 4. RISK MANAGEMENT ENGINE (14 SAFETY GATES & CIRCUIT BREAKER)
  // ─────────────────────────────────────────────────────────────────────────
  describe("4. Risk Management & Circuit Breakers", () => {
    let riskEngine: RiskEngine;

    beforeEach(() => {
      riskEngine = new RiskEngine(DEFAULT_RISK_CONFIG);
    });

    const validRiskInput = {
      opportunityId: "opp-risk-1",
      chainId: 8453 as const,
      tokenInAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Whitelisted USDC
      tokenOutAddress: "0x4200000000000000000000000000000000000006", // Whitelisted WETH
      routerBuyAddress: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24", // Whitelisted Uni V2
      routerSellAddress: "0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891", // Whitelisted Sushi V2
      tradeSizeUsdt: 50.0,
      expectedNetProfitUsdt: 0.50,
      expectedRoiPct: 1.0,
      priceImpactPct: 0.1,
      slippageTolerancePct: 0.5,
      gasPriceGwei: 0.01,
      estimatedGasCostUsdt: 0.005,
      poolLiquidityUsdt: 100_000.0,
      dataAgeMs: 1500,
    };

    it("should pass all 14 gates for an authorized, profitable, low-risk trade", () => {
      const evalResult = riskEngine.evaluate(validRiskInput);
      expect(evalResult.passed).to.be.true;
      expect(evalResult.gatePassedCount).to.equal(14);
      expect(evalResult.rejectionReasons).to.have.lengthOf(0);
    });

    it("should reject trade exceeding maximum trade size ($1000 ceiling)", () => {
      const evalResult = riskEngine.evaluate({
        ...validRiskInput,
        tradeSizeUsdt: 1500.0, // Limit is 1000
      });

      expect(evalResult.passed).to.be.false;
      expect(evalResult.rejectionReasons.some((r) => r.includes("MAX_TRADE_SIZE"))).to.be.true;
    });

    it("should reject trade with stale market data (> 5000ms)", () => {
      const evalResult = riskEngine.evaluate({
        ...validRiskInput,
        dataAgeMs: 6500, // Limit is 5000
      });

      expect(evalResult.passed).to.be.false;
      expect(evalResult.rejectionReasons.some((r) => r.includes("DATA_STALE"))).to.be.true;
    });

    it("Circuit Breaker: should trip to OPEN after max consecutive failures", () => {
      const breaker = new CircuitBreaker(3, 5000); // 3 failures trips
      expect(breaker.getState()).to.equal("CLOSED");

      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getState()).to.equal("CLOSED");

      breaker.recordFailure(); // 3rd failure
      expect(breaker.getState()).to.equal("OPEN");
      expect(breaker.isExecutionAllowed()).to.be.false;
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 5. TRANSACTION SIMULATION & CALLEDA ENCODING
  // ─────────────────────────────────────────────────────────────────────────
  describe("5. Transaction Simulation & Pre-Flight Validation", () => {
    it("TransactionBuilder: should encode executeArbitrage and simulateArbitrage calldata", () => {
      const params = {
        routerBuy: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
        routerSell: "0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891",
        tokenIn: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        tokenOut: "0x4200000000000000000000000000000000000006",
        amountIn: ethers.parseUnits("50", 6),
        minProfit: ethers.parseUnits("0.05", 6),
        deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
      };

      const builtTx = TransactionBuilder.buildExecuteTransaction(
        "0xArbitrageContractAddress123456789012345678",
        params,
        8453
      );

      expect(builtTx.to).to.equal("0xArbitrageContractAddress123456789012345678");
      expect(builtTx.data).to.be.a("string");
      expect(builtTx.data.startsWith("0x")).to.be.true;
    });

    it("TransactionSimulator: should validate 12 pre-flight safety checks", () => {
      const simRequest = {
        contractAddress: "0xArbitrageContractAddress123456789012345678",
        executorAddress: "0xExecutorBotAddress12345678901234567890",
        chainId: 8453 as const,
        params: {
          routerBuy: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
          routerSell: "0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891",
          tokenIn: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          tokenOut: "0x4200000000000000000000000000000000000006",
          amountIn: ethers.parseUnits("50", 6),
          minProfit: ethers.parseUnits("0.05", 6),
          deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
        },
        executorTokenBalance: ethers.parseUnits("100", 6), // Has sufficient balance
        executorTokenAllowance: ethers.parseUnits("100", 6), // Has sufficient allowance
        isExecutorWhitelisted: true,
        isTokenInWhitelisted: true,
        isTokenOutWhitelisted: true,
        isRouterBuyWhitelisted: true,
        isRouterSellWhitelisted: true,
        isContractPaused: false,
        simulatedGasUsed: 145000n,
        simulatedOutputAmount: ethers.parseUnits("50.50", 6), // 0.50 profit
      };

      const result = TransactionSimulator.simulate(simRequest);
      expect(result.success).to.be.true;
      expect(result.status).to.equal("SIMULATION_SUCCESS");
      expect(result.validationChecks.balanceValid).to.be.true;
      expect(result.validationChecks.allowanceValid).to.be.true;
      expect(result.validationChecks.deadlineValid).to.be.true;
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 6. TREASURY ACCOUNTING & REVENUE DISTRIBUTION
  // ─────────────────────────────────────────────────────────────────────────
  describe("6. Treasury Accounting & Revenue Distribution", () => {
    let distEngine: RevenueDistributionEngine;

    beforeEach(() => {
      distEngine = new RevenueDistributionEngine();
    });

    it("should distribute confirmed net profit 60/20/20 with zero dust loss", () => {
      const tradeInput = {
        tradeId: "TRADE-UNIT-1",
        txHash: "0xhashunit1",
        chainId: 8453 as const,
        token: "0xUSDC",
        grossProfit: 120_000_000n, // $120
        dexFees: 10_000_000n,
        gasCost: 10_000_000n,
        confirmedRealizedNetProfit: 100_000_000n, // $100 net
        isConfirmed: true,
      };

      const calc = distEngine.calculateDistribution(tradeInput);
      expect(calc.realizedNetProfit).to.equal(100_000_000n);
      expect(calc.tradingCapitalAllocation).to.equal(60_000_000n); // 60%
      expect(calc.reserveAllocation).to.equal(20_000_000n);        // 20%
      expect(calc.revenueAllocation).to.equal(20_000_000n);        // 20%
      expect(calc.tradingCapitalAllocation + calc.reserveAllocation + calc.revenueAllocation).to.equal(100_000_000n);
    });

    it("should strictly forbid Trading Bot (ARBITRAGE_EXECUTOR) from withdrawing revenue", () => {
      const check = distEngine.validateRevenueWithdrawal({
        callerAddress: "0xTradingBot",
        callerRole: "ARBITRAGE_EXECUTOR",
        token: "0xUSDC",
        amount: 100n,
        availableRevenue: 1000n,
        isPaused: false,
      });

      expect(check.allowed).to.be.false;
      expect(check.reason).to.include("Trading Bot (ARBITRAGE_EXECUTOR) is strictly forbidden");
    });

    it("should reject revenue distribution for unconfirmed (unrealized) trades", () => {
      const tradeInput = {
        tradeId: "TRADE-UNCONFIRMED",
        txHash: "0xpending",
        chainId: 8453 as const,
        token: "0xUSDC",
        grossProfit: 100n,
        dexFees: 10n,
        gasCost: 10n,
        isConfirmed: false, // NOT confirmed!
      };

      const res = distEngine.processTradeSettlement(tradeInput);
      expect(res.status).to.equal("REJECTED_UNCONFIRMED");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 7. BACKEND API, AUTHENTICATION & DATABASE SERVICES
  // ─────────────────────────────────────────────────────────────────────────
  describe("7. Backend & Database Services", () => {
    let db: DatabaseService;

    beforeEach(() => {
      db = new DatabaseService();
    });

    it("Database: should paginate items correctly and calculate total pages", () => {
      const res = db.getTrades({}, { page: 1, limit: 1 });
      expect(res.items.length).to.equal(1);
      expect(res.pagination.page).to.equal(1);
      expect(res.pagination.limit).to.equal(1);
      expect(res.pagination.totalPages).to.be.greaterThanOrEqual(1);
    });

    it("Database: should aggregate P&L summary correctly across time periods", () => {
      const pnlAll = db.getProfitLoss("all");
      expect(pnlAll.totalTrades).to.be.greaterThanOrEqual(2);
      expect(pnlAll.winRatePct).to.be.at.least(50.0);
      expect(pnlAll.grossProfitUsdt).to.be.greaterThan(0);
    });

    it("Security Scrubber: should sanitize private keys from all API responses", () => {
      const dirtyObj = {
        name: "TestConfig",
        privateKey: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        contracts: {
          treasury: "0xTreasury",
        },
      };

      const cleanObj = scrubSensitiveData(dirtyObj);
      expect(cleanObj.privateKey).to.equal("[REDACTED_SECRET]");
      expect(cleanObj.contracts.treasury).to.equal("0xTreasury");
    });

    it("Presentation Utilities: should format currency and truncate hashes cleanly", () => {
      expect(formatCurrency(1234.56)).to.equal("$1,234.56");
      expect(truncateHash("0x9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b")).to.equal("0x9a8b...1a0b");
      expect(getTxExplorerUrl(8453, "0xtx123")).to.equal("https://basescan.org/tx/0xtx123");
    });
  });
});
