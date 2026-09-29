/**
 * @file RevenueDistributionEngine.ts
 * @description Phase 11: Revenue Distribution Engine
 *
 * Implements configurable multi-bucket revenue distribution for realized net profit:
 * - Configurable allocation policy (e.g. 60% Trading Capital, 20% Reserve, 20% Revenue)
 * - Strict 100% (10,000 bps) sum validation and min/max bound checks
 * - Role-based authorization for policy updates (ADMIN only)
 * - Precise integer arithmetic (no floating point errors in token distribution)
 * - Deterministic rounding / dust absorption into designated bucket
 * - Rejection of unconfirmed, zero, or negative/unrealized profit
 * - Independent accounting for Trading Capital, Reserve, and Revenue
 * - Revenue withdrawal permission guarding (Trading bot blocked from revenue withdrawals)
 * - Full ledger history with distribution results and policy update audit records
 */

import { ethers } from "ethers";
import {
  ThreeBucketAllocationPolicy,
  DEFAULT_ALLOCATION_POLICY,
  BPS_DENOMINATOR,
  TradeSettlementInput,
  DistributionCalculation,
  DistributionResult,
  PolicyUpdateRecord,
  RevenueWithdrawalValidation,
} from "./types";

export class RevenueDistributionEngine {
  private currentPolicy: ThreeBucketAllocationPolicy;
  private readonly distributionHistory: DistributionResult[] = [];
  private readonly policyUpdateHistory: PolicyUpdateRecord[] = [];

  // Accumulated ledger across all distributed trades: token => { trading, reserve, revenue, totalDistributed }
  private readonly ledger: Map<
    string,
    { tradingCapital: bigint; reserve: bigint; revenue: bigint; totalDistributed: bigint }
  > = new Map();

