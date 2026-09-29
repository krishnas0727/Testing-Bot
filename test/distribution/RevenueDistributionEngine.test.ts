/**
 * @file RevenueDistributionEngine.test.ts
 * @description Phase 11: Revenue Distribution Engine — Unit Test Suite
 *
 * Verifies all Phase 11 requirements:
 * - Configurable allocation policy (100% valid allocation, custom ratios)
 * - Strict 100% (10000 bps) validation (>100% and <100% rejected)
 * - Allocation bounds validation (min/max bounds)
 * - Role-based authorization for policy updates (Admin vs Unauthorized)
 * - Rounding and dust absorption (integer arithmetic, zero dust lost)
 * - Profit sizes: small profit (1 wei, 7 wei), large profit (1M USDT), standard profit
 * - Zero profit rejection
 * - Negative profit rejection / unrealized profit rejection
 * - Unconfirmed trade rejection
 * - Separate accounting for Trading Capital, Reserve, and Revenue
 * - Revenue withdrawal security: Trading bot (ARBITRAGE_EXECUTOR) blocked
 * - Authorized revenue withdrawal (TREASURY_MANAGER / ADMIN)
 * - Treasury pause behavior
 */

import { expect } from "chai";
import { ethers } from "ethers";
import {
  RevenueDistributionEngine,
  ThreeBucketAllocationPolicy,
  DEFAULT_ALLOCATION_POLICY,
  TradeSettlementInput,
} from "../../src/distribution";

