/**
 * @file OpportunityController.ts
 * @description Phase 13: Market Opportunities Controller
 */

import { RouteHandler } from "../types";
import { DatabaseService } from "../services/DatabaseService";

export class OpportunityController {
  private readonly dbService: DatabaseService;

  constructor(dbService: DatabaseService) {
    this.dbService = dbService;
  }

  public getOpportunities: RouteHandler = async (req, res) => {
    const page = parseInt(req.query.page || "1", 10);
    const limit = parseInt(req.query.limit || "20", 10);
    const sortBy = req.query.sortBy || "timestamp";
    const sortOrder = (req.query.sortOrder as "asc" | "desc") || "desc";

    const status = req.query.status;
    const chainId = req.query.chainId ? parseInt(req.query.chainId, 10) : undefined;
    const minNetProfit = req.query.minNetProfit ? parseFloat(req.query.minNetProfit) : undefined;

    const result = this.dbService.getOpportunities(
      { status, chainId, minNetProfit },
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

  public getOpportunityById: RouteHandler = async (req, res) => {
    const opp = this.dbService.getOpportunityById(req.params.id);
    if (!opp) {
      res.status(404).json({
        success: false,
        error: { code: "NOT_FOUND", message: `Opportunity with id ${req.params.id} not found` },
        requestId: req.requestId,
        timestamp: Date.now(),
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: opp,
      requestId: req.requestId,
      timestamp: Date.now(),
    });
  };
}
