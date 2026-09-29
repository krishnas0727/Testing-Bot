/**
 * @file TreasuryManager.ts
 * @description Phase 11: Off-Chain Treasury Manager Service
 *
 * Off-chain TypeScript service that interfaces with the deployed Treasury.sol
 * contract. Provides:
 *   - Read bucket balances & allocation ratios
 *   - Deposit funds into buckets
 *   - Request withdrawals (with limit validation)
 *   - Monitor treasury health
 *   - Parse & emit contract events
 *   - Create point-in-time snapshots
 *   - Role & whitelist management
 *
 * Designed for ZERO real-fund execution — all write ops require explicit
 * private key configuration and are testnet-safe by default.
 */

import { ethers } from "ethers";
import {
  TreasuryManagerConfig,
  TreasuryBucket,
  BUCKET_NAMES,
  OnChainBucketBalances,
  FormattedBucketBalances,
  AllocationRatios,
  WithdrawalLimits,
  WithdrawalRequest,
  WithdrawalResult,
  DepositRequest,
  DepositResult,
  TreasuryHealthStatus,
  TreasurySnapshot,
  TreasuryEvent,
} from "./types";
import { TREASURY_ABI, ERC20_MINIMAL_ABI, ROLE_HASHES } from "./config";

// ─────────────────────────────────────────────────────────────────────────────
// LOGGER UTILITY
// ─────────────────────────────────────────────────────────────────────────────

interface LogEntry {
  level: "DEBUG" | "INFO" | "WARN" | "ERROR";
  module: string;
  message: string;
  data?: Record<string, unknown>;
  timestamp: string;
}

