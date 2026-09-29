/**
 * @file AlertsController.ts
 * @description Phase 13: System Alerts & Notifications Controller
 */

import { RouteHandler } from "../types";
import { DatabaseService } from "../services/DatabaseService";

export class AlertsController {
  private readonly dbService: DatabaseService;

  constructor(dbService: DatabaseService) {
    this.dbService = dbService;
  }

  public getAlerts: RouteHandler = async (req, res) => {
    const page = parseInt(req.query.page || "1", 10);
    const limit = parseInt(req.query.limit || "20", 10);
    const severity = req.query.severity;
    const resolved = req.query.resolved !== undefined ? req.query.resolved === "true" : undefined;

    const result = this.dbService.getAlerts({ severity, resolved }, { page, limit });

    res.status(200).json({
      success: true,
      data: result.items,
      pagination: result.pagination,
      requestId: req.requestId,
      timestamp: Date.now(),
    });
  };

  public resolveAlert: RouteHandler = async (req, res) => {
    const alertId = req.params.id;
    const resolved = this.dbService.resolveAlert(alertId);

    if (!resolved) {
      res.status(404).json({
        success: false,
        error: { code: "NOT_FOUND", message: `Alert ${alertId} not found` },
        requestId: req.requestId,
        timestamp: Date.now(),
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: { message: `Alert ${alertId} marked as resolved` },
      requestId: req.requestId,
      timestamp: Date.now(),
    });
  };
}