  constructor(initialPolicy: ThreeBucketAllocationPolicy = DEFAULT_ALLOCATION_POLICY) {
    this.validatePolicy(initialPolicy);
    this.currentPolicy = { ...initialPolicy };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // POLICY MANAGEMENT & AUTHORIZATION
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Returns current active allocation policy.
   */
  public getPolicy(): ThreeBucketAllocationPolicy {
    return { ...this.currentPolicy };
  }

  /**
   * Validates policy configuration:
   * 1. Must sum to exactly 10,000 basis points (100.00%)
   * 2. No negative percentages
   * 3. Respects configured minimum/maximum bounds
   */
  public validatePolicy(policy: ThreeBucketAllocationPolicy): void {
    if (
      policy.tradingCapitalBps < 0 ||
      policy.reserveBps < 0 ||
      policy.revenueBps < 0
    ) {
      throw new Error("Allocation percentages cannot be negative");
    }

    const totalBps = policy.tradingCapitalBps + policy.reserveBps + policy.revenueBps;
    if (totalBps !== 10000) {
      throw new Error(
        `Total allocation must equal exactly 10000 bps (100.00%). Current sum: ${totalBps} bps`
      );
    }

    // Check minimum bounds if defined
    if (policy.minTradingCapitalBps !== undefined && policy.tradingCapitalBps < policy.minTradingCapitalBps) {
      throw new Error(
        `Trading Capital (${policy.tradingCapitalBps} bps) is below minimum allowed (${policy.minTradingCapitalBps} bps)`
      );
    }
    if (policy.minReserveBps !== undefined && policy.reserveBps < policy.minReserveBps) {
      throw new Error(
        `Reserve (${policy.reserveBps} bps) is below minimum allowed (${policy.minReserveBps} bps)`
      );
    }
    if (policy.minRevenueBps !== undefined && policy.revenueBps < policy.minRevenueBps) {
      throw new Error(
        `Revenue (${policy.revenueBps} bps) is below minimum allowed (${policy.minRevenueBps} bps)`
      );
    }

    // Check maximum bounds if defined
    if (policy.maxTradingCapitalBps !== undefined && policy.tradingCapitalBps > policy.maxTradingCapitalBps) {
      throw new Error(
        `Trading Capital (${policy.tradingCapitalBps} bps) exceeds maximum allowed (${policy.maxTradingCapitalBps} bps)`
      );
    }
    if (policy.maxReserveBps !== undefined && policy.reserveBps > policy.maxReserveBps) {
      throw new Error(
        `Reserve (${policy.reserveBps} bps) exceeds maximum allowed (${policy.maxReserveBps} bps)`
      );
    }
    if (policy.maxRevenueBps !== undefined && policy.revenueBps > policy.maxRevenueBps) {
      throw new Error(
        `Revenue (${policy.revenueBps} bps) exceeds maximum allowed (${policy.maxRevenueBps} bps)`
      );
    }
  }

  /**
   * Updates allocation policy with role authorization check.
   * Only ADMIN is permitted to modify the revenue policy.
   */
  public updatePolicy(
    newPolicy: ThreeBucketAllocationPolicy,
    callerRole: "ADMIN" | "TREASURY_MANAGER" | "ARBITRAGE_EXECUTOR" | "ANONYMOUS",
    callerAddress: string,
    txHash?: string
  ): PolicyUpdateRecord {
    if (callerRole !== "ADMIN") {
      throw new Error(
        `Unauthorized: Only ADMIN can modify revenue allocation policy. Caller role: ${callerRole}`
      );
    }

    this.validatePolicy(newPolicy);

    const record: PolicyUpdateRecord = {
      updatedBy: callerAddress,
      previousPolicy: { ...this.currentPolicy },
      newPolicy: { ...newPolicy },
      timestamp: Date.now(),
      txHash,
    };

    this.currentPolicy = { ...newPolicy };
    this.policyUpdateHistory.push(record);
    return record;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PROFIT & DISTRIBUTION ARITHMETIC
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Calculates precise integer distribution for a trade.
   * Ensures zero unrealized profit is distributed and absorbs rounding dust cleanly.
   */
  public calculateDistribution(
    input: TradeSettlementInput,
    overridePolicy?: ThreeBucketAllocationPolicy
  ): DistributionCalculation {
    const policy = overridePolicy || this.currentPolicy;
    this.validatePolicy(policy);

    const tokenDecimals = input.tokenDecimals ?? 18;
    const totalCosts = input.dexFees + input.gasCost + (input.otherCosts ?? 0n);

    // If confirmedRealizedNetProfit is explicitly supplied, verify it matches or use it
    let netProfit = input.confirmedRealizedNetProfit !== undefined
      ? input.confirmedRealizedNetProfit
      : input.grossProfit - totalCosts;

    if (!input.isConfirmed) {
      throw new Error("Unrealized profit rejected: Trade execution is not confirmed");
    }

    if (netProfit <= 0n) {
      throw new Error(`Realized net profit must be positive. Current value: ${netProfit.toString()}`);
    }

    // Integer arithmetic in basis points
    const tradingCapitalBpsBig = BigInt(policy.tradingCapitalBps);
    const reserveBpsBig = BigInt(policy.reserveBps);

    const tradingCapitalAllocation = (netProfit * tradingCapitalBpsBig) / BPS_DENOMINATOR;
    const reserveAllocation = (netProfit * reserveBpsBig) / BPS_DENOMINATOR;

    // Dust handling: remainder is assigned to Revenue bucket to guarantee:
    // tradingCapitalAllocation + reserveAllocation + revenueAllocation === netProfit
    const revenueAllocation = netProfit - tradingCapitalAllocation - reserveAllocation;

    // Theoretical exact revenue before dust absorption
    const theoreticalRevenue = (netProfit * BigInt(policy.revenueBps)) / BPS_DENOMINATOR;
    const dustAmount = revenueAllocation - theoreticalRevenue;

    const fmt = (val: bigint) => Number(ethers.formatUnits(val, tokenDecimals));

    return {
      grossProfit: input.grossProfit,
      totalCosts,
      realizedNetProfit: netProfit,
      tradingCapitalAllocation,
      reserveAllocation,
      revenueAllocation,
      dustAmount,
      formatted: {
        grossProfit: fmt(input.grossProfit),
        totalCosts: fmt(totalCosts),
        realizedNetProfit: fmt(netProfit),
        tradingCapital: fmt(tradingCapitalAllocation),
        reserve: fmt(reserveAllocation),
        revenue: fmt(revenueAllocation),
        tradingCapitalPct: policy.tradingCapitalBps / 100,
        reservePct: policy.reserveBps / 100,
        revenuePct: policy.revenueBps / 100,
      },
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TRADE SETTLEMENT & DISTRIBUTION RECORDING
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Processes an executed trade, computes the 3-bucket distribution,
   * updates the accounting ledger, and records the result.
   */
  public processTradeSettlement(input: TradeSettlementInput): DistributionResult {
    const tokenDecimals = input.tokenDecimals ?? 18;
    const now = Date.now();
    const tokenKey = input.token.toLowerCase();

    // 1. Check confirmation
    if (!input.isConfirmed) {
      const rejectedResult: DistributionResult = {
        tradeId: input.tradeId,
        txHash: input.txHash,
        chainId: input.chainId,
        token: input.token,
        realizedNetProfit: 0n,
        realizedNetProfitFormatted: 0,
        tradingAllocation: 0n,
        tradingAllocationFormatted: 0,
        reserveAllocation: 0n,
        reserveAllocationFormatted: 0,
        revenueAllocation: 0n,
        revenueAllocationFormatted: 0,
        allocationPercentages: {
          tradingCapitalPct: this.currentPolicy.tradingCapitalBps / 100,
          reservePct: this.currentPolicy.reserveBps / 100,
          revenuePct: this.currentPolicy.revenueBps / 100,
        },
        timestamp: now,
        status: "REJECTED_UNCONFIRMED",
        rejectionReason: "Trade is unconfirmed. Unrealized profits cannot be distributed.",
      };
      this.distributionHistory.push(rejectedResult);
      return rejectedResult;
    }

    // 2. Compute net profit
    const totalCosts = input.dexFees + input.gasCost + (input.otherCosts ?? 0n);
    const netProfit = input.confirmedRealizedNetProfit !== undefined
      ? input.confirmedRealizedNetProfit
      : input.grossProfit - totalCosts;

    if (netProfit === 0n) {
      const zeroResult: DistributionResult = {
        tradeId: input.tradeId,
        txHash: input.txHash,
        chainId: input.chainId,
        token: input.token,
        realizedNetProfit: 0n,
        realizedNetProfitFormatted: 0,
        tradingAllocation: 0n,
        tradingAllocationFormatted: 0,
        reserveAllocation: 0n,
        reserveAllocationFormatted: 0,
        revenueAllocation: 0n,
        revenueAllocationFormatted: 0,
        allocationPercentages: {
          tradingCapitalPct: this.currentPolicy.tradingCapitalBps / 100,
          reservePct: this.currentPolicy.reserveBps / 100,
          revenuePct: this.currentPolicy.revenueBps / 100,
        },
        timestamp: now,
        status: "REJECTED_ZERO_PROFIT",
        rejectionReason: "Trade generated zero net profit. Nothing to distribute.",
      };
      this.distributionHistory.push(zeroResult);
      return zeroResult;
    }

    if (netProfit < 0n) {
      const negativeResult: DistributionResult = {
        tradeId: input.tradeId,
        txHash: input.txHash,
        chainId: input.chainId,
        token: input.token,
        realizedNetProfit: netProfit,
        realizedNetProfitFormatted: Number(ethers.formatUnits(netProfit, tokenDecimals)),
        tradingAllocation: 0n,
        tradingAllocationFormatted: 0,
        reserveAllocation: 0n,
        reserveAllocationFormatted: 0,
        revenueAllocation: 0n,
        revenueAllocationFormatted: 0,
        allocationPercentages: {
          tradingCapitalPct: this.currentPolicy.tradingCapitalBps / 100,
          reservePct: this.currentPolicy.reserveBps / 100,
          revenuePct: this.currentPolicy.revenueBps / 100,
        },
        timestamp: now,
        status: "REJECTED_NEGATIVE_PROFIT",
        rejectionReason: `Trade was net negative (${netProfit.toString()} units). Unrealized profit rejection.`,
      };
      this.distributionHistory.push(negativeResult);
      return negativeResult;
    }

    // 3. Compute clean distribution
    const calc = this.calculateDistribution(input);

    // 4. Update Ledger
    const currentLedger = this.ledger.get(tokenKey) || {
      tradingCapital: 0n,
      reserve: 0n,
      revenue: 0n,
      totalDistributed: 0n,
    };

    currentLedger.tradingCapital += calc.tradingCapitalAllocation;
    currentLedger.reserve += calc.reserveAllocation;
    currentLedger.revenue += calc.revenueAllocation;
    currentLedger.totalDistributed += calc.realizedNetProfit;
    this.ledger.set(tokenKey, currentLedger);

    const fmt = (v: bigint) => Number(ethers.formatUnits(v, tokenDecimals));

    const result: DistributionResult = {
      tradeId: input.tradeId,
      txHash: input.txHash,
      chainId: input.chainId,
      token: input.token,
      realizedNetProfit: calc.realizedNetProfit,
      realizedNetProfitFormatted: fmt(calc.realizedNetProfit),
      tradingAllocation: calc.tradingCapitalAllocation,
      tradingAllocationFormatted: fmt(calc.tradingCapitalAllocation),
      reserveAllocation: calc.reserveAllocation,
      reserveAllocationFormatted: fmt(calc.reserveAllocation),
      revenueAllocation: calc.revenueAllocation,
      revenueAllocationFormatted: fmt(calc.revenueAllocation),
      allocationPercentages: {
        tradingCapitalPct: this.currentPolicy.tradingCapitalBps / 100,
        reservePct: this.currentPolicy.reserveBps / 100,
        revenuePct: this.currentPolicy.revenueBps / 100,
      },
      timestamp: now,
      status: "DISTRIBUTED",
    };

    this.distributionHistory.push(result);
    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // REVENUE WITHDRAWAL PERMISSIONS & SECURITY
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Enforces revenue withdrawal restrictions:
   * 1. The trading bot (ARBITRAGE_EXECUTOR) MUST NOT have revenue withdrawal permission.
   * 2. Rejects if Treasury is paused.
   * 3. Requires TREASURY_MANAGER or ADMIN role.
   * 4. Validates requested amount against available revenue balance.
   */
  public validateRevenueWithdrawal(validation: RevenueWithdrawalValidation): {
    allowed: boolean;
    reason?: string;
  } {
    if (validation.callerRole === "ARBITRAGE_EXECUTOR") {
      return {
        allowed: false,
        reason: "Security Violation: Trading Bot (ARBITRAGE_EXECUTOR) is strictly forbidden from withdrawing protocol revenue.",
      };
    }

    if (validation.isPaused) {
      return {
        allowed: false,
        reason: "Treasury is paused. Revenue withdrawals are temporarily suspended.",
      };
    }

    if (validation.callerRole !== "ADMIN" && validation.callerRole !== "TREASURY_MANAGER") {
      return {
        allowed: false,
        reason: `Unauthorized: Only ADMIN or TREASURY_MANAGER can withdraw revenue. Caller role: ${validation.callerRole}`,
      };
    }

    if (validation.amount <= 0n) {
      return {
        allowed: false,
        reason: "Withdrawal amount must be greater than zero.",
      };
    }

    if (validation.amount > validation.availableRevenue) {
      return {
        allowed: false,
        reason: `Insufficient revenue balance. Requested: ${validation.amount.toString()}, Available: ${validation.availableRevenue.toString()}`,
      };
    }

    return { allowed: true };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // VIEW & AUDIT METHODS
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Retrieves bucket balances for a specific token.
   */
  public getBucketBalances(tokenAddress: string): {
    tradingCapital: bigint;
    reserve: bigint;
    revenue: bigint;
    totalDistributed: bigint;
  } {
    return this.ledger.get(tokenAddress.toLowerCase()) || {
      tradingCapital: 0n,
      reserve: 0n,
      revenue: 0n,
      totalDistributed: 0n,
    };
  }

  /**
   * Returns all recorded distribution results.
   */
  public getDistributionHistory(): readonly DistributionResult[] {
    return this.distributionHistory;
  }

  /**
   * Returns all recorded policy updates.
   */
  public getPolicyUpdateHistory(): readonly PolicyUpdateRecord[] {
    return this.policyUpdateHistory;
  }
}
