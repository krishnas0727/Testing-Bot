/**
 * @file routes.ts
 * @description Phase 13: Central API Route Registrar
 *
 * Configures all routes, attaches role-based authorization guards,
 * and connects controllers with services.
 */

import { HttpServer } from "./framework/HttpServer";
import {
  requestIdMiddleware,
  corsMiddleware,
  securityHeadersMiddleware,
  createRateLimiter,
  authMiddleware,
  requireRole,
  idempotencyMiddleware,
} from "./framework/middleware";
import { DatabaseService } from "./services/DatabaseService";
import { BlockchainSyncService } from "./services/BlockchainSyncService";
import { BotControlService } from "./services/BotControlService";
import { RevenueDistributionEngine } from "../distribution";

import { HealthController } from "./controllers/HealthController";
import { BotController } from "./controllers/BotController";
import { OpportunityController } from "./controllers/OpportunityController";
import { TradeController } from "./controllers/TradeController";
import { TransactionController } from "./controllers/TransactionController";
import { ProfitLossController } from "./controllers/ProfitLossController";
import { TreasuryController } from "./controllers/TreasuryController";
import { RevenueController } from "./controllers/RevenueController";
import { ConfigController } from "./controllers/ConfigController";
import { AlertsController } from "./controllers/AlertsController";

import { TradeExecutionService } from "./services/TradeExecutionService";
import { MainnetLaunchService } from "./services/MainnetLaunchService";
import { ProductionMonitoringService } from "../monitoring/ProductionMonitoringService";
import { ExecutionModeService } from "../execution/ExecutionModeService";

export interface ApiAppContainer {
  server: HttpServer;
  dbService: DatabaseService;
  syncService: BlockchainSyncService;
  botService: BotControlService;
  distributionEngine: RevenueDistributionEngine;
  tradeExecutionService: TradeExecutionService;
  mainnetLaunchService: MainnetLaunchService;
  monitoringService: ProductionMonitoringService;
  executionModeService: ExecutionModeService;
}

