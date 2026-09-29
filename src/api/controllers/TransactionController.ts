/**
 * @file TransactionController.ts
 * @description Phase 13: Blockchain Transaction Controller
 */

import { RouteHandler } from "../types";
import { DatabaseService } from "../services/DatabaseService";
import { BlockchainSyncService } from "../services/BlockchainSyncService";
import { SupportedChainId } from "../../types";

export class TransactionController {
  private readonly dbService: DatabaseService;
  private readonly syncService: BlockchainSyncService;

  constructor(dbService: DatabaseService, syncService: BlockchainSyncService) {
    this.dbService = dbService;
    this.syncService = syncService;
  }

  public getTransactions: RouteHandler = async (req, res) => {
    const page = parseInt(req.query.page || "1", 10);
    const limit = parseInt(req.query.limit || "20", 10);
    const status = req.query.status;
    const chainId = req.query.chainId ? parseInt(req.query.chainId, 10) : undefined;

    const result = this.dbService.getTransactions({ status, chainId }, { page, limit });

    res.status(200).json({
      success: true,
      data: result.items,
      pagination: result.pagination,
      requestId: req.requestId,
      timestamp: Date.now(),
    });
  };

  public getTransactionByHash: RouteHandler = async (req, res) => {
    const tx = this.dbService.getTransactionByHash(req.params.hash);
    if (!tx) {
      res.status(404).json({
        success: false,
        error: { code: "NOT_FOUND", message: `Transaction ${req.params.hash} not found in local index` },
        requestId: req.requestId,
        timestamp: Date.now(),
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: tx,
      requestId: req.requestId,
      timestamp: Date.now(),
    });
  };

  public syncTransaction: RouteHandler = async (req, res) => {
    const hash = req.params.hash;
    const chainId = (req.body?.chainId ? parseInt(req.body.chainId, 10) : 8453) as SupportedChainId;

    const syncResult = await this.syncService.syncTransactionStatus(hash, chainId);
    if (!syncResult.synced && !syncResult.transaction) {
      res.status(502).json({
        success: false,
        error: {
          code: "SYNC_FAILED",
          message: syncResult.error || "Failed to synchronize transaction with blockchain",
        },
        requestId: req.requestId,
        timestamp: Date.now(),
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: {
        synced: syncResult.synced,
        transaction: syncResult.transaction,
        warning: syncResult.error,
      },
      requestId: req.requestId,
      timestamp: Date.now(),
    });
  };
}
