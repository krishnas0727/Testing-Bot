/**
 * @file index.ts
 * @description Core TypeScript type definitions for DEX Arbitrage & Treasury System
 */

export type SupportedChainId = 8453 | 84532 | 137 | 42161 | 1 | 11155111;

export type TradingMode = "MOCK" | "TESTNET" | "LIVE";

export interface ChainConfig {
  chainId: SupportedChainId;
  name: string;
  shortName: string;
  rpcUrl: string;
  explorerUrl: string;
  nativeCurrency: {
    name: string;
    symbol: string;
    decimals: number;
  };
  contracts?: {
    arbitrageExecutor?: string;
    treasury?: string;
  };
  dexRouters: Record<string, string>;
  isTestnet: boolean;
}

export interface TokenInfo {
  address: string;
  symbol: string;
  decimals: number;
  name?: string;
  chainId: SupportedChainId;
}

export interface PoolReserves {
  pairAddress: string;
  dex: string;
  token0: string;
  token1: string;
  reserve0: bigint;
  reserve1: bigint;
  blockTimestampLast: number;
  lastUpdated: number;
}

export interface RouteLeg {
  dex: string;
  routerAddress: string;
  tokenIn: string;
  tokenOut: string;
  expectedAmountOut: bigint;
  priceImpactPct: number;
}

export interface ArbitrageOpportunity {
  id: string;
  chainId: SupportedChainId;
  tokenIn: string;
  tokenIntermediate: string;
  amountIn: bigint;
  amountInFormatted: number;
  buyDex: string;
  sellDex: string;
  expectedGrossReturn: bigint;
  expectedGrossReturnFormatted: number;
  grossProfitUsdt: number;
  netProfitUsdt: number;
  roiPct: number;
  priceImpactPct: number;
  estimatedGasUnits: bigint;
  estimatedGasCostUsdt: number;
  isProfitable: boolean;
  timestamp: number;
}

export interface RiskEvaluationResult {
  passed: boolean;
  skipReason?: string;
  gatePassedCount: number;
  checks: {
    whitelistPassed: boolean;
    profitThresholdPassed: boolean;
    slippagePassed: boolean;
    priceImpactPassed: boolean;
    gasCeilingPassed: boolean;
    circuitBreakerPassed: boolean;
    emergencyStopPassed: boolean;
  };
}

export interface SimulationResult {
  success: boolean;
  status: "SIMULATION_SUCCESS" | "SIMULATION_REVERTED" | "SIMULATION_ERROR";
  simulatedGasUsed: bigint;
  grossReturn: bigint;
  netProfit: bigint;
  expectedGrossFormatted: number;
  expectedNetFormatted: number;
  revertReason?: string;
  executionTrace?: string;
}

export interface ExecutionReceipt {
  success: boolean;
  status: "CONFIRMED" | "REVERTED" | "SKIPPED" | "FAILED";
  txHash?: string;
  blockNumber?: number;
  gasUsed?: bigint;
  effectiveGasPrice?: bigint;
  actualGrossProfit?: number;
  actualNetProfit?: number;
  actualRoiPct?: number;
  errorMessage?: string;
  timestamp: number;
}

export interface RevenueAllocation {
  id?: number;
  tradeId?: number;
  txHash: string;
  chainId: SupportedChainId;
  token: string;
  netProfit: number;
  tradingCapital: number;   // 60%
  reserve: number;          // 20%
  revenue: number;          // 20%
  createdAt: string;
}

export interface TreasuryStatus {
  totalProfitUsdt: number;
  totalWithdrawnUsdt: number;
  withdrawableUsdt: number;
  buckets: {
    tradingCapital: number;
    reserve: number;
    revenue: number;
    totalAllocated: number;
  };
}
