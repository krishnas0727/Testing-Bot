/**
 * @file DashboardApiClient.ts
 * @description Phase 14: Secure API Client for Dashboard Frontend
 *
 * Connects exclusively through the Phase 13 backend API.
 * Never stores or transmits private keys. Handles role-based tokens,
 * pagination, filtering, and explicit separation of estimated vs. realized profits.
 */

import { UserRole } from "../api/types";
import { formatCurrency, getTxExplorerUrl, truncateHash } from "./types";
import { SupportedChainId } from "../types";

export interface DashboardClientConfig {
  baseUrl: string;
  defaultRole?: UserRole;
  timeoutMs?: number;
}

export class DashboardApiClient {
  private readonly baseUrl: string;
  private currentRole: UserRole = "VIEWER";
  private currentApiKey: string = "viewer-readonly-key-123";

  // Pre-configured role key map
  private static readonly ROLE_KEY_MAP: Record<UserRole, string> = {
    ADMIN: "admin-secret-key-999",
    OPERATOR: "operator-key-456",
    VIEWER: "viewer-readonly-key-123",
  };

  constructor(config?: Partial<DashboardClientConfig>) {
    this.baseUrl = config?.baseUrl || "http://localhost:3000";
    if (config?.defaultRole) {
      this.setRole(config.defaultRole);
    }
  }

  /**
   * Sets active role and switches authentication credentials.
   */
  public setRole(role: UserRole): void {
    this.currentRole = role;
    this.currentApiKey = DashboardApiClient.ROLE_KEY_MAP[role] || "viewer-readonly-key-123";
  }

  public getRole(): UserRole {
    return this.currentRole;
  }

  /**
   * Low-level fetch wrapper with headers and error formatting.
   */
  public async request<T = any>(
    path: string,
    options?: {
      method?: string;
      body?: any;
      headers?: Record<string, string>;
    }
  ): Promise<{ success: boolean; data?: T; error?: string; pagination?: any }> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-API-Key": this.currentApiKey,
      ...(options?.headers || {}),
    };

    try {
      const fetchFn = typeof fetch !== "undefined" ? fetch : (global as any).fetch;
      if (!fetchFn) {
        throw new Error("Fetch API is not available in current environment");
      }

      const response = await fetchFn(url, {
        method: options?.method || "GET",
        headers,
        body: options?.body ? JSON.stringify(options.body) : undefined,
      });

      const json = await response.json();
      if (!response.ok || !json.success) {
        return {
          success: false,
          error: json.error?.message || `HTTP ${response.status}: Request failed`,
        };
      }

      return {
        success: true,
        data: json.data,
        pagination: json.pagination,
      };
    } catch (err: any) {
      return {
        success: false,
        error: err.message || "Network communication error",
      };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 1. OVERVIEW & HEALTH APIS
  // ─────────────────────────────────────────────────────────────────────────

  public async getHealth() {
    return this.request("/api/health");
  }

  public async getHealthReady() {
    return this.request("/api/health/ready");
  }

  public async getBotStatus() {
    return this.request("/api/bot/status");
  }

  public async getProfitLoss(period: "24h" | "7d" | "30d" | "all" = "all") {
    return this.request(`/api/profit-loss?period=${period}`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 2. OPPORTUNITIES (ESTIMATED PROFITS)
  // ─────────────────────────────────────────────────────────────────────────

  public async getOpportunities(params?: {
    page?: number;
    limit?: number;
    minNetProfit?: number;
    status?: string;
  }) {
    const q = new URLSearchParams();
    if (params?.page) q.set("page", params.page.toString());
    if (params?.limit) q.set("limit", params.limit.toString());
    if (params?.minNetProfit) q.set("minNetProfit", params.minNetProfit.toString());
    if (params?.status) q.set("status", params.status);

    return this.request(`/api/opportunities?${q.toString()}`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 3. TRADES (REALIZED PROFITS)
  // ─────────────────────────────────────────────────────────────────────────

  public async getTrades(params?: {
    page?: number;
    limit?: number;
    status?: string;
    token?: string;
  }) {
    const q = new URLSearchParams();
    if (params?.page) q.set("page", params.page.toString());
    if (params?.limit) q.set("limit", params.limit.toString());
    if (params?.status) q.set("status", params.status);
    if (params?.token) q.set("token", params.token);

    return this.request(`/api/trades?${q.toString()}`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 4. TREASURY & REVENUE
  // ─────────────────────────────────────────────────────────────────────────

  public async getTreasuryBalances(chainId: SupportedChainId = 8453, token: string = "USDC") {
    return this.request(`/api/treasury/balances?chainId=${chainId}&token=${token}`);
  }

  public async getTreasuryLimits(token: string = "USDC") {
    return this.request(`/api/treasury/limits?token=${token}`);
  }

  public async getRevenueAllocations(page: number = 1, limit: number = 20) {
    return this.request(`/api/revenue/allocations?page=${page}&limit=${limit}`);
  }

  public async getRevenuePolicy() {
    return this.request("/api/revenue/policy");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 5. ALERTS & CONFIG
  // ─────────────────────────────────────────────────────────────────────────

  public async getAlerts(severity?: string, resolved?: boolean) {
    const q = new URLSearchParams();
    if (severity) q.set("severity", severity);
    if (resolved !== undefined) q.set("resolved", resolved.toString());
    return this.request(`/api/alerts?${q.toString()}`);
  }

  public async resolveAlert(alertId: string) {
    return this.request(`/api/alerts/${alertId}/resolve`, { method: "POST" });
  }

  public async getConfig() {
    return this.request("/api/config");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 6. BOT CONTROLS (OPERATOR / ADMIN)
  // ─────────────────────────────────────────────────────────────────────────

  public async startBot() {
    return this.request("/api/bot/start", { method: "POST" });
  }

  public async stopBot() {
    return this.request("/api/bot/stop", { method: "POST" });
  }

  public async pauseBot() {
    return this.request("/api/bot/pause", { method: "POST" });
  }

  public async emergencyStop() {
    return this.request("/api/bot/emergency-stop", { method: "POST" });
  }
}
