/**
 * @file IDEXAdapter.ts
 * @description Standard interface for DEX protocol adapters
 */

import { DEXProtocol, RawPoolData } from "../types";
import { SupportedChainId } from "../../types";

export interface IDEXAdapter {
  readonly dexName: string;
  readonly protocol: DEXProtocol;

  /**
   * Fetches raw pool state for a specific token pair on a blockchain network
   */
  fetchPoolData(
    chainId: SupportedChainId,
    tokenAAddress: string,
    tokenBAddress: string,
    tokenASymbol: string,
    tokenBSymbol: string,
    tokenADecimals: number,
    tokenBDecimals: number,
    poolAddress?: string
  ): Promise<RawPoolData>;

  /**
   * Derives or calculates deterministic pool/pair address from token addresses
   */
  getPoolAddress(
    chainId: SupportedChainId,
    tokenAAddress: string,
    tokenBAddress: string
  ): Promise<string>;
}
