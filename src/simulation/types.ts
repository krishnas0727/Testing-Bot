/**
 * @file types.ts
 * @description Types and schemas for Phase 8: Transaction Simulation Engine
 */

import { SupportedChainId } from "../types";

export type SimulationStatus = "SIMULATION_PASSED" | "SIMULATION_FAILED";

export interface ArbitrageContractParams {
  routerBuy: string;
  routerSell: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  minProfit: bigint;
  deadline: bigint;
}

export interface BuildTransactionParams {
  chainId: SupportedChainId;
  contractAddress: string;
  routerBuyAddress: string;
  routerSellAddress: string;
  tokenInAddress: string;
  tokenOutAddress: string;
  amountInRaw: bigint;
  minNetProfitRaw: bigint;
  deadlineSeconds?: number;
  executorAddress: string;
}

export interface BuiltTransaction {
  to: string;
  from: string;
  data: string;
  value: bigint;
  chainId: SupportedChainId;
  gasLimit?: bigint;
}

export interface ValidationChecks {
  balanceValid: boolean;
  allowanceValid: boolean;
  tokenValid: boolean;
  routerValid: boolean;
  outputValid: boolean;
  minProfitValid: boolean;
  deadlineValid: boolean;
  chainIdValid: boolean;
  contractNotPaused: boolean;
  executorAuthorized: boolean;
  gasValid: boolean;
  blockFresh: boolean;
}

export interface SimulationRequest {
  opportunityId: string;
  chainId: SupportedChainId;
  contractAddress: string;
  executorAddress: string;
  buyDex: string;
  sellDex: string;
  routerBuyAddress: string;
  routerSellAddress: string;
  tokenInAddress: string;
  tokenOutAddress: string;
  tokenInSymbol: string;
  tokenOutSymbol: string;
  tokenInDecimals: number;
  tokenOutDecimals: number;
  amountInRaw: bigint;
  amountInFormatted: number;
  expectedOutputRaw: bigint;
  expectedOutputFormatted: number;
  minOutputRaw: bigint;
  minOutputFormatted: number;
  minNetProfitUsdt: number;
  deadlineTimestamp: number;
  currentBlock: number;
  maxGasCostUsdt?: number;
  ethPriceUsdt?: number;
  gasPriceGwei?: number;

  // On-chain or Mock state overrides for simulation testing
  mockState?: {
    executorBalanceRaw?: bigint;
    executorAllowanceRaw?: bigint;
    isContractPaused?: boolean;
    isExecutorAuthorized?: boolean;
    isBuyRouterWhitelisted?: boolean;
    isSellRouterWhitelisted?: boolean;
    isTokenInWhitelisted?: boolean;
    isTokenOutWhitelisted?: boolean;
    simulatedOutputRaw?: bigint;
    shouldRevert?: boolean;
    revertCustomError?: string;
    simulatedGasUsed?: bigint;
    rpcFailure?: boolean;
  };
}

export interface SimulationResultDetailed {
  opportunityId: string;
  transactionCalldata: string;
  targetContract: string;
  executorAddress: string;
  buyDex: string;
  sellDex: string;
  inputAmount: bigint;
  inputAmountFormatted: number;
  expectedOutput: bigint;
  expectedOutputFormatted: number;
  minimumOutput: bigint;
  minimumOutputFormatted: number;
  estimatedGas: bigint;
  estimatedGasCostUsdt: number;
  expectedNetProfitUsdt: number;
  simulationStatus: SimulationStatus;
  revertReason?: string;
  currentBlock: number;
  simulationTimestamp: number;
  isReadyForExecution: boolean; // True ONLY when simulationStatus === "SIMULATION_PASSED"
  validationChecks: ValidationChecks;
  builtTransaction: BuiltTransaction;
}