function log(entry: Omit<LogEntry, "timestamp">): void {
  const full: LogEntry = { ...entry, timestamp: new Date().toISOString() };
  const prefix = `[${full.timestamp}] [${full.level}] [${full.module}]`;
  const msg = `${prefix} ${full.message}`;
  if (full.data) {
    console.log(msg, JSON.stringify(full.data, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v
    ));
  } else {
    console.log(msg);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TREASURY MANAGER CLASS
// ─────────────────────────────────────────────────────────────────────────────

export class TreasuryManager {
  private readonly config: TreasuryManagerConfig;
  private readonly provider: ethers.JsonRpcProvider;
  private readonly treasuryRead: ethers.Contract;
  private readonly treasuryWrite: ethers.Contract | null;
  private readonly signer: ethers.Wallet | null;

  /** Cached snapshots for historical tracking */
  private readonly snapshotHistory: TreasurySnapshot[] = [];

  /** Maximum snapshots to keep in memory */
  private static readonly MAX_SNAPSHOTS = 100;

  constructor(config: TreasuryManagerConfig) {
    this.config = config;

    if (!config.treasuryAddress) {
      throw new Error("TreasuryManager: treasuryAddress is required");
    }

    this.provider = new ethers.JsonRpcProvider(config.rpcUrl);

    // Read-only contract instance
    this.treasuryRead = new ethers.Contract(
      config.treasuryAddress,
      TREASURY_ABI,
      this.provider
    );

    // Write-capable instance (if private key provided)
    if (config.privateKey) {
      this.signer = new ethers.Wallet(config.privateKey, this.provider);
      this.treasuryWrite = new ethers.Contract(
        config.treasuryAddress,
        TREASURY_ABI,
        this.signer
      );
      log({
        level: "INFO",
        module: "TreasuryManager",
        message: "Initialized with WRITE capabilities",
        data: {
          address: config.treasuryAddress,
          chainId: config.chainId,
          signerAddress: this.signer.address,
        },
      });
    } else {
      this.signer = null;
      this.treasuryWrite = null;
      log({
        level: "INFO",
        module: "TreasuryManager",
        message: "Initialized in READ-ONLY mode (no private key)",
        data: {
          address: config.treasuryAddress,
          chainId: config.chainId,
        },
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // READ — BUCKET BALANCES
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Fetches raw on-chain bucket balances for a token.
   */
  async getRawBucketBalances(tokenAddress: string): Promise<OnChainBucketBalances> {
    return this.withRetry("getRawBucketBalances", async () => {
      const result = await this.treasuryRead.getBucketBalances(tokenAddress);
      return {
        tradingCapital: BigInt(result[0]),
        gasReserve: BigInt(result[1]),
        profitReserve: BigInt(result[2]),
        emergencyReserve: BigInt(result[3]),
        revenue: BigInt(result[4]),
        totalRealizedProfit: BigInt(result[5]),
        totalWithdrawn: BigInt(result[6]),
      };
    });
  }

  /**
   * Fetches formatted (decimal-adjusted) bucket balances for a token.
   */
  async getFormattedBucketBalances(
    tokenAddress: string,
    decimals?: number
  ): Promise<FormattedBucketBalances> {
    const raw = await this.getRawBucketBalances(tokenAddress);
    const dec = decimals ?? this.config.defaultTokenDecimals;
    return this.formatBalances(raw, dec);
  }

  /**
   * Converts raw bigint balances to formatted numbers using token decimals.
   */
  private formatBalances(raw: OnChainBucketBalances, decimals: number): FormattedBucketBalances {
    const fmt = (v: bigint): number => Number(ethers.formatUnits(v, decimals));
    const tradingCapital = fmt(raw.tradingCapital);
    const gasReserve = fmt(raw.gasReserve);
    const profitReserve = fmt(raw.profitReserve);
    const emergencyReserve = fmt(raw.emergencyReserve);
    const revenue = fmt(raw.revenue);
    return {
      tradingCapital,
      gasReserve,
      profitReserve,
      emergencyReserve,
      revenue,
      totalRealizedProfit: fmt(raw.totalRealizedProfit),
      totalWithdrawn: fmt(raw.totalWithdrawn),
      totalBalance: tradingCapital + gasReserve + profitReserve + emergencyReserve + revenue,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // READ — ALLOCATION RATIOS
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Reads the current on-chain allocation ratios (in BPS).
   */
  async getAllocationRatios(): Promise<AllocationRatios> {
    return this.withRetry("getAllocationRatios", async () => {
      const [tc, gr, pr, er, rv] = await Promise.all([
        this.treasuryRead.tradingCapitalBps(),
        this.treasuryRead.gasReserveBps(),
        this.treasuryRead.profitReserveBps(),
        this.treasuryRead.emergencyReserveBps(),
        this.treasuryRead.revenueBps(),
      ]);
      const ratios: AllocationRatios = {
        tradingCapitalBps: Number(tc),
        gasReserveBps: Number(gr),
        profitReserveBps: Number(pr),
        emergencyReserveBps: Number(er),
        revenueBps: Number(rv),
        total: Number(tc) + Number(gr) + Number(pr) + Number(er) + Number(rv),
      };
      return ratios;
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // READ — WITHDRAWAL LIMITS
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Fetches withdrawal limits and remaining daily allowance for a token.
   */
  async getWithdrawalLimits(tokenAddress: string): Promise<WithdrawalLimits> {
    return this.withRetry("getWithdrawalLimits", async () => {
      const [limits, remaining] = await Promise.all([
        this.treasuryRead.tokenWithdrawalLimits(tokenAddress),
        this.treasuryRead.getRemainingDailyLimit(tokenAddress),
      ]);
      return {
        maxPerTx: BigInt(limits[0]),
        maxDaily: BigInt(limits[1]),
        remainingDaily: BigInt(remaining),
      };
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // READ — CONTRACT STATE
  // ─────────────────────────────────────────────────────────────────────────

  /** Checks if the Treasury contract is currently paused */
  async isPaused(): Promise<boolean> {
    return this.withRetry("isPaused", async () => {
      return await this.treasuryRead.paused();
    });
  }

  /** Checks if a token is whitelisted on the Treasury contract */
  async isTokenWhitelisted(tokenAddress: string): Promise<boolean> {
    return this.withRetry("isTokenWhitelisted", async () => {
      return await this.treasuryRead.isTokenWhitelisted(tokenAddress);
    });
  }

  /** Checks if an address has a specific role */
  async hasRole(roleHash: string, account: string): Promise<boolean> {
    return this.withRetry("hasRole", async () => {
      return await this.treasuryRead.hasRole(roleHash, account);
    });
  }

  /** Checks if an address is an admin */
  async isAdmin(account: string): Promise<boolean> {
    return this.hasRole(ROLE_HASHES.ADMIN_ROLE, account);
  }

  /** Checks if an address is a treasury manager */
  async isTreasuryManager(account: string): Promise<boolean> {
    return this.hasRole(ROLE_HASHES.TREASURY_MANAGER_ROLE, account);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // WRITE — DEPOSIT
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Deposits funds into a specific treasury bucket.
   * Requires write capabilities (private key configured).
   */
  async deposit(request: DepositRequest): Promise<DepositResult> {
    this.requireWriteAccess();

    log({
      level: "INFO",
      module: "TreasuryManager",
      message: `Deposit request: ${BUCKET_NAMES[request.bucket]}`,
      data: {
        token: request.token,
        amount: request.amount.toString(),
        bucket: request.bucket,
      },
    });

    try {
      // Check token whitelist
      const whitelisted = await this.isTokenWhitelisted(request.token);
      if (!whitelisted) {
        return {
          success: false,
          bucket: request.bucket,
          amount: request.amount,
          amountFormatted: Number(ethers.formatUnits(request.amount, this.config.defaultTokenDecimals)),
          error: `Token ${request.token} is not whitelisted`,
        };
      }

      // Ensure approval
      await this.ensureApproval(request.token, request.amount);

      // Execute deposit
      const tx = await this.treasuryWrite!.deposit(
        request.token,
        request.amount,
        request.bucket
      );
      const receipt = await tx.wait();

      log({
        level: "INFO",
        module: "TreasuryManager",
        message: `Deposit confirmed: ${receipt.hash}`,
        data: { blockNumber: receipt.blockNumber },
      });

      return {
        success: true,
        txHash: receipt.hash,
        bucket: request.bucket,
        amount: request.amount,
        amountFormatted: Number(ethers.formatUnits(request.amount, this.config.defaultTokenDecimals)),
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      log({
        level: "ERROR",
        module: "TreasuryManager",
        message: `Deposit failed: ${errMsg}`,
      });
      return {
        success: false,
        bucket: request.bucket,
        amount: request.amount,
        amountFormatted: Number(ethers.formatUnits(request.amount, this.config.defaultTokenDecimals)),
        error: errMsg,
      };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // WRITE — WITHDRAWAL
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Withdraws funds from a specific treasury bucket.
   * Requires TREASURY_MANAGER_ROLE on the signer.
   *
   * Pre-validates:
   *   - Write access available
   *   - Token whitelisted
   *   - Bucket has sufficient balance
   *   - Within per-tx and daily limits
   */
  async withdraw(request: WithdrawalRequest): Promise<WithdrawalResult> {
    this.requireWriteAccess();

    log({
      level: "INFO",
      module: "TreasuryManager",
      message: `Withdrawal request: ${BUCKET_NAMES[request.bucket]}`,
      data: {
        token: request.token,
        amount: request.amount.toString(),
        recipient: request.recipient,
        bucket: request.bucket,
        reason: request.reason,
      },
    });

    try {
      // Pre-flight validations
      const validationError = await this.validateWithdrawal(request);
      if (validationError) {
        return {
          success: false,
          bucket: request.bucket,
          amount: request.amount,
          amountFormatted: Number(ethers.formatUnits(request.amount, this.config.defaultTokenDecimals)),
          error: validationError,
        };
      }

      // Execute withdrawal
      const tx = await this.treasuryWrite!.withdraw(
        request.token,
        request.amount,
        request.recipient,
        request.bucket
      );
      const receipt = await tx.wait();

      log({
        level: "INFO",
        module: "TreasuryManager",
        message: `Withdrawal confirmed: ${receipt.hash}`,
        data: {
          blockNumber: receipt.blockNumber,
          reason: request.reason,
        },
      });

      return {
        success: true,
        txHash: receipt.hash,
        bucket: request.bucket,
        amount: request.amount,
        amountFormatted: Number(ethers.formatUnits(request.amount, this.config.defaultTokenDecimals)),
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      log({
        level: "ERROR",
        module: "TreasuryManager",
        message: `Withdrawal failed: ${errMsg}`,
      });
      return {
        success: false,
        bucket: request.bucket,
        amount: request.amount,
        amountFormatted: Number(ethers.formatUnits(request.amount, this.config.defaultTokenDecimals)),
        error: errMsg,
      };
    }
  }

  /**
   * Pre-validates a withdrawal request off-chain before submitting on-chain.
   * Returns null if valid, or an error message string.
   */
  private async validateWithdrawal(request: WithdrawalRequest): Promise<string | null> {
    // 1) Token whitelist
    const whitelisted = await this.isTokenWhitelisted(request.token);
    if (!whitelisted) {
      return `Token ${request.token} is not whitelisted`;
    }

    // 2) Check bucket balance
    const raw = await this.getRawBucketBalances(request.token);
    const bucketBalance = this.getBucketBalanceFromRaw(raw, request.bucket);
    if (bucketBalance < request.amount) {
      return `Insufficient ${BUCKET_NAMES[request.bucket]} balance: ${ethers.formatUnits(bucketBalance, this.config.defaultTokenDecimals)} < ${ethers.formatUnits(request.amount, this.config.defaultTokenDecimals)}`;
    }

    // 3) Per-tx limit
    const limits = await this.getWithdrawalLimits(request.token);
    if (limits.maxPerTx > 0n && request.amount > limits.maxPerTx) {
      return `Amount exceeds per-transaction limit: ${ethers.formatUnits(request.amount, this.config.defaultTokenDecimals)} > ${ethers.formatUnits(limits.maxPerTx, this.config.defaultTokenDecimals)}`;
    }

    // 4) Daily limit
    if (limits.maxDaily > 0n && request.amount > limits.remainingDaily) {
      return `Amount exceeds remaining daily limit: ${ethers.formatUnits(request.amount, this.config.defaultTokenDecimals)} > ${ethers.formatUnits(limits.remainingDaily, this.config.defaultTokenDecimals)}`;
    }

    // 5) Signer has TREASURY_MANAGER_ROLE
    if (this.signer) {
      const hasManagerRole = await this.isTreasuryManager(this.signer.address);
      if (!hasManagerRole) {
        return `Signer ${this.signer.address} does not have TREASURY_MANAGER_ROLE`;
      }
    }

    return null;
  }

  /**
   * Extracts a specific bucket's balance from raw on-chain data.
   */
  private getBucketBalanceFromRaw(raw: OnChainBucketBalances, bucket: TreasuryBucket): bigint {
    switch (bucket) {
      case TreasuryBucket.TRADING_CAPITAL:
        return raw.tradingCapital;
      case TreasuryBucket.GAS_RESERVE:
        return raw.gasReserve;
      case TreasuryBucket.PROFIT_RESERVE:
        return raw.profitReserve;
      case TreasuryBucket.EMERGENCY_RESERVE:
        return raw.emergencyReserve;
      case TreasuryBucket.REVENUE:
        return raw.revenue;
      default:
        return 0n;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // WRITE — ADMIN OPERATIONS
  // ─────────────────────────────────────────────────────────────────────────

  /** Pauses the Treasury contract */
  async pause(): Promise<{ success: boolean; txHash?: string; error?: string }> {
    this.requireWriteAccess();
    try {
      const tx = await this.treasuryWrite!.pause();
      const receipt = await tx.wait();
      log({ level: "WARN", module: "TreasuryManager", message: `Treasury PAUSED: ${receipt.hash}` });
      return { success: true, txHash: receipt.hash };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      return { success: false, error: errMsg };
    }
  }

  /** Unpauses the Treasury contract */
  async unpause(): Promise<{ success: boolean; txHash?: string; error?: string }> {
    this.requireWriteAccess();
    try {
      const tx = await this.treasuryWrite!.unpause();
      const receipt = await tx.wait();
      log({ level: "INFO", module: "TreasuryManager", message: `Treasury UNPAUSED: ${receipt.hash}` });
      return { success: true, txHash: receipt.hash };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      return { success: false, error: errMsg };
    }
  }

  /** Whitelists or removes a token from the Treasury */
  async setTokenWhitelist(
    tokenAddress: string,
    status: boolean
  ): Promise<{ success: boolean; txHash?: string; error?: string }> {
    this.requireWriteAccess();
    try {
      const tx = await this.treasuryWrite!.setTokenWhitelist(tokenAddress, status);
      const receipt = await tx.wait();
      log({
        level: "INFO",
        module: "TreasuryManager",
        message: `Token ${status ? "whitelisted" : "removed"}: ${tokenAddress}`,
        data: { txHash: receipt.hash },
      });
      return { success: true, txHash: receipt.hash };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      return { success: false, error: errMsg };
    }
  }

  /** Updates allocation ratios (must sum to 10000 BPS) */
  async setAllocationRatios(
    tradingCapitalBps: number,
    gasReserveBps: number,
    profitReserveBps: number,
    emergencyReserveBps: number,
    revenueBps: number
  ): Promise<{ success: boolean; txHash?: string; error?: string }> {
    this.requireWriteAccess();

    const sum = tradingCapitalBps + gasReserveBps + profitReserveBps + emergencyReserveBps + revenueBps;
    if (sum !== 10000) {
      return { success: false, error: `Allocation ratios must sum to 10000 BPS, got ${sum}` };
    }

    try {
      const tx = await this.treasuryWrite!.setAllocationRatios(
        tradingCapitalBps,
        gasReserveBps,
        profitReserveBps,
        emergencyReserveBps,
        revenueBps
      );
      const receipt = await tx.wait();
      log({
        level: "INFO",
        module: "TreasuryManager",
        message: "Allocation ratios updated",
        data: { tradingCapitalBps, gasReserveBps, profitReserveBps, emergencyReserveBps, revenueBps },
      });
      return { success: true, txHash: receipt.hash };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      return { success: false, error: errMsg };
    }
  }

  /** Sets withdrawal limits for a token */
  async setWithdrawalLimits(
    tokenAddress: string,
    maxPerTx: bigint,
    maxDaily: bigint
  ): Promise<{ success: boolean; txHash?: string; error?: string }> {
    this.requireWriteAccess();
    try {
      const tx = await this.treasuryWrite!.setWithdrawalLimits(tokenAddress, maxPerTx, maxDaily);
      const receipt = await tx.wait();
      log({
        level: "INFO",
        module: "TreasuryManager",
        message: `Withdrawal limits set for ${tokenAddress}`,
        data: { maxPerTx: maxPerTx.toString(), maxDaily: maxDaily.toString() },
      });
      return { success: true, txHash: receipt.hash };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      return { success: false, error: errMsg };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // HEALTH CHECK
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Performs a comprehensive treasury health check.
   *
   * @param tokenAddresses - list of token addresses to check balances for
   */
  async getHealthStatus(tokenAddresses: string[]): Promise<TreasuryHealthStatus> {
    const warnings: string[] = [];

    // 1) Contract paused?
    const paused = await this.isPaused();
    if (paused) {
      warnings.push("⚠️ Treasury contract is PAUSED — all operations halted");
    }

    // 2) Allocation ratios
    const ratios = await this.getAllocationRatios();
    if (ratios.total !== 10000) {
      warnings.push(`⚠️ Allocation ratios sum to ${ratios.total} (expected 10000)`);
    }

    // 3) Bucket balances for default token
    const defaultToken = this.config.defaultTokenAddress;
    const buckets = await this.getFormattedBucketBalances(defaultToken);

    // 4) Check whitelisted status for provided tokens
    const whitelistedTokens: string[] = [];
    for (const token of tokenAddresses) {
      const isWl = await this.isTokenWhitelisted(token);
      if (isWl) {
        whitelistedTokens.push(token);
      } else {
        warnings.push(`Token ${token} is NOT whitelisted`);
      }
    }

    // 5) Withdrawal limits for whitelisted tokens
    const withdrawalLimits: Record<string, WithdrawalLimits> = {};
    for (const token of whitelistedTokens) {
      withdrawalLimits[token] = await this.getWithdrawalLimits(token);
    }

    // 6) Low balance warnings
    if (buckets.gasReserve < 0.01) {
      warnings.push("⚠️ Gas Reserve is critically low");
    }
    if (buckets.tradingCapital < 1.0) {
      warnings.push("⚠️ Trading Capital is below minimum operational level");
    }

    const healthy = !paused && warnings.length === 0;

    return {
      healthy,
      paused,
      totalValueUsd: buckets.totalBalance,
      buckets,
      allocationRatios: ratios,
      withdrawalLimits,
      whitelistedTokens,
      lastChecked: Date.now(),
      warnings,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SNAPSHOT
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Creates a point-in-time treasury snapshot.
   *
   * @param tokenAddresses - tokens to include in the snapshot
   */
  async createSnapshot(tokenAddresses: string[]): Promise<TreasurySnapshot> {
    const blockNumber = await this.provider.getBlockNumber();
    const block = await this.provider.getBlock(blockNumber);
    const timestamp = block?.timestamp ?? Math.floor(Date.now() / 1000);

    // Get balances for each token
    const balances: Record<string, FormattedBucketBalances> = {};
    for (const token of tokenAddresses) {
      try {
        balances[token] = await this.getFormattedBucketBalances(token);
      } catch {
        log({
          level: "WARN",
          module: "TreasuryManager",
          message: `Failed to get balances for ${token} — skipping`,
        });
      }
    }

    // Get health status
    const health = await this.getHealthStatus(tokenAddresses);

    const snapshot: TreasurySnapshot = {
      chainId: this.config.chainId,
      blockNumber,
      timestamp,
      balances,
      health,
    };

    // Store in history (bounded)
    this.snapshotHistory.push(snapshot);
    if (this.snapshotHistory.length > TreasuryManager.MAX_SNAPSHOTS) {
      this.snapshotHistory.shift();
    }

    log({
      level: "INFO",
      module: "TreasuryManager",
      message: `Snapshot #${this.snapshotHistory.length} created at block ${blockNumber}`,
      data: { tokens: tokenAddresses.length, totalValue: health.totalValueUsd },
    });

    return snapshot;
  }

  /** Returns all stored snapshots */
  getSnapshotHistory(): readonly TreasurySnapshot[] {
    return this.snapshotHistory;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // EVENT PARSING
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Queries and parses Treasury contract events within a block range.
   *
   * @param fromBlock - starting block number
   * @param toBlock - ending block number (default: latest)
   */
  async getEvents(fromBlock: number, toBlock?: number): Promise<TreasuryEvent[]> {
    const events: TreasuryEvent[] = [];
    const endBlock = toBlock ?? "latest";

    try {
      const logs = await this.provider.getLogs({
        address: this.config.treasuryAddress,
        fromBlock,
        toBlock: endBlock,
      });

      const iface = new ethers.Interface(TREASURY_ABI);

      for (const logEntry of logs) {
        try {
          const parsed = iface.parseLog({
            topics: logEntry.topics as string[],
            data: logEntry.data,
          });
          if (!parsed) continue;

          const base = {
            blockNumber: logEntry.blockNumber,
            txHash: logEntry.transactionHash,
            timestamp: Date.now(), // Will be block timestamp in production
          };

          const event = this.mapParsedLogToEvent(parsed, base);
          if (event) {
            events.push(event);
          }
        } catch {
          // Skip unparseable logs
        }
      }

      log({
        level: "DEBUG",
        module: "TreasuryManager",
        message: `Parsed ${events.length} events from blocks ${fromBlock}..${endBlock}`,
      });
    } catch (error) {
      log({
        level: "ERROR",
        module: "TreasuryManager",
        message: `Event query failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }

    return events;
  }

  /**
   * Maps a parsed ethers log to a typed TreasuryEvent.
   */
  private mapParsedLogToEvent(
    parsed: ethers.LogDescription,
    base: { blockNumber: number; txHash: string; timestamp: number }
  ): TreasuryEvent | null {
    switch (parsed.name) {
      case "ProfitReceived":
        return {
          ...base,
          type: "PROFIT_RECEIVED",
          executor: parsed.args[0],
          token: parsed.args[1],
          grossAmount: BigInt(parsed.args[2]),
          tradingCapitalAllocated: BigInt(parsed.args[3]),
          gasReserveAllocated: BigInt(parsed.args[4]),
          profitReserveAllocated: BigInt(parsed.args[5]),
          emergencyReserveAllocated: BigInt(parsed.args[6]),
          revenueAllocated: BigInt(parsed.args[7]),
        };

      case "Deposit":
        return {
          ...base,
          type: "DEPOSIT",
          depositor: parsed.args[0],
          token: parsed.args[1],
          amount: BigInt(parsed.args[2]),
          bucket: Number(parsed.args[3]) as TreasuryBucket,
        };

      case "Withdrawal":
        return {
          ...base,
          type: "WITHDRAWAL",
          recipient: parsed.args[0],
          token: parsed.args[1],
          amount: BigInt(parsed.args[2]),
          bucket: Number(parsed.args[3]) as TreasuryBucket,
        };

      case "EmergencyWithdrawal":
        return {
          ...base,
          type: "EMERGENCY_WITHDRAWAL",
          recipient: parsed.args[0],
          token: parsed.args[1],
          amount: BigInt(parsed.args[2]),
        };

      case "Paused":
        return { ...base, type: "PAUSED", account: parsed.args[0] };

      case "Unpaused":
        return { ...base, type: "UNPAUSED", account: parsed.args[0] };

      case "TokenWhitelisted":
        return {
          ...base,
          type: "TOKEN_WHITELISTED",
          token: parsed.args[0],
          status: parsed.args[1],
        };

      case "RoleGranted":
        return {
          ...base,
          type: "ROLE_GRANTED",
          role: parsed.args[0],
          account: parsed.args[1],
          sender: parsed.args[2],
        };

      case "RoleRevoked":
        return {
          ...base,
          type: "ROLE_REVOKED",
          role: parsed.args[0],
          account: parsed.args[1],
          sender: parsed.args[2],
        };

      case "AllocationUpdated":
        return {
          ...base,
          type: "ALLOCATION_UPDATED",
          tradingCapitalBps: Number(parsed.args[0]),
          gasReserveBps: Number(parsed.args[1]),
          profitReserveBps: Number(parsed.args[2]),
          emergencyReserveBps: Number(parsed.args[3]),
          revenueBps: Number(parsed.args[4]),
        };

      default:
        return null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ERC-20 HELPERS
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Ensures the signer has approved the Treasury to spend the required amount.
   */
  private async ensureApproval(tokenAddress: string, amount: bigint): Promise<void> {
    if (!this.signer) return;

    const erc20 = new ethers.Contract(tokenAddress, ERC20_MINIMAL_ABI, this.signer);
    const currentAllowance: bigint = await erc20.allowance(
      this.signer.address,
      this.config.treasuryAddress
    );

    if (currentAllowance < amount) {
      log({
        level: "INFO",
        module: "TreasuryManager",
        message: `Approving Treasury to spend ${ethers.formatUnits(amount, this.config.defaultTokenDecimals)} tokens`,
      });
      const tx = await erc20.approve(this.config.treasuryAddress, amount);
      await tx.wait();
    }
  }

  /**
   * Gets the signer's ERC-20 token balance.
   */
  async getSignerTokenBalance(tokenAddress: string): Promise<bigint> {
    if (!this.signer) throw new Error("No signer configured");
    const erc20 = new ethers.Contract(tokenAddress, ERC20_MINIMAL_ABI, this.provider);
    return await erc20.balanceOf(this.signer.address);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // INTERNAL UTILITIES
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Throws if no write access is configured.
   */
  private requireWriteAccess(): void {
    if (!this.treasuryWrite || !this.signer) {
      throw new Error(
        "TreasuryManager: Write operations require a private key. " +
        "Set TREASURY_MANAGER_PRIVATE_KEY in your environment."
      );
    }
  }

  /**
   * Wraps an async operation with retry logic.
   */
  private async withRetry<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < this.config.maxRetries) {
          log({
            level: "WARN",
            module: "TreasuryManager",
            message: `${operation} attempt ${attempt}/${this.config.maxRetries} failed: ${lastError.message}. Retrying...`,
          });
          await this.sleep(this.config.retryDelayMs * attempt);
        }
      }
    }
    throw lastError!;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GETTERS
  // ─────────────────────────────────────────────────────────────────────────

  /** Returns the Treasury contract address */
  get contractAddress(): string {
    return this.config.treasuryAddress;
  }

  /** Returns the configured chain ID */
  get chainId(): number {
    return this.config.chainId;
  }

  /** Returns the signer address (or null if read-only) */
  get signerAddress(): string | null {
    return this.signer?.address ?? null;
  }

  /** Returns whether this manager has write capabilities */
  get hasWriteAccess(): boolean {
    return this.treasuryWrite !== null;
  }
}
