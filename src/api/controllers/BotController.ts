/**
 * @file BotController.ts
 * @description Phase 13: Bot Status & Control Controller
 */

import { RouteHandler } from "../types";
import { BotControlService } from "../services/BotControlService";
import { DatabaseService } from "../services/DatabaseService";

export class BotController {
  private readonly botService: BotControlService;
  private readonly dbService: DatabaseService;

  constructor(botService: BotControlService, dbService: DatabaseService) {
    this.botService = botService;
    this.dbService = dbService;
  }

  public getStatus: RouteHandler = async (req, res) => {
    const opps = this.dbService.getOpportunities({ status: "ACTIVE" }, { page: 1, limit: 100 });
    const status = this.botService.getStatus(opps.pagination.totalItems);

    res.status(200).json({
      success: true,
      data: status,
      requestId: req.requestId,
      timestamp: Date.now(),
    });
  };

  public startBot: RouteHandler = async (req, res) => {
    try {
      const mode = req.body?.tradingMode;
      const status = this.botService.start(mode);
      res.status(200).json({
        success: true,
        data: {
          message: "Bot successfully started and auto-trading enabled",
          status,
        },
        requestId: req.requestId,
        timestamp: Date.now(),
      });
    } catch (err: any) {
      res.status(400).json({
        success: false,
        error: { code: "BOT_START_FAILED", message: err.message },
        requestId: req.requestId,
        timestamp: Date.now(),
      });
    }
  };

  public stopBot: RouteHandler = async (req, res) => {
    try {
      const status = this.botService.stop();
      res.status(200).json({
        success: true,
        data: {
          message: "Bot auto-trading stopped",
          status,
        },
        requestId: req.requestId,
        timestamp: Date.now(),
      });
    } catch (err: any) {
      res.status(400).json({
        success: false,
        error: { code: "BOT_STOP_FAILED", message: err.message },
        requestId: req.requestId,
        timestamp: Date.now(),
      });
    }
  };

  public pauseBot: RouteHandler = async (req, res) => {
    try {
      const status = this.botService.pause();
      res.status(200).json({
        success: true,
        data: {
          message: "Bot paused",
          status,
        },
        requestId: req.requestId,
        timestamp: Date.now(),
      });
    } catch (err: any) {
      res.status(400).json({
        success: false,
        error: { code: "BOT_PAUSE_FAILED", message: err.message },
        requestId: req.requestId,
        timestamp: Date.now(),
      });
    }
  };

  public emergencyStop: RouteHandler = async (req, res) => {
    const status = this.botService.emergencyStop();
    this.dbService.addAlert({
      id: `alert-es-${Date.now()}`,
      severity: "CRITICAL",
      source: "API",
      title: "EMERGENCY STOP TRIGGERED",
      message: `Emergency stop initiated via API by user ${req.user?.username || "unknown"}`,
      resolved: false,
      timestamp: Date.now(),
    });

    res.status(200).json({
      success: true,
      data: {
        message: "EMERGENCY STOP ACTIVATED: All arbitrage trading immediately halted",
        status,
      },
      requestId: req.requestId,
      timestamp: Date.now(),
    });
  };
}
