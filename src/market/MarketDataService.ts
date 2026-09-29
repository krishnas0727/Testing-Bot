/**
 * @file MarketDataService.ts
 * @description Phase 3 Core Service: Collects, normalizes, validates, caches, and serves DEX pool market data
 */

import { IDEXAdapter } from "./adapters/IDEXAdapter";
import { UniswapV2Adapter } from "./adapters/UniswapV2Adapter";
import { DataNormalizer } from "./normalizer/DataNormalizer";
import { PoolDataValidator } from "./validator/PoolDataValidator";
import { PoolStateCache } from "./cache/PoolStateCache";
import {
  MarketDataQuery,
  MultiDEXPoolSnapshot,
  NormalizedPoolState,
  RawPoolData
} from "./types";
import { SupportedChainId } from "../types";

export interface IMarketDataService {
  registerAdapter(adapter: IDEXAdapter): void;
  getPoolState(chainId: SupportedChainId, dexName: string, pairSymbol: string): Promise<NormalizedPoolState | null>;
  getMultiDEXSnapshot(query: MarketDataQuery): Promise<MultiDEXPoolSnapshot>;
  updatePool(raw: RawPoolData, baseSymbol: string, quoteSymbol: string): NormalizedPoolState;
  getCacheStats(): { size: number; hits: number; misses: number; hitRate: number };
}

export class MarketDataService implements IMarketDataService {
  private adapters: Map<string, IDEXAdapter> = new Map();
  private cache: PoolStateCache;
  private loggerEnabled: boolean = true;

  constructor(cacheTtlMs: number = 60000, enableLogging: boolean = true) {
    this.cache = new PoolStateCache(cacheTtlMs);
    this.loggerEnabled = enableLogging;

    // Register default V2 adapters
    this.registerAdapter(new UniswapV2Adapter("Uniswap_V2", "UNISWAP_V2", 30));
    this.registerAdapter(new UniswapV2Adapter("SushiSwap_V2", "SUSHISWAP_V2", 30));
    this.registerAdapter(new UniswapV2Adapter("QuickSwap_V2", "QUICKSWAP_V2", 30));
  }

  private log(level: "INFO" | "WARN" | "ERROR", message: string, meta?: any): void {
    if (!this.loggerEnabled) return;
    const timestamp = new Date().toISOString();
    const metaStr = meta ? ` | ${JSON.stringify(meta)}` : "";
    console.log(`[${timestamp}] [MarketDataService] [${level}] ${message}${metaStr}`);
  }

  public registerAdapter(adapter: IDEXAdapter): void {
    this.adapters.set(adapter.dexName, adapter);
    this.log("INFO", `Registered DEX adapter: ${adapter.dexName} (${adapter.protocol})`);
  }

  public getAdapter(dexName: string): IDEXAdapter | undefined {
    return this.adapters.get(dexName);
  }

  /**
   * Processes raw pool data, validates it, and commits to cache
   */
  public updatePool(raw: RawPoolData, baseSymbol: string, quoteSymbol: string): NormalizedPoolState {
    // Step 1: Normalize
    const normalized = DataNormalizer.normalize(raw, baseSymbol, quoteSymbol);

    // Step 2: Validate
    const validation = PoolDataValidator.validate(normalized);
    normalized.isValid = validation.isValid;

    if (!validation.isValid) {
      normalized.validationError = validation.errors.join("; ");
      this.log("WARN", `Pool validation failed for ${normalized.id}: ${normalized.validationError}`);
    }

    if (validation.warnings.length > 0) {
      this.log("INFO", `Pool warnings for ${normalized.id}: ${validation.warnings.join("; ")}`);
    }

    // Step 3: Cache (even if warnings present, to provide fallback state)
    this.cache.set(normalized);
    return normalized;
  }

