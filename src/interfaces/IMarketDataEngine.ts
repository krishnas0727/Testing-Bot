/**
 * @file IMarketDataEngine.ts
 * @description Phase 2 & 3 Interface: Market Data Ingestion & Pool Reserves Synchronization
 */

import { PoolReserves, SupportedChainId, TokenInfo } from "../types";

export interface IMarketDataEngine {
  /**
   * Initializes WebSocket or HTTP RPC listeners for block and reserve updates
   */
  start(chainId: SupportedChainId): Promise<void>;

  /**
   * Stops listeners and flushes subscriptions
   */
  stop(): Promise<void>;

  /**
   * Fetches latest pool reserves directly from on-chain pair contracts
   */
  getReserves(dex: string, tokenA: string, tokenB: string): Promise<PoolReserves>;

  /**
   * Returns token decimals, symbol, and metadata
   */
  getTokenInfo(tokenAddress: string): Promise<TokenInfo>;

  /**
   * Returns current gas price in Gwei and base fee
   */
  getGasPrice(chainId: SupportedChainId): Promise<{ gasPriceGwei: number; baseFeeGwei: number }>;
}
