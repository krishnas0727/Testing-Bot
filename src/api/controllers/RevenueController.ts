/**
 * @file RevenueController.ts
 * @description Phase 13: Revenue Allocations & Policy Controller
 */

import { RouteHandler } from "../types";
import { DatabaseService } from "../services/DatabaseService";
import { RevenueDistributionEngine, ThreeBucketAllocationPolicy } from "../../distribution";

export class RevenueController {
  private readonly dbService: DatabaseService;
  private readonly distributionEngine: RevenueDistributionEngine;

  constructor(dbService: DatabaseService, distributionEngine: RevenueDistributionEngine) {
    this.dbService = dbService;
    this.distributionEngine = distributionEngine;
  }

  public getAllocations: RouteHandler = async (req, res) => {
    const page = parseInt(req.query.page || "1", 10);
    const limit = parseInt(req.query.limit || "20", 10);
    const chainId = req.query.chainId ? parseInt(req.query.chainId, 10) : undefined;

    const result = this.dbService.getRevenueAllocations({ chainId }, { page, limit });

    res.status(200).json({
      success: true,
      data: result.items,
      pagination: result.pagination,
      requestId: req.requestId,
      timestamp: Date.now(),
    });
  };

  public getPolicy: RouteHandler = async (req, res) => {
    const policy = this.distributionEngine.getPolicy();
    res.status(200).json({
      success: true,
      data: {
        policy,
        percentages: {
          tradingCapitalPct: policy.tradingCapitalBps / 100,
          reservePct: policy.reserveBps / 100,
          revenuePct: policy.revenueBps / 100,
        },
      },
      requestId: req.requestId,
      timestamp: Date.now(),
    });
  };

  public updatePolicy: RouteHandler = async (req, res) => {
    try {
      const newPolicy: ThreeBucketAllocationPolicy = req.body;
      const callerRole = req.user?.role || "ANONYMOUS";
      const callerAddress = req.user?.username || "unknown";

      const record = this.distributionEngine.updatePolicy(
        newPolicy,
        callerRole,
        callerAddress
      );

      res.status(200).json({
        success: true,
        data: {
          message: "Allocation policy updated successfully",
          record,
        },
        requestId: req.requestId,
        timestamp: Date.now(),
      });
    } catch (err: any) {
      res.status(400).json({
        success: false,
        error: {
          code: "POLICY_UPDATE_FAILED",
          message: err.message,
        },
        requestId: req.requestId,
        timestamp: Date.now(),
      });
    }
  };
}
