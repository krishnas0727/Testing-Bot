/**
 * @file TransactionBuilder.ts
 * @description Encodes exact on-chain calldata and builds execution transactions
 * matching ArbitrageExecutor.sol.
 */

import { ethers } from "ethers";
import {
  ArbitrageContractParams,
  BuildTransactionParams,
  BuiltTransaction
} from "./types";

export const ARBITRAGE_EXECUTOR_ABI = [
  "function executeArbitrage((address routerBuy, address routerSell, address tokenIn, address tokenOut, uint256 amountIn, uint256 minProfit, uint256 deadline) params) external returns (uint256 netProfit)",
  "function simulateArbitrage((address routerBuy, address routerSell, address tokenIn, address tokenOut, uint256 amountIn, uint256 minProfit, uint256 deadline) params) external view returns (bool profitable, uint256 expectedProfit, uint256 leg1Output, uint256 leg2Output)",
  "function paused() external view returns (bool)",
  "function isExecutor(address account) external view returns (bool)",
  "function routerWhitelist(address router) external view returns (bool)",
  "function tokenWhitelist(address token) external view returns (bool)",
  "error Unauthorized()",
  "error ContractPaused()",
  "error ExpiredDeadline()",
  "error RouterNotWhitelisted(address router)",
  "error TokenNotWhitelisted(address token)",
  "error IdenticalRouters()",
  "error IdenticalTokens()",
  "error InsufficientAmountIn()",
  "error UnprofitableArbitrage(uint256 finalAmount, uint256 requiredAmount)",
  "error TransferFailed()",
  "error ZeroAddress()"
];

export class TransactionBuilder {
  private static iface = new ethers.Interface(ARBITRAGE_EXECUTOR_ABI);

  /**
   * Encodes calldata for executeArbitrage
   */
  public static encodeExecuteArbitrage(params: ArbitrageContractParams): string {
    return this.iface.encodeFunctionData("executeArbitrage", [
      {
        routerBuy: params.routerBuy,
        routerSell: params.routerSell,
        tokenIn: params.tokenIn,
        tokenOut: params.tokenOut,
        amountIn: params.amountIn,
        minProfit: params.minProfit,
        deadline: params.deadline
      }
    ]);
  }

  /**
   * Encodes calldata for simulateArbitrage view call
   */
  public static encodeSimulateArbitrage(params: ArbitrageContractParams): string {
    return this.iface.encodeFunctionData("simulateArbitrage", [
      {
        routerBuy: params.routerBuy,
        routerSell: params.routerSell,
        tokenIn: params.tokenIn,
        tokenOut: params.tokenOut,
        amountIn: params.amountIn,
        minProfit: params.minProfit,
        deadline: params.deadline
      }
    ]);
  }

  /**
   * Builds the exact transaction object ready for simulation
   */
  public static buildTransaction(params: BuildTransactionParams): {
    builtTx: BuiltTransaction;
    contractParams: ArbitrageContractParams;
  } {
    const deadlineSeconds = params.deadlineSeconds || 120;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSeconds);

    const contractParams: ArbitrageContractParams = {
      routerBuy: params.routerBuyAddress,
      routerSell: params.routerSellAddress,
      tokenIn: params.tokenInAddress,
      tokenOut: params.tokenOutAddress,
      amountIn: params.amountInRaw,
      minProfit: params.minNetProfitRaw,
      deadline
    };

    const calldata = this.encodeExecuteArbitrage(contractParams);

    const builtTx: BuiltTransaction = {
      to: params.contractAddress,
      from: params.executorAddress,
      data: calldata,
      value: 0n,
      chainId: params.chainId,
      gasLimit: 350000n
    };

    return { builtTx, contractParams };
  }

  public static getInterface(): ethers.Interface {
    return this.iface;
  }
}
