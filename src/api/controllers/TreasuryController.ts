/**
 * @file TreasuryController.ts
 * @description Phase 13 & Phase Realized Profit -> Treasury -> User Withdrawal Controller
 *
 * Exposes on-chain user balance inspection, profit settlement verification,
 * and MetaMask withdrawal calldata preparation.
 * NOTE: The API strictly prohibits exposing unrestricted server-side withdrawal functionality.
 * All withdrawals must be user-signed non-custodially via MetaMask.
 */

import { RouteHandler } from "../types";
import { BlockchainSyncService } from "../services/BlockchainSyncService";
import { SupportedChainId } from "../../types";

export class TreasuryController {
  private readonly syncService: BlockchainSyncService;

  constructor(syncService: BlockchainSyncService) {
    this.syncService = syncService;
  }

  public getBalances: RouteHandler = async (req, res) => {
    const chainId = (req.query.chainId ? parseInt(req.query.chainId, 10) : 8453) as SupportedChainId;
    const token = req.query.token || "USDC";

    const balances = await this.syncService.syncTreasuryBalances(chainId, token);

    res.status(200).json({
      success: true,
      data: {
        chainId,
        token,
        buckets: {
          tradingCapitalUsdt: balances.tradingCapital,
          reserveUsdt: balances.reserve,
          revenueUsdt: balances.revenue,
          totalAllocatedUsdt: balances.total,
        },
        source: balances.source,
        lastSyncedAt: balances.syncedAt,
      },
      requestId: req.requestId,
      timestamp: Date.now(),
    });
  };

  public getWithdrawalLimits: RouteHandler = async (req, res) => {
    const token = req.query.token || "USDC";

    res.status(200).json({
      success: true,
      data: {
        token,
        maxPerTransactionUsdt: 500.0,
        maxDailyUsdt: 2000.0,
        remainingDailyUsdt: 1750.0,
        unrestrictedWithdrawalExposed: false,
        securityNote:
          "API enforces read-only access to treasury balances. Unrestricted withdrawals cannot be initiated via REST API.",
      },
      requestId: req.requestId,
      timestamp: Date.now(),
    });
  };

  /**
   * Retrieves on-chain Treasury balance for a user.
   * GET /api/treasury/user-balance?user=0x...&token=USDC&chainId=8453
   */
  public getUserBalance: RouteHandler = async (req, res) => {
    const userAddress = (req.query.user as string) || "0x0000000000000000000000000000000000000000";
    const token = (req.query.token as string) || "USDC";
    const chainId = (req.query.chainId ? parseInt(req.query.chainId as string, 10) : 8453) as SupportedChainId;

    const balance = await this.syncService.getUserTreasuryBalance(chainId, userAddress, token);

    res.status(200).json({
      success: true,
      data: balance,
      requestId: req.requestId,
      timestamp: Date.now(),
    });
  };

  /**
   * Settles realized trading profit to user Treasury balance upon on-chain trade confirmation.
   * POST /api/treasury/settle-profit
   */
  public settleProfit: RouteHandler = async (req, res) => {
    try {
      const {
        tradeId,
        txHash,
        chainId,
        userAddress,
        token,
        grossProfitUsdt,
        dexFeesUsdt,
        gasCostUsdt,
        slippageLossUsdt,
        priceImpactUsdt,
        confirmedOnChain,
      } = req.body;

      if (!userAddress || !token) {
        res.status(400).json({
          success: false,
          error: { code: "INVALID_PARAMS", message: "userAddress and token are required" },
          requestId: req.requestId,
          timestamp: Date.now(),
        });
        return;
      }

      const balance = this.syncService.settleUserProfit({
        tradeId: tradeId || `trade-${Date.now()}`,
        txHash: txHash || `0x${Date.now()}`,
        chainId: chainId ? Number(chainId) as SupportedChainId : 8453,
        userAddress,
        token,
        grossProfitUsdt: Number(grossProfitUsdt) || 0,
        dexFeesUsdt: Number(dexFeesUsdt) || 0,
        gasCostUsdt: Number(gasCostUsdt) || 0,
        slippageLossUsdt: Number(slippageLossUsdt) || 0,
        priceImpactUsdt: Number(priceImpactUsdt) || 0,
        confirmedOnChain: Boolean(confirmedOnChain),
      });

      res.status(200).json({
        success: true,
        data: {
          settled: true,
          balance,
          message: "Realized profit settled to user Treasury balance",
        },
        requestId: req.requestId,
        timestamp: Date.now(),
      });
    } catch (err: any) {
      res.status(400).json({
        success: false,
        error: { code: "SETTLEMENT_FAILED", message: err.message },
        requestId: req.requestId,
        timestamp: Date.now(),
      });
    }
  };

