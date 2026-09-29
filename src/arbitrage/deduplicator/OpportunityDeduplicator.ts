/**
 * @file OpportunityDeduplicator.ts
 * @description Prevents redundant opportunity emissions within a configurable sliding time window
 */

import { SupportedChainId } from "../../types";

export class OpportunityDeduplicator {
  private cache: Map<string, { timestamp: number; spreadPct: number }> = new Map();
  private windowMs: number;

  constructor(windowMs: number = 5000) {
    this.windowMs = windowMs;
  }

  /**
   * Generates deterministic fingerprint key for an opportunity
   */
  public static makeKey(
    chainId: SupportedChainId,
    pair: string,
    buyDex: string,
    sellDex: string,
    tradeSize: number
  ): string {
    return `${chainId}:${pair.toUpperCase()}:${buyDex.toUpperCase()}-${sellDex.toUpperCase()}:${tradeSize.toFixed(2)}`;
  }

  /**
   * Checks if an opportunity is duplicate within the sliding time window
   */
  public isDuplicate(
    chainId: SupportedChainId,
    pair: string,
    buyDex: string,
    sellDex: string,
    tradeSize: number,
    spreadPct: number
  ): boolean {
    const key = OpportunityDeduplicator.makeKey(chainId, pair, buyDex, sellDex, tradeSize);
    const existing = this.cache.get(key);
    const now = Date.now();

    if (!existing) {
      this.cache.set(key, { timestamp: now, spreadPct });
      return false;
    }

    // If within deduplication window
    if (now - existing.timestamp < this.windowMs) {
      // If spread has significantly widened (> 25% change), treat as fresh update
      if (Math.abs(spreadPct - existing.spreadPct) > (existing.spreadPct * 0.25)) {
        this.cache.set(key, { timestamp: now, spreadPct });
        return false;
      }
      return true;
    }

    // Window elapsed, update cache
    this.cache.set(key, { timestamp: now, spreadPct });
    return false;
  }

  /**
   * Prunes records older than deduplication window
   */
  public prune(): number {
    const now = Date.now();
    let pruned = 0;

    for (const [key, item] of this.cache.entries()) {
      if (now - item.timestamp > this.windowMs) {
        this.cache.delete(key);
        pruned++;
      }
    }

    return pruned;
  }

  public clear(): void {
    this.cache.clear();
  }

  public size(): number {
    return this.cache.size;
  }
}
