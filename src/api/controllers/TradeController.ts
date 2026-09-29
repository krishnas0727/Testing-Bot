/**
 * @file TradeController.ts
 * @description Phase 13 & 17: Trade History & Live Execution Controller
 */

import { RouteHandler } from "../types";
import { DatabaseService } from "../services/DatabaseService";
import { TradeExecutionService, TradeExecutionRequest } from "../services/TradeExecutionService";

export class TradeController {
  private readonly dbService: DatabaseService;
  private readonly executionService?: TradeExecutionService;

  constructor(dbService: DatabaseService, executionService?: TradeExecutionService) {
    this.dbService = dbService;
    this.executionService = executionService;
  }

  public getTrades: RouteHandler = async (req, res) => {
    const page = parseInt(req.query.page || "1", 10);
    const limit = parseInt(req.query.limit || "20", 10);
    const sortBy = req.query.sortBy || "timestamp";
    const sortOrder = (req.query.sortOrder as "asc" | "desc") || "desc";

    const status = req.query.status;
    const chainId = req.query.chainId ? parseInt(req.query.chainId, 10) : undefined;
    const token = req.query.token;

    const result = this.dbService.getTrades(
      { status, chainId, token },
      { page, limit, sortBy, sortOrder }
    );

    res.status(200).json({
      success: true,
      data: result.items,
      pagination: result.pagination,
      requestId: req.requestId,
      timestamp: Date.now(),
    });
  };

  public getTradeById: RouteHandler = async (req, res) => {
    const trade = this.dbService.getTradeById(req.params.id);
    if (!trade) {
      res.status(404).json({
        success: false,
        error: { code: "NOT_FOUND", message: `Trade ${req.params.id} not found` },
        requestId: req.requestId,
        timestamp: Date.now(),
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: trade,
      requestId: req.requestId,
      timestamp: Date.now(),
    });
  };

  /**
   * Phase 17: Executes an arbitrage trade on-chain.
   */
  public executeTrade: RouteHandler = async (req, res) => {
    if (!this.executionService) {
      res.status(503).json({
        success: false,
        error: { code: "SERVICE_UNAVAILABLE", message: "TradeExecutionService not mounted" },
        requestId: req.requestId,
        timestamp: Date.now(),
      });
      return;
    }

    const body: TradeExecutionRequest = req.body;
    if (!body || !body.tokenIn || !body.tokenOut || !body.routerBuy || !body.routerSell) {
      res.status(400).json({
        success: false,
        error: { code: "INVALID_REQUEST", message: "Missing required execution parameters" },
        requestId: req.requestId,
        timestamp: Date.now(),
      });
      return;
    }

    // Call execution coordinator
    const result = await this.executionService.executeTrade(body);

    if (result.status === "BLOCKED") {
      res.status(403).json({
        success: false,
        error: { code: result.rejectionGate || "TRADE_BLOCKED", message: result.error },
        requestId: req.requestId,
        timestamp: Date.now(),
      });
      return;
    }

    if (result.status === "REVERTED" || result.status === "FAILED") {
      res.status(502).json({
        success: false,
        error: { code: "EXECUTION_FAILED", message: result.error, details: result },
        requestId: req.requestId,
        timestamp: Date.now(),
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: result,
      requestId: req.requestId,
      timestamp: Date.now(),
    });
  };
}