  /**
   * Retrieves single pool state, utilizing cache or fetching via adapter on miss
   */
  public async getPoolState(
    chainId: SupportedChainId,
    dexName: string,
    pairSymbol: string
  ): Promise<NormalizedPoolState | null> {
    // 1. Check in-memory cache
    const cached = this.cache.get(chainId, dexName, pairSymbol);
    if (cached && cached.freshness === "FRESH") {
      return cached;
    }

    // 2. Fetch fresh on miss or stale
    const adapter = this.adapters.get(dexName);
    if (!adapter) {
      this.log("WARN", `No adapter registered for DEX: ${dexName}`);
      return cached || null;
    }

    const [base, quote] = pairSymbol.split("/");
    try {
      const raw = await adapter.fetchPoolData(
        chainId,
        "0x0000000000000000000000000000000000000001",
        "0x0000000000000000000000000000000000000002",
        base || "WETH",
        quote || "USDT",
        18,
        6
      );
      return this.updatePool(raw, base || "WETH", quote || "USDT");
    } catch (err: any) {
      this.log("ERROR", `Failed to fetch pool data for ${dexName} (${pairSymbol}): ${err.message}`);
      // Graceful fallback to cached (even if stale) to prevent system crash
      if (cached) {
        this.log("WARN", `Serving stale cached data for ${dexName} (${pairSymbol}) due to RPC failure`);
        return cached;
      }
      return null;
    }
  }

  /**
   * Compares pools across all DEXs for a token pair and returns normalized snapshot with spread
   */
  public async getMultiDEXSnapshot(query: MarketDataQuery): Promise<MultiDEXPoolSnapshot> {
    const pairSymbol = `${query.baseSymbol.toUpperCase()}/${query.quoteSymbol.toUpperCase()}`;
    const pools: Record<string, NormalizedPoolState> = {};
    const maxAge = query.maxAgeMs || 10000;

    for (const [dexName, adapter] of this.adapters.entries()) {
      if (query.excludeDEXs && query.excludeDEXs.includes(dexName)) {
        continue;
      }

      // Check cache first
      let pool = this.cache.get(query.chainId, dexName, pairSymbol);

      // If not cached or older than maxAge, fetch fresh
      if (!pool || pool.ageMs > maxAge) {
        try {
          const raw = await adapter.fetchPoolData(
            query.chainId,
            "0x0000000000000000000000000000000000000001",
            "0x0000000000000000000000000000000000000002",
            query.baseSymbol,
            query.quoteSymbol,
            18,
            6
          );
          pool = this.updatePool(raw, query.baseSymbol, query.quoteSymbol);
        } catch (err: any) {
          this.log("WARN", `Snapshot fetch error for ${dexName}: ${err.message}`);
        }
      }

      if (pool && pool.isValid) {
        pools[dexName] = pool;
      }
    }

    // Determine Best Bid and Best Ask
    let highestBid = { dex: "", price: 0 };
    let lowestAsk = { dex: "", price: Number.MAX_VALUE };
    let allFresh = true;

    for (const [dex, p] of Object.entries(pools)) {
      if (p.freshness !== "FRESH") allFresh = false;

      if (p.spotPrice > highestBid.price) {
        highestBid = { dex, price: p.spotPrice };
      }
      if (p.spotPrice < lowestAsk.price && p.spotPrice > 0) {
        lowestAsk = { dex, price: p.spotPrice };
      }
    }

    if (lowestAsk.price === Number.MAX_VALUE) {
      lowestAsk.price = 0;
    }

    const spreadUsd = (highestBid.price > 0 && lowestAsk.price > 0 && highestBid.dex !== lowestAsk.dex)
      ? Math.max(0, highestBid.price - lowestAsk.price)
      : 0;

    const spreadPct = (lowestAsk.price > 0 && spreadUsd > 0)
      ? (spreadUsd / lowestAsk.price) * 100
      : 0;

    const hasExecutableArbitrage = spreadPct > 0.60; // 0.60% covers 2x 0.30% swap fees

    return {
      pairSymbol,
      chainId: query.chainId,
      pools,
      highestBid,
      lowestAsk,
      spreadUsd: Number(spreadUsd.toFixed(4)),
      spreadPct: Number(spreadPct.toFixed(4)),
      hasExecutableArbitrage,
      timestamp: Date.now(),
      allFresh
    };
  }

  public getCacheStats() {
    return this.cache.getStats();
  }
}
