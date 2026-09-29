/**
 * @file types.ts
 * @description Phase 13: Backend/API Type Definitions
 *
 * Defines request/response models, pagination, query filters, authentication roles,
 * API controllers, and data contracts across all core backend services.
 */

import { SupportedChainId, TradingMode } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// AUTHENTICATION & ROLE-BASED ACCESS CONTROL
// ─────────────────────────────────────────────────────────────────────────────

export type UserRole = "ADMIN" | "OPERATOR" | "VIEWER";

export interface AuthUser {
  id: string;
  username: string;
  role: UserRole;
  apiKey?: string;
}

export interface ApiTokenPayload {
  userId: string;
  username: string;
  role: UserRole;
  issuedAt: number;
  expiresAt: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP FRAMEWORK TYPES
// ─────────────────────────────────────────────────────────────────────────────

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";

export interface ApiRequest {
  method: HttpMethod;
  url: string;
  pathname: string;
  params: Record<string, string>;
  query: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  body: any;
  user?: AuthUser;
  requestId: string;
  clientIp: string;
  timestamp: number;
}

export interface ApiResponseData<T = any> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: any;
  };
  pagination?: PaginationMeta;
  requestId: string;
  timestamp: number;
}

export type MiddlewareHandler = (
  req: ApiRequest,
  res: ApiResponseWriter,
  next: () => Promise<void>
) => Promise<void>;

export interface ApiResponseWriter {
  status(code: number): ApiResponseWriter;
  header(key: string, value: string): ApiResponseWriter;
  json<T>(data: ApiResponseData<T>): void;
  send(content: string, contentType?: string): void;
  hasSent(): boolean;
}

export type RouteHandler = (req: ApiRequest, res: ApiResponseWriter) => Promise<void>;

// ─────────────────────────────────────────────────────────────────────────────
// PAGINATION & FILTERING
// ─────────────────────────────────────────────────────────────────────────────

export interface PaginationParams {
  page: number;
  limit: number;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
}

export interface PaginationMeta {
  page: number;
  limit: number;
  totalItems: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export interface PaginatedResult<T> {
  items: T[];
  pagination: PaginationMeta;
}

// ─────────────────────────────────────────────────────────────────────────────
// DOMAIN ENTITIES FOR API
// ─────────────────────────────────────────────────────────────────────────────

export interface StoredOpportunity {
  id: string;
  chainId: SupportedChainId;
  tokenIn: string;
  tokenOut: string;
  buyDex: string;
  sellDex: string;
  amountInFormatted: number;
  expectedGrossProfitUsdt: number;
  netProfitUsdt: number;
  roiPct: number;
  priceImpactPct: number;
  status: "ACTIVE" | "EXPIRED" | "EXECUTED" | "FILTERED";
  timestamp: number;
}

export type ExecutionMode = "USER_SIGNED" | "AUTOMATED";

export interface StoredTrade {
  id: string;
  tradeId: string;
  txHash: string;
  chainId: SupportedChainId;
  tokenIn: string;
  tokenOut: string;
  amountIn: number;
  buyDex: string;
  sellDex: string;
  grossProfitUsdt: number;
  netProfitUsdt: number;
  roiPct: number;
  gasCostUsdt: number;
  status: "CONFIRMED" | "REVERTED" | "PENDING";
  executionTimeMs: number;
  timestamp: number;
  executionMode?: ExecutionMode;
  executorType?: "USER_WALLET" | "DEDICATED_EXECUTOR";
  signerAddress?: string;
}

export interface StoredTransaction {
  txHash: string;
  chainId: SupportedChainId;
  blockNumber: number;
  from: string;
  to: string;
  gasUsed: number;
  effectiveGasPriceGwei: number;
  status: "SUCCESS" | "REVERTED" | "PENDING";
  errorMessage?: string;
  syncedAt: number;
  timestamp: number;
}

export interface ProfitLossSummary {
  period: "24h" | "7d" | "30d" | "all";
  totalTrades: number;
  successfulTrades: number;
  failedTrades: number;
  winRatePct: number;
  grossProfitUsdt: number;
  totalGasCostUsdt: number;
  netProfitUsdt: number;
  averageRoiPct: number;
  largestProfitUsdt: number;
  largestLossUsdt: number;
}

export interface SystemAlert {
  id: string;
  severity: "INFO" | "WARNING" | "CRITICAL";
  source: "ENGINE" | "RISK" | "BLOCKCHAIN" | "TREASURY" | "API";
  title: string;
  message: string;
  metadata?: Record<string, any>;
  resolved: boolean;
  timestamp: number;
}

export interface BotStatusState {
  status: "RUNNING" | "STOPPED" | "PAUSED" | "EMERGENCY_STOPPED";
  tradingMode: TradingMode;
  autoTradeEnabled: boolean;
  activeChainId: SupportedChainId;
  uptimeSeconds: number;
  circuitBreakerTripped: boolean;
  activeOpportunitiesCount: number;
  totalTradesExecuted: number;
  lastHeartbeat: number;
}

export interface UserTreasuryBalance {
  userAddress: string;
  token: string;
  deposited: number;
  realizedProfit: number;
  pending: number;
  withdrawable: number;
  totalWithdrawn: number;
  lastSyncedAt: number;
  source: "ON_CHAIN" | "SYNCED_LEDGER";
}

export interface ProfitSettlementRequest {
  tradeId: string;
  txHash: string;
  chainId: SupportedChainId;
  userAddress: string;
  token: string;
  grossProfitUsdt: number;
  dexFeesUsdt: number;
  gasCostUsdt: number;
  slippageLossUsdt?: number;
  priceImpactUsdt?: number;
  confirmedOnChain: boolean;
}

export interface UserWithdrawalRequest {
  userAddress: string;
  token: string;
  amount: number;
}

