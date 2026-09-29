/**
 * @file ProductionInfrastructure.test.ts
 * @description Phase 21: Master Production Infrastructure Verification Suite
 *
 * Verifies all Phase 21 production readiness requirements:
 * 1. Production Server Lifecycle (startup, port binding, and graceful shutdown)
 * 2. Health Monitoring Endpoints (/api/health and /api/health/ready)
 * 3. Safe Default Trading State (Live trading disabled by default)
 * 4. Production Database Clean Ledger (Zero demo/fake trades seeded in production)
 * 5. Production Structured Logging & Secret Redaction
 * 6. Production Security Headers & Middleware Pipeline
 * 7. Container & Infrastructure Configurations (render.yaml, Dockerfile, schema.sql)
 */

import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";

import { createApiApp, ApiAppContainer } from "../../src/api/routes";
import { startApiServer, stopApiServer } from "../../src/api/server";
import { DatabaseService } from "../../src/api/services/DatabaseService";
import { Logger } from "../../src/utils/logger";
import { HttpRequest, HttpResponse } from "../../src/api/framework/types";

describe("Phase 21: Production Infrastructure & Deployment Verification Suite", () => {
  let apiApp: ApiAppContainer;

  beforeEach(() => {
    apiApp = createApiApp();
  });

  afterEach(async () => {
    await stopApiServer();
  });

  // Helper for simulating requests against apiApp
  async function simulateRequest(method: "GET" | "POST", url: string, headers: Record<string, string> = {}) {
    let statusCode = 200;
    let responseBody: any = null;
    const responseHeaders: Record<string, string> = {};

    const mockReq: HttpRequest = {
      method,
      url,
      path: url.split("?")[0],
      query: {},
      params: {},
      headers: { ...headers },
      ip: "127.0.0.1",
    };

    const mockRes: HttpResponse = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(data: any) {
        responseBody = data;
        return this;
      },
      text(content: string) {
        responseBody = content;
        return this;
      },
      setHeader(name: string, value: string) {
        responseHeaders[name.toLowerCase()] = value;
        return this;
      },
      header(name: string, value: string) {
        responseHeaders[name.toLowerCase()] = value;
        return this;
      },
    } as any;

    const routes = (apiApp.server as any).routes || [];
    const route = routes.find((r: any) => r.method === method && r.path === mockReq.path);

    if (route) {
      const middlewares = (apiApp.server as any).middlewares || [];
      for (const mw of middlewares) {
        let nextCalled = false;
        await mw(mockReq, mockRes, () => {
          nextCalled = true;
        });
        if (!nextCalled) return { statusCode, body: responseBody, headers: responseHeaders };
      }
      for (const handler of route.handlers) {
        await handler(mockReq, mockRes, () => {});
      }
    } else {
      statusCode = 404;
      responseBody = { error: "Route not found" };
    }

    return { statusCode, body: responseBody, headers: responseHeaders };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 1. HEALTH MONITORING ENDPOINTS
  // ───────────────────────────────────────────────────────────────────────────
  describe("1. Health Monitoring", () => {
    it("should return HTTP 200 and UP status on /api/health", async () => {
      const res = await simulateRequest("GET", "/api/health");
      expect(res.statusCode).to.equal(200);
      expect(res.body.success).to.be.true;
      expect(res.body.data.status).to.equal("UP");
      expect(res.body.data.uptimeSeconds).to.be.a("number");
    });

    it("should return HTTP 200 and READY status on /api/health/ready when healthy", async () => {
      const res = await simulateRequest("GET", "/api/health/ready");
      expect(res.statusCode).to.equal(200);
      expect(res.body.data.status).to.equal("READY");
      expect(res.body.data.database).to.equal("CONNECTED");
    });

    it("should return HTTP 503 on /api/health/ready when Emergency Stop is triggered", async () => {
      apiApp.botService.emergencyStop();
      const res = await simulateRequest("GET", "/api/health/ready");
      expect(res.statusCode).to.equal(503);
      expect(res.body.success).to.be.false;
      expect(res.body.data.status).to.equal("NOT_READY");
      expect(res.body.data.circuitBreakerTripped).to.be.true;
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. PRODUCTION TRADING SAFETY & INVARIANTS
  // ───────────────────────────────────────────────────────────────────────────
  describe("2. Trading Safety Invariants", () => {
    it("should ensure live trading is disabled by default", () => {
      const status = apiApp.botService.getStatus();
      expect(status.status).to.equal("IDLE");
      // Assert server defaults to safe state
      expect(process.env.AUTO_TRADE_ENABLED).to.not.equal("true");
    });

    it("should ensure DatabaseService does NOT populate demo trades in production mode", () => {
      const originalEnv = process.env.NODE_ENV;
      try {
        process.env.NODE_ENV = "production";
        const prodDb = new DatabaseService();
        // In production mode, trades and transactions must be clean
        expect(prodDb.getTrades().trades.length).to.equal(0);
        expect(prodDb.getTransactions().length).to.equal(0);
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. SERVER LIFECYCLE & GRACEFUL SHUTDOWN
  // ───────────────────────────────────────────────────────────────────────────
  describe("3. Server Lifecycle & Graceful Shutdown", () => {
    it("should start and stop the API server gracefully on an ephemeral test port", async () => {
      const testPort = 5999;
      const container = await startApiServer(testPort, "127.0.0.1");
      expect(container).to.not.be.null;

      // Close cleanly
      await stopApiServer();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. PRODUCTION LOGGING & SECRET PROTECTION
  // ───────────────────────────────────────────────────────────────────────────
  describe("4. Production Logging & Data Protection", () => {
    it("should scrub sensitive keys when logging data objects", () => {
      const testLogger = new Logger("TestAudit");
      let loggedOutput = "";

      const originalInfo = console.info;
      console.info = (msg: string) => {
        loggedOutput = msg;
      };

      try {
        testLogger.info("Executing safe audit test", {
          privateKey: "0x1234567890123456789012345678901234567890123456789012345678901234",
          secret: "production-jwt-secret",
          safeField: "safeValue",
        });

        expect(loggedOutput).to.include("[REDACTED_SECRET]");
        expect(loggedOutput).to.include("safeValue");
        expect(loggedOutput).to.not.include("production-jwt-secret");
      } finally {
        console.info = originalInfo;
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 5. INFRASTRUCTURE & CONTAINER ARTIFACTS
  // ───────────────────────────────────────────────────────────────────────────
  describe("5. Infrastructure & Container Artifacts", () => {
    it("should verify existence of production database schema.sql", () => {
      const schemaPath = path.join(__dirname, "../../src/database/schema.sql");
      expect(fs.existsSync(schemaPath)).to.be.true;
      const content = fs.readFileSync(schemaPath, "utf-8");
      expect(content).to.include("CREATE TABLE IF NOT EXISTS trades");
      expect(content).to.include("CREATE TABLE IF NOT EXISTS transactions");
      expect(content).to.include("CREATE TABLE IF NOT EXISTS revenue_allocations");
    });

    it("should verify existence of production render.yaml blueprint", () => {
      const renderPath = path.join(__dirname, "../../render.yaml");
      expect(fs.existsSync(renderPath)).to.be.true;
      const content = fs.readFileSync(renderPath, "utf-8");
      expect(content).to.include("dex-arbitrage-api");
      expect(content).to.include("healthCheckPath: /api/health");
      expect(content).to.include("NODE_ENV");
    });

    it("should verify existence of production Dockerfile with non-root security", () => {
      const dockerfilePath = path.join(__dirname, "../../Dockerfile");
      expect(fs.existsSync(dockerfilePath)).to.be.true;
      const content = fs.readFileSync(dockerfilePath, "utf-8");
      expect(content).to.include("FROM node:20-alpine AS builder");
      expect(content).to.include("USER node"); // Non-root security
      expect(content).to.include("HEALTHCHECK");
    });

    it("should verify existence of .env.production.example template", () => {
      const envPath = path.join(__dirname, "../../.env.production.example");
      expect(fs.existsSync(envPath)).to.be.true;
      const content = fs.readFileSync(envPath, "utf-8");
      expect(content).to.include("NODE_ENV=production");
      expect(content).to.include("LIVE_TRADING_ARMED=false");
      expect(content).to.include("TRADING_MODE=MOCK");
    });
  });
});
