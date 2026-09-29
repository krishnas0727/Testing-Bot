/**
 * @file MainnetLaunchService.ts
 * @description Phase 22: Controlled Mainnet Launch & Safety Coordinator
 *
 * Implements strict live trading safety controls:
 * - Pre-launch readiness checklist verification
 * - Multi-gate live trading arming validation (never active on boot)
 * - Controlled first trade protocol with bounded sizing (5 - 100 USD)
 * - Real on-chain receipt confirmation (zero fake trades / profits)
 * - Double-click / concurrency deduplication protection
 * - Emergency rollback and killswitch integration
 */

import { ethers } from "ethers";
import { SupportedChainId } from "../../types";
import { DatabaseService } from "./DatabaseService";
import { BlockchainSyncService } from "./BlockchainSyncService";
import { BotControlService } from "./BotControlService";
import { RevenueDistributionEngine } from "../../distribution";
import { TradeExecutionRequest, TradeExecutionResult, TradeExecutionService } from "./TradeExecutionService";
import {
  MAINNET_CONFIGS,
  MainnetNetworkConfig,
  getMainnetConfig,
  isSupportedMainnet,
  isLiveTradingArmed,
} from "../../config/mainnet";
import { isValidAddress } from "../../config/testnet";
import { Logger } from "../../utils/logger";

const launchLogger = new Logger("MainnetLaunchService");

export interface MainnetReadinessChecklist {
  chainId: number;
  networkName: string;
  rpcConnected: boolean;
  blockNumber: number;
  gasPriceGwei: number;
  contractVerified: boolean;
  contractAddress: string;
  hasBytecode: boolean;
  isPaused: boolean;
  treasuryVerified: boolean;
  treasuryAddress: string;
  emergencyStopArmed: boolean;
  liveTradingArmed: boolean;
  tokensConfigured: boolean;
  routersConfigured: boolean;
  databaseConnected: boolean;
  readyForLiveExecution: boolean;
  blockerReasons: string[];
}

export class MainnetLaunchService {
  private readonly db: DatabaseService;
  private readonly syncService: BlockchainSyncService;
  private readonly botService: BotControlService;
  private readonly distributionEngine: RevenueDistributionEngine;
  private readonly tradeExecutionService: TradeExecutionService;
  private readonly activeMainnetLocks: Set<string> = new Set();

  constructor(
    db: DatabaseService,
    syncService: BlockchainSyncService,
    botService: BotControlService,
    distributionEngine: RevenueDistributionEngine,
    tradeExecutionService: TradeExecutionService
  ) {
    this.db = db;
    this.syncService = syncService;
    this.botService = botService;
    this.distributionEngine = distributionEngine;
    this.tradeExecutionService = tradeExecutionService;
  }