export function createApiApp(options?: {
  rateLimitMaxRequests?: number;
  rateLimitWindowMs?: number;
}): ApiAppContainer {
  const server = new HttpServer();
  const dbService = new DatabaseService();
  const syncService = new BlockchainSyncService(dbService);
  const botService = new BotControlService();
  const distributionEngine = new RevenueDistributionEngine();
  const monitoringService = new ProductionMonitoringService(dbService, botService, syncService);
  const tradeExecutionService = new TradeExecutionService(
    dbService,
    botService,
    syncService,
    distributionEngine,
    monitoringService
  );
  const mainnetLaunchService = new MainnetLaunchService(
    dbService,
    syncService,
    botService,
    distributionEngine,
    tradeExecutionService
  );
  const executionModeService = new ExecutionModeService(
    dbService,
    botService,
    syncService,
    distributionEngine,
    tradeExecutionService
  );

  // Instantiate controllers
  const healthCtrl = new HealthController(botService, dbService, monitoringService);
  const botCtrl = new BotController(botService, dbService);
  const oppCtrl = new OpportunityController(dbService);
  const tradeCtrl = new TradeController(dbService, tradeExecutionService);
  const txCtrl = new TransactionController(dbService, syncService);
  const pnlCtrl = new ProfitLossController(dbService);
  const treasuryCtrl = new TreasuryController(syncService);
  const revenueCtrl = new RevenueController(dbService, distributionEngine);
  const configCtrl = new ConfigController();
  const alertsCtrl = new AlertsController(dbService);

  // Global Middlewares
  server.use(requestIdMiddleware);
  server.use(corsMiddleware);
  server.use(securityHeadersMiddleware);
  server.use(
    createRateLimiter({
      maxRequests: options?.rateLimitMaxRequests || 100,
      windowMs: options?.rateLimitWindowMs || 60_000,
    })
  );
  server.use(idempotencyMiddleware);
  server.use(authMiddleware);

  // ─────────────────────────────────────────────────────────────────────────
  // STATIC DASHBOARD SPA ASSETS (PHASE 14)
  // ─────────────────────────────────────────────────────────────────────────
  const fs = require("fs");
  const path = require("path");

  const serveStatic = (fileName: string, contentType: string) => async (_req: any, res: any) => {
    try {
      const candidates = [
        path.join(__dirname, "../../public", fileName),
        path.join(process.cwd(), "public", fileName),
      ];
      let content = "";
      for (const p of candidates) {
        if (fs.existsSync(p)) {
          content = fs.readFileSync(p, "utf-8");
          break;
        }
      }
      if (!content) {
        res.status(404).send("File not found");
        return;
      }
      res.status(200).send(content, contentType);
    } catch (err: any) {
      res.status(500).send(`Error reading file: ${err.message}`);
    }
  };

  server.get("/", serveStatic("index.html", "text/html"));
  server.get("/dashboard", serveStatic("index.html", "text/html"));
  server.get("/style.css", serveStatic("style.css", "text/css"));
  server.get("/app.js", serveStatic("app.js", "application/javascript"));

  // 1. Health & Readiness (Public)
  server.get("/api/health", healthCtrl.getLiveness);
  server.get("/api/health/ready", healthCtrl.getReadiness);

  // 2. Bot Controls (Requires OPERATOR or ADMIN)
  server.get("/api/bot/status", requireRole("VIEWER"), botCtrl.getStatus);
  server.post("/api/bot/start", requireRole("OPERATOR"), botCtrl.startBot);
  server.post("/api/bot/stop", requireRole("OPERATOR"), botCtrl.stopBot);
  server.post("/api/bot/pause", requireRole("OPERATOR"), botCtrl.pauseBot);
  server.post("/api/bot/emergency-stop", requireRole("OPERATOR"), botCtrl.emergencyStop);

  // 3. Opportunities (Requires VIEWER)
  server.get("/api/opportunities", requireRole("VIEWER"), oppCtrl.getOpportunities);
  server.get("/api/opportunities/:id", requireRole("VIEWER"), oppCtrl.getOpportunityById);

  // 4. Trades (Requires VIEWER; Execute requires OPERATOR)
  server.get("/api/trades", requireRole("VIEWER"), tradeCtrl.getTrades);
  server.get("/api/trades/:id", requireRole("VIEWER"), tradeCtrl.getTradeById);
  server.post("/api/trades/execute", requireRole("OPERATOR"), tradeCtrl.executeTrade);

  // 5. Transactions (Requires VIEWER; Sync requires OPERATOR)
  server.get("/api/transactions", requireRole("VIEWER"), txCtrl.getTransactions);
  server.get("/api/transactions/:hash", requireRole("VIEWER"), txCtrl.getTransactionByHash);
  server.post("/api/transactions/:hash/sync", requireRole("OPERATOR"), txCtrl.syncTransaction);

  // 6. Profit & Loss (Requires VIEWER)
  server.get("/api/profit-loss", requireRole("VIEWER"), pnlCtrl.getProfitLoss);

  // 7. Treasury & Non-Custodial User Accounting
  server.get("/api/treasury/balances", requireRole("VIEWER"), treasuryCtrl.getBalances);
  server.get("/api/treasury/limits", requireRole("VIEWER"), treasuryCtrl.getWithdrawalLimits);
  server.get("/api/treasury/user-balance", requireRole("VIEWER"), treasuryCtrl.getUserBalance);
  server.post("/api/treasury/settle-profit", requireRole("OPERATOR"), treasuryCtrl.settleProfit);
  server.post("/api/treasury/prepare-withdrawal", requireRole("VIEWER"), treasuryCtrl.prepareWithdrawal);
  server.post("/api/treasury/confirm-withdrawal", requireRole("VIEWER"), treasuryCtrl.confirmWithdrawal);
  server.post("/api/treasury/deposit", requireRole("VIEWER"), treasuryCtrl.recordDeposit);

  // 8. Revenue (Requires VIEWER; Policy Update requires ADMIN)
  server.get("/api/revenue/allocations", requireRole("VIEWER"), revenueCtrl.getAllocations);
  server.get("/api/revenue/policy", requireRole("VIEWER"), revenueCtrl.getPolicy);
  server.post("/api/revenue/policy", requireRole("ADMIN"), revenueCtrl.updatePolicy);

  // 9. Config (Requires VIEWER; Update requires ADMIN)
  server.get("/api/config", requireRole("VIEWER"), configCtrl.getConfig);
  server.patch("/api/config", requireRole("ADMIN"), configCtrl.updateConfig);

  // 10. Alerts (Requires VIEWER; Resolve requires OPERATOR)
  server.get("/api/alerts", requireRole("VIEWER"), alertsCtrl.getAlerts);
  server.post("/api/alerts/:id/resolve", requireRole("OPERATOR"), alertsCtrl.resolveAlert);

  // 11. Mainnet Readiness & Rollback (Phase 22)
  server.get("/api/mainnet/readiness", requireRole("VIEWER"), async (req, res) => {
    const chainId = req.query.chainId ? parseInt(req.query.chainId, 10) : 8453;
    const report = await mainnetLaunchService.verifyMainnetReadiness(chainId);
    res.status(200).json({
      success: true,
      data: report,
      requestId: req.requestId,
      timestamp: Date.now(),
    });
  });

  server.post("/api/mainnet/rollback", requireRole("OPERATOR"), async (req, res) => {
    const rollback = mainnetLaunchService.triggerEmergencyRollback();
    res.status(200).json({
      success: true,
      data: rollback,
      requestId: req.requestId,
      timestamp: Date.now(),
    });
  });

  // 12. Production Monitoring & Telemetry (Phase 23)
  server.get("/api/monitoring/status", requireRole("VIEWER"), healthCtrl.getMonitoringStatus);
  server.post("/api/monitoring/probe", requireRole("OPERATOR"), healthCtrl.probeSystemHealth);
  server.post("/api/monitoring/wallet/revalidate", requireRole("OPERATOR"), healthCtrl.revalidateWallet);

  // 13. Execution Modes: User-Signed vs Automated (Phase 24)
  server.get("/api/execution/mode", requireRole("VIEWER"), async (req, res) => {
    res.status(200).json({
      success: true,
      data: executionModeService.getStatusSnapshot(),
      requestId: req.requestId,
      timestamp: Date.now(),
    });
  });

  server.post("/api/execution/mode", requireRole("OPERATOR"), async (req, res) => {
    try {
      executionModeService.setActiveMode(req.body.mode);
      res.status(200).json({
        success: true,
        data: executionModeService.getStatusSnapshot(),
        requestId: req.requestId,
        timestamp: Date.now(),
      });
    } catch (err: any) {
      res.status(400).json({
        success: false,
        error: { code: "MODE_SWITCH_ERROR", message: err.message },
        requestId: req.requestId,
        timestamp: Date.now(),
      });
    }
  });

  server.get("/api/execution/automated/config", requireRole("VIEWER"), async (req, res) => {
    res.status(200).json({
      success: true,
      data: executionModeService.getAutomatedConfig(),
      requestId: req.requestId,
      timestamp: Date.now(),
    });
  });

  server.patch("/api/execution/automated/config", requireRole("ADMIN"), async (req, res) => {
    const updated = executionModeService.updateAutomatedConfig(req.body);
    res.status(200).json({
      success: true,
      data: updated,
      requestId: req.requestId,
      timestamp: Date.now(),
    });
  });

  server.post("/api/execution/automated/pause", requireRole("OPERATOR"), async (req, res) => {
    executionModeService.pauseAutomatedExecutor();
    res.status(200).json({
      success: true,
      data: { message: "Automated executor paused", status: executionModeService.getStatusSnapshot().automated },
      requestId: req.requestId,
      timestamp: Date.now(),
    });
  });

  server.post("/api/execution/automated/resume", requireRole("OPERATOR"), async (req, res) => {
    try {
      executionModeService.resumeAutomatedExecutor();
      res.status(200).json({
        success: true,
        data: { message: "Automated executor resumed", status: executionModeService.getStatusSnapshot().automated },
        requestId: req.requestId,
        timestamp: Date.now(),
      });
    } catch (err: any) {
      res.status(400).json({
        success: false,
        error: { code: "RESUME_FAILED", message: err.message },
        requestId: req.requestId,
        timestamp: Date.now(),
      });
    }
  });

  server.post("/api/execution/automated/emergency-stop", requireRole("OPERATOR"), async (req, res) => {
    executionModeService.tripAutomatedEmergencyStop(req.body?.reason || "Operator triggered emergency stop");
    res.status(200).json({
      success: true,
      data: { message: "Automated emergency stop tripped", status: executionModeService.getStatusSnapshot().automated },
      requestId: req.requestId,
      timestamp: Date.now(),
    });
  });

  server.post("/api/trades/prepare-user-signed", requireRole("VIEWER"), async (req, res) => {
    try {
      const summary = await executionModeService.prepareUserSignedTrade(req.body);
      res.status(200).json({
        success: true,
        data: summary,
        requestId: req.requestId,
        timestamp: Date.now(),
      });
    } catch (err: any) {
      res.status(400).json({
        success: false,
        error: { code: "PREPARE_FAILED", message: err.message },
        requestId: req.requestId,
        timestamp: Date.now(),
      });
    }
  });

  server.post("/api/trades/confirm-user-signed", requireRole("OPERATOR"), async (req, res) => {
    try {
      const trade = executionModeService.recordUserSignedTradeResult(req.body);
      res.status(200).json({
        success: true,
        data: trade,
        requestId: req.requestId,
        timestamp: Date.now(),
      });
    } catch (err: any) {
      res.status(400).json({
        success: false,
        error: { code: "CONFIRM_FAILED", message: err.message },
        requestId: req.requestId,
        timestamp: Date.now(),
      });
    }
  });

  server.post("/api/trades/execute-automated", requireRole("OPERATOR"), async (req, res) => {
    try {
      const result = await executionModeService.executeAutomatedTrade(req.body);
      res.status(result.success ? 200 : 403).json({
        success: result.success,
        data: result,
        requestId: req.requestId,
        timestamp: Date.now(),
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        error: { code: "AUTOMATED_EXECUTION_FAILED", message: err.message },
        requestId: req.requestId,
        timestamp: Date.now(),
      });
    }
  });

  return {
    server,
    dbService,
    syncService,
    botService,
    distributionEngine,
    tradeExecutionService,
    mainnetLaunchService,
    monitoringService,
    executionModeService,
  };
}