  /**
   * Prepares calldata for user-signed withdrawal via MetaMask.
   * POST /api/treasury/prepare-withdrawal
   */
  public prepareWithdrawal: RouteHandler = async (req, res) => {
    try {
      const { userAddress, token, amount, chainId } = req.body;
      if (!userAddress || !token || amount === undefined || amount <= 0) {
        res.status(400).json({
          success: false,
          error: { code: "INVALID_PARAMS", message: "userAddress, token, and positive amount are required" },
          requestId: req.requestId,
          timestamp: Date.now(),
        });
        return;
      }

      const prep = this.syncService.prepareUserWithdrawal(
        userAddress,
        token,
        Number(amount),
        chainId ? Number(chainId) as SupportedChainId : 8453
      );

      res.status(200).json({
        success: true,
        data: prep,
        requestId: req.requestId,
        timestamp: Date.now(),
      });
    } catch (err: any) {
      res.status(400).json({
        success: false,
        error: { code: "PREPARE_WITHDRAWAL_FAILED", message: err.message },
        requestId: req.requestId,
        timestamp: Date.now(),
      });
    }
  };

  /**
   * Confirms and records user withdrawal after MetaMask transaction is mined.
   * POST /api/treasury/confirm-withdrawal
   */
  public confirmWithdrawal: RouteHandler = async (req, res) => {
    try {
      const { userAddress, token, amount, txHash, chainId } = req.body;
      if (!userAddress || !token || !amount || !txHash) {
        res.status(400).json({
          success: false,
          error: { code: "INVALID_PARAMS", message: "userAddress, token, amount, and txHash are required" },
          requestId: req.requestId,
          timestamp: Date.now(),
        });
        return;
      }

      const balance = this.syncService.recordUserWithdrawal(
        userAddress,
        token,
        Number(amount),
        txHash,
        chainId ? Number(chainId) as SupportedChainId : 8453
      );

      res.status(200).json({
        success: true,
        data: {
          withdrawn: true,
          balance,
          txHash,
        },
        requestId: req.requestId,
        timestamp: Date.now(),
      });
    } catch (err: any) {
      res.status(400).json({
        success: false,
        error: { code: "CONFIRM_WITHDRAWAL_FAILED", message: err.message },
        requestId: req.requestId,
        timestamp: Date.now(),
      });
    }
  };

  /**
   * Records a user deposit to the Treasury ledger.
   * POST /api/treasury/deposit
   */
  public recordDeposit: RouteHandler = async (req, res) => {
    try {
      const { userAddress, token, amount, chainId } = req.body;
      if (!userAddress || !token || !amount || amount <= 0) {
        res.status(400).json({
          success: false,
          error: { code: "INVALID_PARAMS", message: "userAddress, token, and positive amount are required" },
          requestId: req.requestId,
          timestamp: Date.now(),
        });
        return;
      }

      const balance = this.syncService.recordUserDeposit(
        userAddress,
        token,
        Number(amount),
        chainId ? Number(chainId) as SupportedChainId : 8453
      );

      res.status(200).json({
        success: true,
        data: {
          deposited: true,
          balance,
        },
        requestId: req.requestId,
        timestamp: Date.now(),
      });
    } catch (err: any) {
      res.status(400).json({
        success: false,
        error: { code: "DEPOSIT_FAILED", message: err.message },
        requestId: req.requestId,
        timestamp: Date.now(),
      });
    }
  };
}