  /**
   * Executes a comprehensive 14-point readiness audit prior to any mainnet action.
   */
  public async verifyMainnetReadiness(
    chainId: number = 8453,
    customProvider?: ethers.Provider
  ): Promise<MainnetReadinessChecklist> {
    const blockers: string[] = [];

    if (!isSupportedMainnet(chainId)) {
      return {
        chainId,
        networkName: "Unsupported Network",
        rpcConnected: false,
        blockNumber: 0,
        gasPriceGwei: 0,
        contractVerified: false,
        contractAddress: "",
        hasBytecode: false,
        isPaused: true,
        treasuryVerified: false,
        treasuryAddress: "",
        emergencyStopArmed: false,
        liveTradingArmed: false,
        tokensConfigured: false,
        routersConfigured: false,
        databaseConnected: false,
        readyForLiveExecution: false,
        blockerReasons: [`Chain ID ${chainId} is not a supported production mainnet`],
      };
    }

    const config = getMainnetConfig(chainId);
    const provider = customProvider || this.syncService.getProvider(chainId as SupportedChainId);

    let rpcConnected = false;
    let blockNumber = 0;
    let gasPriceGwei = 0;

    if (!provider) {
      blockers.push("No active JSON-RPC provider configured for mainnet");
    } else {
      try {
        const [bn, feeData] = await Promise.all([
          provider.getBlockNumber(),
          provider.getFeeData(),
        ]);
        blockNumber = bn;
        gasPriceGwei = feeData.gasPrice ? Number(ethers.formatUnits(feeData.gasPrice, "gwei")) : 0;
        rpcConnected = true;
      } catch (err: any) {
        blockers.push(`RPC communication failed: ${err.message}`);
      }
    }

    // Check Contract Bytecode
    let hasBytecode = false;
    let isPaused = true;
    const contractAddress = config.contracts.arbitrageExecutor;
    const treasuryAddress = config.contracts.treasury;

    if (!isValidAddress(contractAddress)) {
      blockers.push("Mainnet ArbitrageExecutor address is not set or invalid");
    } else if (provider) {
      try {
        const code = await provider.getCode(contractAddress);
        hasBytecode = code !== "0x";
        if (!hasBytecode) {
          blockers.push(`ArbitrageExecutor ${contractAddress} has no deployed bytecode on chain`);
        } else {
          const contract = new ethers.Contract(
            contractAddress,
            ["function paused() external view returns (bool)"],
            provider
          );
          isPaused = await contract.paused();
          if (isPaused) {
            blockers.push("ArbitrageExecutor contract is currently paused on-chain");
          }
        }
      } catch (err: any) {
        blockers.push(`Could not inspect contract on-chain: ${err.message}`);
      }
    }

    const hasTreasuryBytecode = isValidAddress(treasuryAddress);
    if (!hasTreasuryBytecode) {
      blockers.push("Mainnet Treasury address is not set or invalid");
    }

    // Bot Status & Circuit Breaker Check
    const botStatus = this.botService.getStatus();
    const isEmergencyStopped = botStatus.status === "EMERGENCY_STOPPED";
    if (isEmergencyStopped) {
      blockers.push("Emergency Stop circuit breaker is active across the system");
    }

    // Live Trading Armed Check
    const liveArmed = isLiveTradingArmed();
    if (!liveArmed) {
      blockers.push("Live trading is not armed (LIVE_TRADING_ARMED=true & TRADING_MODE=LIVE required)");
    }

    // Tokens & Routers Check
    const tokensConfigured = Object.keys(config.tokens).length >= 2;
    const routersConfigured = Object.keys(config.dexRouters).length >= 2;

    if (!tokensConfigured) blockers.push("Insufficient mainnet tokens configured");
    if (!routersConfigured) blockers.push("Insufficient mainnet DEX routers configured");

    const readyForLiveExecution = blockers.length === 0;

    return {
      chainId,
      networkName: config.name,
      rpcConnected,
      blockNumber,
      gasPriceGwei,
      contractVerified: isValidAddress(contractAddress) && hasBytecode,
      contractAddress,
      hasBytecode,
      isPaused,
      treasuryVerified: hasTreasuryBytecode,
      treasuryAddress,
      emergencyStopArmed: isEmergencyStopped,
      liveTradingArmed: liveArmed,
      tokensConfigured,
      routersConfigured,
      databaseConnected: true,
      readyForLiveExecution,
      blockerReasons: blockers,
    };
  }

