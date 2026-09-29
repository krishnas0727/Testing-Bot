/**
 * @file DatabaseService.ts
 * @description Phase 13: In-Memory / Database Service with Filtering, Sorting & Pagination
 *
 * Implements high-performance state management for trades, opportunities, transactions,
 * alerts, revenue allocations, and aggregated P&L statistics.
 */

import {
  StoredOpportunity,
  StoredTrade,
  StoredTransaction,
  SystemAlert,
  ProfitLossSummary,
  PaginationParams,
  PaginatedResult,
} from "../types";
import { RevenueAllocation, SupportedChainId } from "../../types";

export class DatabaseService {
  private opportunities: StoredOpportunity[] = [];
  private trades: StoredTrade[] = [];
  private transactions: StoredTransaction[] = [];
  private alerts: SystemAlert[] = [];
  private revenueAllocations: RevenueAllocation[] = [];

  constructor() {
    this.seedInitialData();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SEED DATA FOR DEMO & TESTING
  // ─────────────────────────────────────────────────────────────────────────

  private seedInitialData(): void {
    // In production or live mode, strictly preserve an empty, clean ledger (No fake trades/profits)
    if (process.env.NODE_ENV === "production" || process.env.TRADING_MODE === "LIVE") {
      return;
    }

    const now = Date.now();

    // Seed opportunities
    this.opportunities = [
      {
        id: "opp-001",
        chainId: 8453,
        tokenIn: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC
        tokenOut: "0x4200000000000000000000000000000000000006", // WETH
        buyDex: "Uniswap_V2",
        sellDex: "SushiSwap_V2",
        amountInFormatted: 50.0,
        expectedGrossProfitUsdt: 1.25,
        netProfitUsdt: 0.85,
        roiPct: 1.7,
        priceImpactPct: 0.12,
        status: "ACTIVE",
        timestamp: now - 30_000,
      },
      {
        id: "opp-002",
        chainId: 8453,
        tokenIn: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        tokenOut: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", // DAI
        buyDex: "SushiSwap_V2",
        sellDex: "Uniswap_V2",
        amountInFormatted: 100.0,
        expectedGrossProfitUsdt: 2.5,
        netProfitUsdt: 1.75,
        roiPct: 1.75,
        priceImpactPct: 0.08,
        status: "ACTIVE",
        timestamp: now - 15_000,
      },
    ];

    // Seed trades
    this.trades = [
      {
        id: "trade-001",
        tradeId: "TX-SETTLED-101",
        txHash: "0x9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b",
        chainId: 8453,
        tokenIn: "USDC",
        tokenOut: "WETH",
        amountIn: 100.0,
        buyDex: "Uniswap_V2",
        sellDex: "SushiSwap_V2",
        grossProfitUsdt: 3.2,
        netProfitUsdt: 2.1,
        roiPct: 2.1,
        gasCostUsdt: 0.45,
        status: "CONFIRMED",
        executionTimeMs: 420,
        timestamp: now - 3600_000,
      },
      {
        id: "trade-002",
        tradeId: "TX-SETTLED-102",
        txHash: "0x11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff",
        chainId: 8453,
        tokenIn: "USDT",
        tokenOut: "WETH",
        amountIn: 50.0,
        buyDex: "SushiSwap_V2",
        sellDex: "Uniswap_V2",
        grossProfitUsdt: 1.5,
        netProfitUsdt: 0.95,
        roiPct: 1.9,
        gasCostUsdt: 0.35,
        status: "CONFIRMED",
        executionTimeMs: 380,
        timestamp: now - 1800_000,
      },
    ];

    // Seed transactions
    this.transactions = [
      {
        txHash: "0x9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b",
        chainId: 8453,
        blockNumber: 15420110,
        from: "0xExecutorBot",
        to: "0xArbitrageContract",
        gasUsed: 145000,
        effectiveGasPriceGwei: 0.05,
        status: "SUCCESS",
        syncedAt: now - 3600_000,
        timestamp: now - 3600_000,
      },
      {
        txHash: "0x11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff",
        chainId: 8453,
        blockNumber: 15420340,
        from: "0xExecutorBot",
        to: "0xArbitrageContract",
        gasUsed: 138000,
        effectiveGasPriceGwei: 0.05,
        status: "SUCCESS",
        syncedAt: now - 1800_000,
        timestamp: now - 1800_000,
      },
    ];

    // Seed alerts
    this.alerts = [
      {
        id: "alert-001",
        severity: "INFO",
        source: "ENGINE",
        title: "Bot Engine Initialized",
        message: "Arbitrage detection engine online on Base L2",
        resolved: true,
        timestamp: now - 7200_000,
      },
    ];

    // Seed revenue allocations
    this.revenueAllocations = [
      {
        id: 1,
        tradeId: 101,
        txHash: "0x9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b",
        chainId: 8453,
        token: "USDC",
        netProfit: 2.1,
        tradingCapital: 1.26, // 60%
        reserve: 0.42,        // 20%
        revenue: 0.42,        // 20%
        createdAt: new Date(now - 3600_000).toISOString(),
      },
    ];
  }

  // ─────────────────────────────────────────────────────────────────────────
  // OPPORTUNITIES
  // ─────────────────────────────────────────────────────────────────────────

  public getOpportunities(
    filter: { status?: string; chainId?: number; minNetProfit?: number },
    pagination: PaginationParams
  ): PaginatedResult<StoredOpportunity> {
    let items = [...this.opportunities];

    if (filter.status) {
      items = items.filter((o) => o.status === filter.status);
    }
    if (filter.chainId) {
      items = items.filter((o) => o.chainId === filter.chainId);
    }
    if (filter.minNetProfit !== undefined) {
      items = items.filter((o) => o.netProfitUsdt >= filter.minNetProfit!);
    }

    // Sort
    const sortField = filterSortField(filterSortField(pagination.sortBy || "timestamp"));
    const sortOrder = pagination.sortOrder === "asc" ? 1 : -1;
    items.sort((a: any, b: any) => {
      const valA = a[sortField] ?? a.timestamp;
      const valB = b[sortField] ?? b.timestamp;
      return valA > valB ? sortOrder : -sortOrder;
    });

    return paginateArray(items, pagination);
  }

  public getOpportunityById(id: string): StoredOpportunity | undefined {
    return this.opportunities.find((o) => o.id === id);
  }

  public addOpportunity(opp: StoredOpportunity): StoredOpportunity {
    this.opportunities.unshift(opp);
    return opp;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TRADES
  // ─────────────────────────────────────────────────────────────────────────

  public getTrades(
    filter: { status?: string; chainId?: number; token?: string },
    pagination: PaginationParams
  ): PaginatedResult<StoredTrade> {
    let items = [...this.trades];

    if (filter.status) {
      items = items.filter((t) => t.status === filter.status);
    }
    if (filter.chainId) {
      items = items.filter((t) => t.chainId === filter.chainId);
    }
    if (filter.token) {
      const q = filter.token.toLowerCase();
      items = items.filter(
        (t) => t.tokenIn.toLowerCase() === q || t.tokenOut.toLowerCase() === q
      );
    }

    const sortField = pagination.sortBy || "timestamp";
    const sortOrder = pagination.sortOrder === "asc" ? 1 : -1;
    items.sort((a: any, b: any) => {
      const valA = a[sortField] ?? a.timestamp;
      const valB = b[sortField] ?? b.timestamp;
      return valA > valB ? sortOrder : -sortOrder;
    });

    return paginateArray(items, pagination);
  }

  public getTradeById(id: string): StoredTrade | undefined {
    return this.trades.find((t) => t.id === id || t.tradeId === id || t.txHash === id);
  }

  public addTrade(trade: StoredTrade): StoredTrade {
    this.trades.unshift(trade);
    return trade;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TRANSACTIONS
  // ─────────────────────────────────────────────────────────────────────────

  public getTransactions(
    filter: { status?: string; chainId?: number },
    pagination: PaginationParams
  ): PaginatedResult<StoredTransaction> {
    let items = [...this.transactions];

    if (filter.status) {
      items = items.filter((tx) => tx.status === filter.status);
    }
    if (filter.chainId) {
      items = items.filter((tx) => tx.chainId === filter.chainId);
    }

    items.sort((a, b) => b.timestamp - a.timestamp);
    return paginateArray(items, pagination);
  }

  public getTransactionByHash(txHash: string): StoredTransaction | undefined {
    return this.transactions.find((tx) => tx.txHash.toLowerCase() === txHash.toLowerCase());
  }

  public upsertTransaction(tx: StoredTransaction): StoredTransaction {
    const idx = this.transactions.findIndex(
      (item) => item.txHash.toLowerCase() === tx.txHash.toLowerCase()
    );
    if (idx >= 0) {
      this.transactions[idx] = { ...this.transactions[idx], ...tx };
      return this.transactions[idx];
    } else {
      this.transactions.unshift(tx);
      return tx;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PROFIT & LOSS AGGREGATOR
  // ─────────────────────────────────────────────────────────────────────────

  public getProfitLoss(period: "24h" | "7d" | "30d" | "all"): ProfitLossSummary {
    const now = Date.now();
    let cutoff = 0;
    if (period === "24h") cutoff = now - 24 * 3600_000;
    else if (period === "7d") cutoff = now - 7 * 24 * 3600_000;
    else if (period === "30d") cutoff = now - 30 * 24 * 3600_000;

    const filtered = this.trades.filter((t) => t.timestamp >= cutoff);
    const totalTrades = filtered.length;
    const successfulTrades = filtered.filter((t) => t.status === "CONFIRMED").length;
    const failedTrades = filtered.filter((t) => t.status === "REVERTED").length;

    let grossProfitUsdt = 0;
    let totalGasCostUsdt = 0;
    let netProfitUsdt = 0;
    let largestProfitUsdt = 0;
    let largestLossUsdt = 0;
    let totalRoi = 0;

    for (const t of filtered) {
      if (t.status === "CONFIRMED") {
        grossProfitUsdt += t.grossProfitUsdt;
        totalGasCostUsdt += t.gasCostUsdt;
        netProfitUsdt += t.netProfitUsdt;
        totalRoi += t.roiPct;
        if (t.netProfitUsdt > largestProfitUsdt) largestProfitUsdt = t.netProfitUsdt;
      } else if (t.status === "REVERTED") {
        totalGasCostUsdt += t.gasCostUsdt;
        netProfitUsdt -= t.gasCostUsdt;
        if (t.gasCostUsdt > largestLossUsdt) largestLossUsdt = t.gasCostUsdt;
      }
    }

    const winRatePct = totalTrades > 0 ? (successfulTrades / totalTrades) * 100 : 0;
    const averageRoiPct = successfulTrades > 0 ? totalRoi / successfulTrades : 0;

    return {
      period,
      totalTrades,
      successfulTrades,
      failedTrades,
      winRatePct: Number(winRatePct.toFixed(2)),
      grossProfitUsdt: Number(grossProfitUsdt.toFixed(4)),
      totalGasCostUsdt: Number(totalGasCostUsdt.toFixed(4)),
      netProfitUsdt: Number(netProfitUsdt.toFixed(4)),
      averageRoiPct: Number(averageRoiPct.toFixed(2)),
      largestProfitUsdt: Number(largestProfitUsdt.toFixed(4)),
      largestLossUsdt: Number(largestLossUsdt.toFixed(4)),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ALERTS
  // ─────────────────────────────────────────────────────────────────────────

  public getAlerts(
    filter: { severity?: string; resolved?: boolean },
    pagination: PaginationParams
  ): PaginatedResult<SystemAlert> {
    let items = [...this.alerts];
    if (filter.severity) {
      items = items.filter((a) => a.severity === filter.severity);
    }
    if (filter.resolved !== undefined) {
      items = items.filter((a) => a.resolved === filter.resolved);
    }
    items.sort((a, b) => b.timestamp - a.timestamp);
    return paginateArray(items, pagination);
  }

  public addAlert(alert: SystemAlert): SystemAlert {
    this.alerts.unshift(alert);
    return alert;
  }

  public resolveAlert(id: string): boolean {
    const alert = this.alerts.find((a) => a.id === id);
    if (alert) {
      alert.resolved = true;
      return true;
    }
    return false;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // REVENUE ALLOCATIONS
  // ─────────────────────────────────────────────────────────────────────────

  public getRevenueAllocations(
    filter: { chainId?: number },
    pagination: PaginationParams
  ): PaginatedResult<RevenueAllocation> {
    let items = [...this.revenueAllocations];
    if (filter.chainId) {
      items = items.filter((r) => r.chainId === filter.chainId);
    }
    return paginateArray(items, pagination);
  }

  public addRevenueAllocation(allocation: RevenueAllocation): RevenueAllocation {
    this.revenueAllocations.unshift(allocation);
    return allocation;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PAGINATION HELPER
// ─────────────────────────────────────────────────────────────────────────────

function paginateArray<T>(items: T[], params: PaginationParams): PaginatedResult<T> {
  const page = Math.max(1, params.page || 1);
  const limit = Math.max(1, Math.min(100, params.limit || 20));
  const totalItems = items.length;
  const totalPages = Math.ceil(totalItems / limit) || 1;
  const startIndex = (page - 1) * limit;
  const paginatedItems = items.slice(startIndex, startIndex + limit);

  return {
    items: paginatedItems,
    pagination: {
      page,
      limit,
      totalItems,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    },
  };
}

function filterSortField(field: string): string {
  const allowed = new Set(["timestamp", "netProfitUsdt", "roiPct", "amountInFormatted"]);
  return allowed.has(field) ? field : "timestamp";
}
