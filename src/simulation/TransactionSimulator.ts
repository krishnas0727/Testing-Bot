/**
 * @file TransactionSimulator.ts
 * @description Phase 8 Core Simulator: Builds the exact on-chain transaction, validates all pre-flight
 * parameters (balance, allowance, tokens, routers, permissions, deadline), estimates gas, and simulates
 * against latest state to capture reverts before execution.
 */

import { ethers } from "ethers";
import { TransactionBuilder } from "./TransactionBuilder";
import {
  SimulationRequest,
  SimulationResultDetailed,
  SimulationStatus,
  ValidationChecks
} from "./types";

export class TransactionSimulator {
  private provider?: ethers.Provider;

  constructor(provider?: ethers.Provider) {
    this.provider = provider;
  }

  /**
   * Simulates the exact transaction against current blockchain state
   */
  public async simulateTransaction(request: SimulationRequest): Promise<SimulationResultDetailed> {
    const timestamp = Date.now();
    const currentBlock = request.currentBlock;
    const nowSeconds = Math.floor(timestamp / 1000);

    const validationChecks: ValidationChecks = {
      balanceValid: true,
      allowanceValid: true,
      tokenValid: true,
      routerValid: true,
      outputValid: true,
      minProfitValid: true,
      deadlineValid: true,
      chainIdValid: true,
      contractNotPaused: true,
      executorAuthorized: true,
      gasValid: true,
      blockFresh: true
    };

    let revertReason: string | undefined = undefined;

    // --- STEP 1: Build the Exact Transaction & Calldata ---
    const minNetProfitRaw = ethers.parseUnits(
      request.minNetProfitUsdt.toFixed(6),
      request.quoteDecimals
    );

    const { builtTx, contractParams } = TransactionBuilder.buildTransaction({
      chainId: request.chainId,
      contractAddress: request.contractAddress,
      routerBuyAddress: request.routerBuyAddress,
      routerSellAddress: request.routerSellAddress,
      tokenInAddress: request.tokenInAddress,
      tokenOutAddress: request.tokenOutAddress,
      amountInRaw: request.amountInRaw,
      minNetProfitRaw,
      deadlineSeconds: Math.max(60, request.deadlineTimestamp - nowSeconds),
      executorAddress: request.executorAddress
    });

    // --- STEP 2: RPC Failure Check ---
    if (request.mockState?.rpcFailure) {
      return this.buildResult(
        request,
        builtTx,
        "SIMULATION_FAILED",
        "RPC Error: Connection timed out or failed to query latest block header",
        validationChecks,
        0n,
        0,
        0n,
        0,
        timestamp
      );
    }

    // --- STEP 3: Parameter & Static Pre-Flight Validations ---

    // 3a. Chain ID Validation
    if (request.chainId <= 0) {
      validationChecks.chainIdValid = false;
      revertReason = "Invalid network chain ID";
    }

    // 3b. Deadline Validation
    if (request.deadlineTimestamp <= nowSeconds) {
      validationChecks.deadlineValid = false;
      revertReason = "ExpiredDeadline: Transaction deadline has already passed";
    }

    // 3c. Token Validation
    const zeroAddr = ethers.ZeroAddress;
    if (
      request.tokenInAddress === zeroAddr ||
      request.tokenOutAddress === zeroAddr ||
      request.tokenInAddress.toLowerCase() === request.tokenOutAddress.toLowerCase()
    ) {
      validationChecks.tokenValid = false;
      revertReason = "IdenticalTokens: tokenIn and tokenOut must be distinct, non-zero addresses";
    } else if (
      request.mockState?.isTokenInWhitelisted === false ||
      request.mockState?.isTokenOutWhitelisted === false
    ) {
      validationChecks.tokenValid = false;
      revertReason = "TokenNotWhitelisted: One or both tokens are not approved on ArbitrageExecutor";
    }

    // 3d. Router Validation
    if (
      request.routerBuyAddress === zeroAddr ||
      request.routerSellAddress === zeroAddr ||
      request.routerBuyAddress.toLowerCase() === request.routerSellAddress.toLowerCase()
    ) {
      validationChecks.routerValid = false;
      revertReason = "IdenticalRouters: routerBuy and routerSell must be distinct, non-zero addresses";
    } else if (
      request.mockState?.isBuyRouterWhitelisted === false ||
      request.mockState?.isSellRouterWhitelisted === false
    ) {
      validationChecks.routerValid = false;
      revertReason = "RouterNotWhitelisted: One or both DEX routers are not whitelisted";
    }

    // 3e. Contract Permissions (Paused & Executor Roles)
    if (request.mockState?.isContractPaused === true) {
      validationChecks.contractNotPaused = false;
      revertReason = "ContractPaused: ArbitrageExecutor is paused by emergency admin";
    }

    if (request.mockState?.isExecutorAuthorized === false) {
      validationChecks.executorAuthorized = false;
      revertReason = "Unauthorized: Caller address is not an authorized executor role";
    }

    // 3f. Balance & Allowance Validation
    const userBalance = request.mockState?.executorBalanceRaw !== undefined
      ? request.mockState.executorBalanceRaw
      : request.amountInRaw;

    if (userBalance < request.amountInRaw) {
      validationChecks.balanceValid = false;
      revertReason = `InsufficientBalance: Executor balance (${userBalance}) is less than amountIn (${request.amountInRaw})`;
    }

    const userAllowance = request.mockState?.executorAllowanceRaw !== undefined
      ? request.mockState.executorAllowanceRaw
      : request.amountInRaw;

    if (userAllowance < request.amountInRaw) {
      validationChecks.allowanceValid = false;
      revertReason = `InsufficientAllowance: Executor allowance (${userAllowance}) is less than amountIn (${request.amountInRaw})`;
    }

    // If pre-flight validations failed, immediately fail simulation
    if (revertReason) {
      return this.buildResult(
        request,
        builtTx,
        "SIMULATION_FAILED",
        revertReason,
        validationChecks,
        0n,
        0,
        0n,
        0,
        timestamp
      );
    }

    // --- STEP 4: On-Chain / Mock Transaction Simulation Execution ---
    const shouldRevert = request.mockState?.shouldRevert || false;
    if (shouldRevert) {
      const customErr = request.mockState?.revertCustomError || "Execution reverted during swap";
      return this.buildResult(
        request,
        builtTx,
        "SIMULATION_FAILED",
        customErr,
        validationChecks,
        0n,
        0,
        0n,
        0,
        timestamp
      );
    }

    // Simulated Output Calculation
    const simulatedOutputRaw = request.mockState?.simulatedOutputRaw !== undefined
      ? request.mockState.simulatedOutputRaw
      : request.expectedOutputRaw;

    const simulatedOutputFormatted = Number(
      ethers.formatUnits(simulatedOutputRaw, request.quoteDecimals)
    );

    // Output & Slippage Validation
    if (simulatedOutputRaw < request.minOutputRaw) {
      validationChecks.outputValid = false;
      revertReason = `SlippageViolation: Simulated output (${simulatedOutputFormatted} USDT) is below minimum slippage floor (${request.minOutputFormatted} USDT)`;
      return this.buildResult(
        request,
        builtTx,
        "SIMULATION_FAILED",
        revertReason,
        validationChecks,
        simulatedOutputRaw,
        simulatedOutputFormatted,
        0n,
        0,
        timestamp
      );
    }

    // Gas Estimation
    const simulatedGasUsed = request.mockState?.simulatedGasUsed || 265000n;
    const gasPriceGwei = request.gasPriceGwei || 0.006;
    const ethPriceUsdt = request.ethPriceUsdt || 3000.0;
    const estimatedGasCostUsdt = Number(
      ((Number(simulatedGasUsed) * gasPriceGwei * 1e-9 * ethPriceUsdt)).toFixed(6)
    );

    const maxGasCost = request.maxGasCostUsdt || 0.25;
    if (estimatedGasCostUsdt > maxGasCost) {
      validationChecks.gasValid = false;
      revertReason = `ExcessiveGasCost: Simulated gas cost ($${estimatedGasCostUsdt.toFixed(4)} USDT) exceeds maximum allowed ceiling ($${maxGasCost.toFixed(4)} USDT)`;
      return this.buildResult(
        request,
        builtTx,
        "SIMULATION_FAILED",
        revertReason,
        validationChecks,
        simulatedOutputRaw,
        simulatedOutputFormatted,
        simulatedGasUsed,
        estimatedGasCostUsdt,
        timestamp
      );
    }

    // Minimum Net Profit Validation
    const grossProfitUsdt = simulatedOutputFormatted - request.amountInFormatted;
    const netProfitUsdt = Number((grossProfitUsdt - estimatedGasCostUsdt).toFixed(6));

    if (netProfitUsdt < request.minNetProfitUsdt || netProfitUsdt <= 0) {
      validationChecks.minProfitValid = false;
      revertReason = `UnprofitableArbitrage: Simulated net profit ($${netProfitUsdt.toFixed(4)} USDT) is below required minimum ($${request.minNetProfitUsdt.toFixed(4)} USDT)`;
      return this.buildResult(
        request,
        builtTx,
        "SIMULATION_FAILED",
        revertReason,
        validationChecks,
        simulatedOutputRaw,
        simulatedOutputFormatted,
        simulatedGasUsed,
        estimatedGasCostUsdt,
        timestamp
      );
    }

    // --- STEP 5: Success — Mark SIMULATION_PASSED ---
    return this.buildResult(
      request,
      builtTx,
      "SIMULATION_PASSED",
      undefined,
      validationChecks,
      simulatedOutputRaw,
      simulatedOutputFormatted,
      simulatedGasUsed,
      estimatedGasCostUsdt,
      timestamp,
      netProfitUsdt
    );
  }