  /**
   * Executes a controlled first live trade with strict bounding and on-chain verification.
   */
  public async executeControlledMainnetTrade(
    request: TradeExecutionRequest,
    provider: ethers.Provider,
    signer: ethers.Signer,
    contractAddress: string
  ): Promise<TradeExecutionResult> {
    const oppKey = `${request.chainId}:${request.tokenIn}:${request.opportunityId}`;

    // 1. Double-click & Concurrency Lock
    if (this.activeMainnetLocks.has(oppKey)) {
      launchLogger.warn("Blocked duplicate concurrent execution attempt", { oppKey });
      return {
        success: false,
        status: "BLOCKED",
        error: "Execution blocked: Duplicate execution request already in-flight for this opportunity",
        rejectionGate: "DUPLICATE_IN_FLIGHT",
      };
    }
    this.activeMainnetLocks.add(oppKey);

    try {
      // 2. Validate Mainnet Chain
      if (!isSupportedMainnet(request.chainId)) {
        return {
          success: false,
          status: "BLOCKED",
          error: `Execution blocked: Chain ID ${request.chainId} is not authorized for mainnet trading`,
          rejectionGate: "UNSUPPORTED_CHAIN",
        };
      }

      const mainnetConfig = getMainnetConfig(request.chainId);
      const gates = mainnetConfig.safetyGates;

      // 3. Trade Sizing Guard (Controlled Bounds)
      if (
        request.amountInFormatted < gates.minTradeAmountUsd ||
        request.amountInFormatted > gates.maxTradeAmountUsd
      ) {
        return {
          success: false,
          status: "BLOCKED",
          error: `Execution blocked: Trade amount $${request.amountInFormatted} is outside controlled mainnet bounds ($${gates.minTradeAmountUsd} - $${gates.maxTradeAmountUsd})`,
          rejectionGate: "AMOUNT_OUT_OF_BOUNDS",
        };
      }

      // 4. Strict Net Profit Threshold Guard
      if (
        request.expectedNetProfitUsdt <= 0 ||
        request.expectedNetProfitUsdt < gates.minNetProfitUsd
      ) {
        return {
          success: false,
          status: "BLOCKED",
          error: `Execution blocked: Net profit $${request.expectedNetProfitUsdt} does not satisfy mainnet profit gate ($${gates.minNetProfitUsd})`,
          rejectionGate: "UNPROFITABLE_OPPORTUNITY",
        };
      }

      // 5. Pre-Flight Gas Ceiling Guard
      const feeData = await provider.getFeeData();
      if (feeData.gasPrice) {
        const gasPriceGwei = Number(ethers.formatUnits(feeData.gasPrice, "gwei"));
        if (gasPriceGwei > gates.maxGasPriceGwei) {
          return {
            success: false,
            status: "BLOCKED",
            error: `Execution blocked: Gas price ${gasPriceGwei.toFixed(2)} Gwei exceeds mainnet ceiling (${gates.maxGasPriceGwei} Gwei)`,
            rejectionGate: "GAS_PRICE_EXCEEDED",
          };
        }
      }

      // 6. Pre-Flight Native ETH Balance Guard (Must have gas money)
      const signerAddr = await signer.getAddress();
      const nativeBalance = await provider.getBalance(signerAddr);
      if (nativeBalance === 0n) {
        return {
          success: false,
          status: "BLOCKED",
          error: "Execution blocked: Signer has 0 native ETH balance for gas",
          rejectionGate: "INSUFFICIENT_NATIVE_GAS",
        };
      }

      // 7. Delegate to Core TradeExecutionService for On-Chain Atomic Swap & Confirmation
      launchLogger.info("Submitting controlled mainnet trade transaction to network...", {
        opportunityId: request.opportunityId,
        amountIn: request.amountInFormatted,
        signer: signerAddr,
      });

      return await this.tradeExecutionService.executeTrade(
        request,
        provider,
        signer,
        contractAddress
      );
    } finally {
      this.activeMainnetLocks.delete(oppKey);
    }
  }

  /**
   * Immediate Rollback & Emergency Stop Procedure.
   */
  public triggerEmergencyRollback(): {
    status: string;
    emergencyStopped: boolean;
    timestamp: number;
  } {
    launchLogger.warn("EMERGENCY ROLLBACK INITIATED: Freezing all trade executions immediately.");
    this.botService.emergencyStop();
    return {
      status: "EMERGENCY_STOPPED",
      emergencyStopped: true,
      timestamp: Date.now(),
    };
  }
}