describe("Phase 11: Revenue Distribution Engine", () => {
  let engine: RevenueDistributionEngine;

  beforeEach(() => {
    engine = new RevenueDistributionEngine();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 1. CONFIGURABLE ALLOCATION POLICY & 100% VALIDATION
  // ─────────────────────────────────────────────────────────────────────────
  describe("Policy Configuration & Sum Validation", () => {
    it("should initialize with default 60% / 20% / 20% policy", () => {
      const policy = engine.getPolicy();
      expect(policy.tradingCapitalBps).to.equal(6000);
      expect(policy.reserveBps).to.equal(2000);
      expect(policy.revenueBps).to.equal(2000);
      expect(policy.tradingCapitalBps + policy.reserveBps + policy.revenueBps).to.equal(10000);
    });

    it("should accept valid 100% allocation configurations (e.g. 50/25/25, 70/15/15)", () => {
      const valid50_25_25: ThreeBucketAllocationPolicy = {
        tradingCapitalBps: 5000,
        reserveBps: 2500,
        revenueBps: 2500,
      };
      expect(() => engine.validatePolicy(valid50_25_25)).to.not.throw();

      const valid70_15_15: ThreeBucketAllocationPolicy = {
        tradingCapitalBps: 7000,
        reserveBps: 1500,
        revenueBps: 1500,
      };
      expect(() => engine.validatePolicy(valid70_15_15)).to.not.throw();
    });

    it("should reject invalid allocation sum > 100% (> 10000 bps)", () => {
      const invalidOver100: ThreeBucketAllocationPolicy = {
        tradingCapitalBps: 6000,
        reserveBps: 2500,
        revenueBps: 2000, // Total = 10500 bps (105%)
      };
      expect(() => engine.validatePolicy(invalidOver100)).to.throw(
        "Total allocation must equal exactly 10000 bps"
      );
    });

    it("should reject invalid allocation sum < 100% (< 10000 bps)", () => {
      const invalidUnder100: ThreeBucketAllocationPolicy = {
        tradingCapitalBps: 6000,
        reserveBps: 1500,
        revenueBps: 2000, // Total = 9500 bps (95%)
      };
      expect(() => engine.validatePolicy(invalidUnder100)).to.throw(
        "Total allocation must equal exactly 10000 bps"
      );
    });

    it("should reject negative percentages", () => {
      const negativePolicy: ThreeBucketAllocationPolicy = {
        tradingCapitalBps: 11000,
        reserveBps: -1000,
        revenueBps: 0,
      };
      expect(() => engine.validatePolicy(negativePolicy)).to.throw(
        "Allocation percentages cannot be negative"
      );
    });

    it("should enforce minimum and maximum bounds where configured", () => {
      const policyWithBounds: ThreeBucketAllocationPolicy = {
        tradingCapitalBps: 500, // below min 1000
        reserveBps: 4500,
        revenueBps: 5000,
        minTradingCapitalBps: 1000,
      };
      expect(() => engine.validatePolicy(policyWithBounds)).to.throw(
        "Trading Capital (500 bps) is below minimum allowed (1000 bps)"
      );

      const policyOverMax: ThreeBucketAllocationPolicy = {
        tradingCapitalBps: 9500, // above max 9000
        reserveBps: 250,
        revenueBps: 250,
        maxTradingCapitalBps: 9000,
      };
      expect(() => engine.validatePolicy(policyOverMax)).to.throw(
        "Trading Capital (9500 bps) exceeds maximum allowed (9000 bps)"
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 2. AUTHORIZATION FOR POLICY UPDATES
  // ─────────────────────────────────────────────────────────────────────────
  describe("Policy Update Authorization", () => {
    const newPolicy: ThreeBucketAllocationPolicy = {
      tradingCapitalBps: 5000,
      reserveBps: 3000,
      revenueBps: 2000,
    };

    it("should allow ADMIN to update the allocation policy", () => {
      const adminAddress = "0xAdmin1234567890123456789012345678901234";
      const record = engine.updatePolicy(newPolicy, "ADMIN", adminAddress, "0xtx123");

      expect(record.updatedBy).to.equal(adminAddress);
      expect(record.previousPolicy.tradingCapitalBps).to.equal(6000);
      expect(record.newPolicy.tradingCapitalBps).to.equal(5000);

      const current = engine.getPolicy();
      expect(current.tradingCapitalBps).to.equal(5000);
      expect(current.reserveBps).to.equal(3000);
      expect(current.revenueBps).to.equal(2000);
    });

    it("should reject policy update from non-admin roles (ARBITRAGE_EXECUTOR, TREASURY_MANAGER, ANONYMOUS)", () => {
      expect(() =>
        engine.updatePolicy(newPolicy, "ARBITRAGE_EXECUTOR", "0xBotAddress")
      ).to.throw("Unauthorized: Only ADMIN can modify revenue allocation policy");

      expect(() =>
        engine.updatePolicy(newPolicy, "TREASURY_MANAGER", "0xManagerAddress")
      ).to.throw("Unauthorized: Only ADMIN can modify revenue allocation policy");

      expect(() =>
        engine.updatePolicy(newPolicy, "ANONYMOUS", "0xAttacker")
      ).to.throw("Unauthorized: Only ADMIN can modify revenue allocation policy");
    });

    it("should maintain audit history of all policy changes", () => {
      engine.updatePolicy(newPolicy, "ADMIN", "0xAdmin1");
      const history = engine.getPolicyUpdateHistory();
      expect(history.length).to.equal(1);
      expect(history[0].updatedBy).to.equal("0xAdmin1");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3. INTEGER ARITHMETIC, ROUNDING, AND DUST HANDLING
  // ─────────────────────────────────────────────────────────────────────────
  describe("Distribution Arithmetic & Dust Handling", () => {
    it("should divide standard profit cleanly across buckets (60/20/20)", () => {
      const input: TradeSettlementInput = {
        tradeId: "TRADE-001",
        txHash: "0xhash001",
        chainId: 8453,
        token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC on Base
        tokenDecimals: 6,
        grossProfit: 120_000_000n, // $120 USDC
        dexFees: 10_000_000n,      // $10
        gasCost: 10_000_000n,      // $10
        confirmedRealizedNetProfit: 100_000_000n, // $100 USDC Net
        isConfirmed: true,
      };

      const calc = engine.calculateDistribution(input);
      expect(calc.realizedNetProfit).to.equal(100_000_000n);
      expect(calc.tradingCapitalAllocation).to.equal(60_000_000n); // 60% = $60
      expect(calc.reserveAllocation).to.equal(20_000_000n);        // 20% = $20
      expect(calc.revenueAllocation).to.equal(20_000_000n);        // 20% = $20
      expect(calc.dustAmount).to.equal(0n);

      // Invariant: sum of parts must equal realized net profit exactly
      const sum = calc.tradingCapitalAllocation + calc.reserveAllocation + calc.revenueAllocation;
      expect(sum).to.equal(calc.realizedNetProfit);
    });

    it("should safely absorb rounding dust for odd amounts with ZERO loss", () => {
      // 7 wei profit distributed 60/20/20:
      // tradingCapital = (7 * 6000) / 10000 = 4 wei
      // reserve = (7 * 2000) / 10000 = 1 wei
      // theoretical revenue = (7 * 2000) / 10000 = 1 wei
      // remainder = 7 - 4 - 1 = 2 wei absorbed into revenue
      const input: TradeSettlementInput = {
        tradeId: "TRADE-DUST",
        txHash: "0xdust",
        chainId: 8453,
        token: "0xUSDC",
        tokenDecimals: 18,
        grossProfit: 10n,
        dexFees: 1n,
        gasCost: 2n,
        confirmedRealizedNetProfit: 7n,
        isConfirmed: true,
      };

      const calc = engine.calculateDistribution(input);
      expect(calc.tradingCapitalAllocation).to.equal(4n);
      expect(calc.reserveAllocation).to.equal(1n);
      expect(calc.revenueAllocation).to.equal(2n); // absorbed 1 wei dust
      expect(calc.dustAmount).to.equal(1n);

      // Invariant holds
      const sum = calc.tradingCapitalAllocation + calc.reserveAllocation + calc.revenueAllocation;
      expect(sum).to.equal(7n);
    });

    it("should handle minimal 1 wei profit correctly", () => {
      const input: TradeSettlementInput = {
        tradeId: "TRADE-1WEI",
        txHash: "0x1wei",
        chainId: 8453,
        token: "0xUSDC",
        grossProfit: 2n,
        dexFees: 1n,
        gasCost: 0n,
        confirmedRealizedNetProfit: 1n,
        isConfirmed: true,
      };

      const calc = engine.calculateDistribution(input);
      expect(calc.realizedNetProfit).to.equal(1n);
      expect(calc.tradingCapitalAllocation).to.equal(0n);
      expect(calc.reserveAllocation).to.equal(0n);
      expect(calc.revenueAllocation).to.equal(1n); // absorbed
      expect(calc.tradingCapitalAllocation + calc.reserveAllocation + calc.revenueAllocation).to.equal(1n);
    });

    it("should handle large profit (e.g. 1,000,000 USDT in 18 decimals) without overflow", () => {
      const oneMillionUSDT = ethers.parseUnits("1000000", 18);
      const input: TradeSettlementInput = {
        tradeId: "TRADE-WHALE",
        txHash: "0xwhale",
        chainId: 8453,
        token: "0xUSDT",
        grossProfit: oneMillionUSDT + ethers.parseUnits("500", 18),
        dexFees: ethers.parseUnits("300", 18),
        gasCost: ethers.parseUnits("200", 18),
        confirmedRealizedNetProfit: oneMillionUSDT,
        isConfirmed: true,
      };

      const calc = engine.calculateDistribution(input);
      expect(calc.realizedNetProfit).to.equal(oneMillionUSDT);
      expect(calc.tradingCapitalAllocation).to.equal(ethers.parseUnits("600000", 18));
      expect(calc.reserveAllocation).to.equal(ethers.parseUnits("200000", 18));
      expect(calc.revenueAllocation).to.equal(ethers.parseUnits("200000", 18));
      expect(calc.dustAmount).to.equal(0n);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 4. UNREALIZED, ZERO, AND NEGATIVE PROFIT REJECTION
  // ─────────────────────────────────────────────────────────────────────────
  describe("Safety: Unrealized & Negative Profit Rejection", () => {
    it("should reject trade settlement if trade is unconfirmed (unrealized profit)", () => {
      const input: TradeSettlementInput = {
        tradeId: "TRADE-UNCONFIRMED",
        txHash: "0xpending",
        chainId: 8453,
        token: "0xUSDC",
        grossProfit: 100n,
        dexFees: 10n,
        gasCost: 10n,
        isConfirmed: false, // NOT confirmed!
      };

      const result = engine.processTradeSettlement(input);
      expect(result.status).to.equal("REJECTED_UNCONFIRMED");
      expect(result.tradingAllocation).to.equal(0n);
      expect(result.reserveAllocation).to.equal(0n);
      expect(result.revenueAllocation).to.equal(0n);
    });

    it("should reject trade settlement with zero net profit", () => {
      const input: TradeSettlementInput = {
        tradeId: "TRADE-ZERO",
        txHash: "0xzero",
        chainId: 8453,
        token: "0xUSDC",
        grossProfit: 20n,
        dexFees: 10n,
        gasCost: 10n, // net = 20 - 20 = 0
        isConfirmed: true,
      };

      const result = engine.processTradeSettlement(input);
      expect(result.status).to.equal("REJECTED_ZERO_PROFIT");
      expect(result.realizedNetProfit).to.equal(0n);
    });

    it("should reject negative net profit (trade loss)", () => {
      const input: TradeSettlementInput = {
        tradeId: "TRADE-LOSS",
        txHash: "0xloss",
        chainId: 8453,
        token: "0xUSDC",
        grossProfit: 10n,
        dexFees: 15n,
        gasCost: 10n, // net = 10 - 25 = -15
        isConfirmed: true,
      };

      const result = engine.processTradeSettlement(input);
      expect(result.status).to.equal("REJECTED_NEGATIVE_PROFIT");
      expect(result.realizedNetProfit).to.equal(-15n);
      expect(result.tradingAllocation).to.equal(0n);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 5. ACCOUNTING SEPARATION & SETTLEMENT RECORDING
  // ─────────────────────────────────────────────────────────────────────────
  describe("Accounting Ledger & History Recording", () => {
    it("should record complete DistributionResult details for confirmed trades", () => {
      const input: TradeSettlementInput = {
        tradeId: "TRADE-RECORD",
        txHash: "0xrecordtx",
        chainId: 8453,
        token: "0xUSDC",
        tokenDecimals: 6,
        grossProfit: 100_000_000n,
        dexFees: 0n,
        gasCost: 0n,
        confirmedRealizedNetProfit: 100_000_000n,
        isConfirmed: true,
      };

      const res = engine.processTradeSettlement(input);
      expect(res.tradeId).to.equal("TRADE-RECORD");
      expect(res.txHash).to.equal("0xrecordtx");
      expect(res.chainId).to.equal(8453);
      expect(res.token).to.equal("0xUSDC");
      expect(res.realizedNetProfit).to.equal(100_000_000n);
      expect(res.realizedNetProfitFormatted).to.equal(100);
      expect(res.tradingAllocation).to.equal(60_000_000n);
      expect(res.tradingAllocationFormatted).to.equal(60);
      expect(res.reserveAllocation).to.equal(20_000_000n);
      expect(res.reserveAllocationFormatted).to.equal(20);
      expect(res.revenueAllocation).to.equal(20_000_000n);
      expect(res.revenueAllocationFormatted).to.equal(20);
      expect(res.allocationPercentages.tradingCapitalPct).to.equal(60);
      expect(res.allocationPercentages.reservePct).to.equal(20);
      expect(res.allocationPercentages.revenuePct).to.equal(20);
      expect(res.status).to.equal("DISTRIBUTED");
    });

    it("should keep cumulative bucket accounting segregated across multiple trades", () => {
      const token = "0xUSDC";
      const input1: TradeSettlementInput = {
        tradeId: "TRADE-1",
        txHash: "0x1",
        chainId: 8453,
        token,
        grossProfit: 1000n,
        dexFees: 0n,
        gasCost: 0n,
        confirmedRealizedNetProfit: 1000n,
        isConfirmed: true,
      };
      const input2: TradeSettlementInput = {
        tradeId: "TRADE-2",
        txHash: "0x2",
        chainId: 8453,
        token,
        grossProfit: 500n,
        dexFees: 0n,
        gasCost: 0n,
        confirmedRealizedNetProfit: 500n,
        isConfirmed: true,
      };

      engine.processTradeSettlement(input1);
      engine.processTradeSettlement(input2);

      const balances = engine.getBucketBalances(token);
      // Trade 1: 600, 200, 200
      // Trade 2: 300, 100, 100
      // Total: 900, 300, 300 (total = 1500)
      expect(balances.tradingCapital).to.equal(900n);
      expect(balances.reserve).to.equal(300n);
      expect(balances.revenue).to.equal(300n);
      expect(balances.totalDistributed).to.equal(1500n);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 6. REVENUE WITHDRAWAL PERMISSIONS & SECURITY
  // ─────────────────────────────────────────────────────────────────────────
  describe("Revenue Withdrawal Permissions", () => {
    const availableRevenue = ethers.parseUnits("5000", 18);

    it("should strictly forbid Trading Bot (ARBITRAGE_EXECUTOR) from withdrawing revenue", () => {
      const check = engine.validateRevenueWithdrawal({
        callerAddress: "0xBotAddress",
        callerRole: "ARBITRAGE_EXECUTOR",
        token: "0xToken",
        amount: ethers.parseUnits("100", 18),
        availableRevenue,
        isPaused: false,
      });

      expect(check.allowed).to.be.false;
      expect(check.reason).to.include("Trading Bot (ARBITRAGE_EXECUTOR) is strictly forbidden");
    });

    it("should allow TREASURY_MANAGER to withdraw within balance", () => {
      const check = engine.validateRevenueWithdrawal({
        callerAddress: "0xManagerAddress",
        callerRole: "TREASURY_MANAGER",
        token: "0xToken",
        amount: ethers.parseUnits("1000", 18),
        availableRevenue,
        isPaused: false,
      });

      expect(check.allowed).to.be.true;
    });

    it("should allow ADMIN to withdraw within balance", () => {
      const check = engine.validateRevenueWithdrawal({
        callerAddress: "0xAdminAddress",
        callerRole: "ADMIN",
        token: "0xToken",
        amount: ethers.parseUnits("5000", 18),
        availableRevenue,
        isPaused: false,
      });

      expect(check.allowed).to.be.true;
    });

    it("should reject unauthorized callers (ANONYMOUS)", () => {
      const check = engine.validateRevenueWithdrawal({
        callerAddress: "0xAttacker",
        callerRole: "ANONYMOUS",
        token: "0xToken",
        amount: ethers.parseUnits("100", 18),
        availableRevenue,
        isPaused: false,
      });

      expect(check.allowed).to.be.false;
      expect(check.reason).to.include("Unauthorized: Only ADMIN or TREASURY_MANAGER");
    });

    it("should reject revenue withdrawal when Treasury is paused", () => {
      const check = engine.validateRevenueWithdrawal({
        callerAddress: "0xAdminAddress",
        callerRole: "ADMIN",
        token: "0xToken",
        amount: ethers.parseUnits("100", 18),
        availableRevenue,
        isPaused: true, // PAUSED!
      });

      expect(check.allowed).to.be.false;
      expect(check.reason).to.include("Treasury is paused");
    });

    it("should reject withdrawal exceeding available revenue balance", () => {
      const check = engine.validateRevenueWithdrawal({
        callerAddress: "0xManagerAddress",
        callerRole: "TREASURY_MANAGER",
        token: "0xToken",
        amount: ethers.parseUnits("6000", 18), // available is 5000
        availableRevenue,
        isPaused: false,
      });

      expect(check.allowed).to.be.false;
      expect(check.reason).to.include("Insufficient revenue balance");
    });
  });
});
