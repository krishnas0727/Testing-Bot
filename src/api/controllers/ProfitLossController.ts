/**
 * @file ProfitLossController.ts
 * @description Phase 13: P&L Summary & Metrics Controller
 */

import { RouteHandler } from "../types";
import { DatabaseService } from "../services/DatabaseService";

export class ProfitLossController {
  private readonly dbService: DatabaseService;

  constructor(dbService: DatabaseService) {
    this.dbService = dbService;
  }

  public getProfitLoss: RouteHandler = async (req, res) => {
    const period = (req.query.period as "24h" | "7d" | "30d" | "all") || "all";
    const summary = this.dbService.getProfitLoss(period);

    res.status(200).json({
      success: true,
      data: summary,
      requestId: req.requestId,
      timestamp: Date.now(),
    });
  };
}