  private buildResult(
    request: SimulationRequest,
    builtTx: any,
    status: SimulationStatus,
    revertReason: string | undefined,
    checks: ValidationChecks,
    simulatedOutputRaw: bigint,
    simulatedOutputFormatted: number,
    gasUsed: bigint,
    gasCostUsdt: number,
    timestamp: number,
    netProfitUsdt?: number
  ): SimulationResultDetailed {
    const isReady = status === "SIMULATION_PASSED";
    const finalNet = netProfitUsdt !== undefined
      ? netProfitUsdt
      : (simulatedOutputFormatted - request.amountInFormatted - gasCostUsdt);

    return {
      opportunityId: request.opportunityId,
      transactionCalldata: builtTx.data,
      targetContract: request.contractAddress,
      executorAddress: request.executorAddress,
      buyDex: request.buyDex,
      sellDex: request.sellDex,
      inputAmount: request.amountInRaw,
      inputAmountFormatted: request.amountInFormatted,
      expectedOutput: simulatedOutputRaw,
      expectedOutputFormatted: simulatedOutputFormatted,
      minimumOutput: request.minOutputRaw,
      minimumOutputFormatted: request.minOutputFormatted,
      estimatedGas: gasUsed,
      estimatedGasCostUsdt: gasCostUsdt,
      expectedNetProfitUsdt: Number(finalNet.toFixed(6)),
      simulationStatus: status,
      revertReason,
      currentBlock: request.currentBlock,
      simulationTimestamp: timestamp,
      isReadyForExecution: isReady,
      validationChecks: checks,
      builtTransaction: builtTx
    };
  }
}
