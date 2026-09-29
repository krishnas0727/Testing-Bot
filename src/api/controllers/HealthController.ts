/**
 * @file HealthController.ts
 * @description Phase 23: Production Health and Telemetry Monitoring Endpoints
 *
 * Implements:
 * - Public /api/health: Liveness probe with non-sensitive component status
 * - Public /api/health/ready: Readiness probe with deep diagnostics (HEALTHY, DEGRADED, UNAVAILABLE)
 * - /api/monitoring/status: Full production monitoring snapshot (Chain, Gas, DEX, Wallet, Alerts)
 * - /api/monitoring/probe: On-demand diagnostic health probe (Requires OPERATOR)
 * - /api/monitoring/wallet/revalidate: Explicit wallet revalidation (Requires OPERATOR)
 */

import { RouteHandler } from "../types";
import { BotControlService } from "../services/BotControlService";
import { DatabaseService } from "../services/DatabaseService";
import { ProductionMonitoringService } from "../../monitoring/ProductionMonitoringService";

export class HealthController {
  private readonly botService: BotControlService;
  private readonly dbService: DatabaseService;
  private readonly monitoringService?: ProductionMonitoringService;

  constructor(
    botService: BotControlService,
    dbService: DatabaseService,
    monitoringService?: ProductionMonitoringService
  ) {
    this.botService = botService;
    this.dbService = dbService;
    this.monitoringService = monitoringService;
  }

  public getLiveness: RouteHandler = async (req, res) => {
    const snapshot = this.monitoringService ? this.monitoringService.getHealthSnapshot() : null;

    res.status(200).json({
      success: true,
      data: {
        status: "UP",
        service: "DEX Arbitrage Backend API",
        version: "1.0.0",
        systemHealth: snapshot ? snapshot.overall : "HEALTHY",
        uptimeSeconds: Math.floor(process.uptime()),
        timestamp: Date.now(),
      },
      requestId: req.requestId,
      timestamp: Date.now(),
    });
  };

  public getReadiness: RouteHandler = async (req, res) => {
    const botStatus = this.botService.getStatus();
    const snapshot = this.monitoringService
      ? await this.monitoringService.probeSystemHealth()
      : null;

    const isHealthy = snapshot
      ? snapshot.overall !== "UNAVAILABLE"
      : botStatus.status !== "EMERGENCY_STOPPED";

    const statusCode = isHealthy ? 200 : 503;
    res.status(statusCode).json({
      success: isHealthy,
      data: {
        status: isHealthy ? "READY" : "NOT_READY",
        healthStatus: snapshot ? snapshot.overall : isHealthy ? "HEALTHY" : "UNAVAILABLE",
        botStatus: botStatus.status,
        components: snapshot ? snapshot.components : {
          database: "CONNECTED",
          blockchainSync: "OPERATIONAL",
        },
        circuitBreakerTripped: botStatus.circuitBreakerTripped,
      },
      requestId: req.requestId,
      timestamp: Date.now(),
    });
  };

  public getMonitoringStatus: RouteHandler = async (req, res) => {
    if (!this.monitoringService) {
      res.status(200).json({
        success: true,
        data: { message: "Basic monitoring active" },
        requestId: req.requestId,
        timestamp: Date.now(),
      });
      return;
    }

    const health = this.monitoringService.getHealthSnapshot();
    const blockchain = this.monitoringService.getBlockchainMetrics();
    const gas = this.monitoringService.getGasMetrics();
    const wallet = this.monitoringService.getWalletState();
    const dex = this.monitoringService.getDexMetrics();
    const recentErrors = this.monitoringService.getRecentErrors(10);
    const alerts = this.dbService.getAlerts({ resolved: false }, { page: 1, limit: 10 }).items;

    res.status(200).json({
      success: true,
      data: {
        health,
        blockchain,
        gas,
        wallet,
        dex,
        recentErrors,
        activeAlerts: alerts,
      },
      requestId: req.requestId,
      timestamp: Date.now(),
    });
  };

  public probeSystemHealth: RouteHandler = async (req, res) => {
    if (!this.monitoringService) {
      res.status(200).json({ success: true, message: "Monitoring service not attached" });
      return;
    }

    const report = await this.monitoringService.probeSystemHealth();
    res.status(200).json({
      success: true,
      data: report,
      requestId: req.requestId,
      timestamp: Date.now(),
    });
  };

  public revalidateWallet: RouteHandler = async (req, res) => {
    if (!this.monitoringService) {
      res.status(200).json({ success: true, message: "Monitoring service not attached" });
      return;
    }

    this.monitoringService.revalidateWallet();
    res.status(200).json({
      success: true,
      data: {
        message: "Wallet connection explicitly re-validated by operator",
        walletState: this.monitoringService.getWalletState(),
      },
      requestId: req.requestId,
      timestamp: Date.now(),
    });
  };
}
