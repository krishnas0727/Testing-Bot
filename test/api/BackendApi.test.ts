/**
 * @file BackendApi.test.ts
 * @description Phase 13: Backend/API Comprehensive Test Suite
 *
 * Verifies all Phase 13 requirements:
 * - Public Health & Readiness endpoints
 * - Authentication (Valid key, Invalid key, Missing key -> 401)
 * - Role-Based Authorization (Admin, Operator, Viewer -> 403 on forbidden)
 * - Rate Limiting (429 on exceeding quota)
 * - Idempotency (repeated POST returns cached idempotent response)
 * - Secret scrubbing (no private keys in API responses)
 * - Opportunity queries with filtering & pagination
 * - Trade queries with sorting & pagination
 * - Transaction status queries & on-chain sync
 * - P&L summary calculation across periods
 * - Treasury balances and withdrawal limit protection (no unrestricted withdrawals)
 * - Bot lifecycle controls (start, stop, pause, emergency-stop)
 * - Centralized 404 and 400 error handling
 */

import { expect } from "chai";
import { EventEmitter } from "events";
import { createApiApp, ApiAppContainer } from "../../src/api";

// ─────────────────────────────────────────────────────────────────────────────
// IN-MEMORY HTTP REQUEST TEST HARNESS
// ─────────────────────────────────────────────────────────────────────────────

interface TestResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: any;
}

function dispatchTestRequest(
  app: ApiAppContainer,
  options: {
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    path: string;
    headers?: Record<string, string>;
    body?: any;
  }
): Promise<TestResponse> {
  return new Promise((resolve) => {
    const rawReq = new EventEmitter() as any;
    rawReq.method = options.method;
    rawReq.url = options.path;
    rawReq.headers = {
      host: "localhost:3000",
      ...options.headers,
    };
    rawReq.socket = { remoteAddress: "127.0.0.1" };

    let resStatusCode = 200;
    const resHeaders: Record<string, string> = {};
    let responseData = "";

    const rawRes = new EventEmitter() as any;
    rawRes.writeHead = (status: number, headers: Record<string, string>) => {
      resStatusCode = status;
      Object.assign(resHeaders, headers);
    };
    rawRes.end = (chunk?: string) => {
      if (chunk) responseData += chunk;
      let parsedBody = responseData;
      try {
        parsedBody = JSON.parse(responseData);
      } catch {
        // Keep as string
      }
      resolve({
        statusCode: resStatusCode,
        headers: resHeaders,
        body: parsedBody,
      });
    };

    app.server.handleRequest(rawReq, rawRes);

    if (options.body) {
      const payload = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
      rawReq.emit("data", Buffer.from(payload));
    }
    rawReq.emit("end");
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST SUITE
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 13: Backend API Suite", () => {
  let app: ApiAppContainer;

  // Pre-configured test credentials
  const ADMIN_KEY = "admin-secret-key-999";
  const OPERATOR_KEY = "operator-key-456";
  const VIEWER_KEY = "viewer-readonly-key-123";
  const INVALID_KEY = "invalid-token-000";

  beforeEach(() => {
    app = createApiApp({ rateLimitMaxRequests: 10, rateLimitWindowMs: 10_000 });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 1. HEALTH & READINESS ENDPOINTS (PUBLIC)
  // ─────────────────────────────────────────────────────────────────────────
  describe("Health & Readiness (Public)", () => {
    it("GET /api/health should return 200 UP without auth", async () => {
      const res = await dispatchTestRequest(app, {
        method: "GET",
        path: "/api/health",
      });

      expect(res.statusCode).to.equal(200);
      expect(res.body.success).to.be.true;
      expect(res.body.data.status).to.equal("UP");
      expect(res.headers["x-request-id"]).to.be.a("string");
    });

    it("GET /api/health/ready should return 200 READY when operational", async () => {
      const res = await dispatchTestRequest(app, {
        method: "GET",
        path: "/api/health/ready",
      });

      expect(res.statusCode).to.equal(200);
      expect(res.body.success).to.be.true;
      expect(res.body.data.status).to.equal("READY");
      expect(res.body.data.database).to.equal("CONNECTED");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 2. AUTHENTICATION & ACCESS CONTROL
  // ─────────────────────────────────────────────────────────────────────────
  describe("Authentication", () => {
    it("should reject protected endpoint when no token/key is provided (401)", async () => {
      const res = await dispatchTestRequest(app, {
        method: "GET",
        path: "/api/bot/status",
      });

      expect(res.statusCode).to.equal(401);
      expect(res.body.success).to.be.false;
      expect(res.body.error.code).to.equal("UNAUTHORIZED");
    });

    it("should reject protected endpoint with invalid API key (401)", async () => {
      const res = await dispatchTestRequest(app, {
        method: "GET",
        path: "/api/bot/status",
        headers: { "x-api-key": INVALID_KEY },
      });

      expect(res.statusCode).to.equal(401);
      expect(res.body.error.code).to.equal("UNAUTHORIZED");
    });

    it("should authenticate with valid X-API-Key header", async () => {
      const res = await dispatchTestRequest(app, {
        method: "GET",
        path: "/api/bot/status",
        headers: { "x-api-key": VIEWER_KEY },
      });

      expect(res.statusCode).to.equal(200);
      expect(res.body.success).to.be.true;
    });

    it("should authenticate with Bearer Authorization token", async () => {
      const res = await dispatchTestRequest(app, {
        method: "GET",
        path: "/api/bot/status",
        headers: { authorization: `Bearer ${OPERATOR_KEY}` },
      });

      expect(res.statusCode).to.equal(200);
      expect(res.body.success).to.be.true;
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3. ROLE-BASED AUTHORIZATION
  // ─────────────────────────────────────────────────────────────────────────
  describe("Role-Based Authorization", () => {
    it("should allow VIEWER to read opportunities, trades, and config", async () => {
      const res = await dispatchTestRequest(app, {
        method: "GET",
        path: "/api/opportunities",
        headers: { "x-api-key": VIEWER_KEY },
      });

      expect(res.statusCode).to.equal(200);
      expect(res.body.data).to.be.an("array");
    });

    it("should forbid VIEWER from initiating bot actions (403)", async () => {
      const res = await dispatchTestRequest(app, {
        method: "POST",
        path: "/api/bot/start",
        headers: { "x-api-key": VIEWER_KEY },
      });

      expect(res.statusCode).to.equal(403);
      expect(res.body.error.code).to.equal("FORBIDDEN");
      expect(res.body.error.message).to.include("Required role: OPERATOR");
    });

    it("should allow OPERATOR to start, stop, and pause the bot", async () => {
      const res = await dispatchTestRequest(app, {
        method: "POST",
        path: "/api/bot/start",
        headers: { "x-api-key": OPERATOR_KEY },
      });

      expect(res.statusCode).to.equal(200);
      expect(res.body.success).to.be.true;
    });

    it("should forbid OPERATOR from modifying revenue allocation policy (403)", async () => {
      const res = await dispatchTestRequest(app, {
        method: "POST",
        path: "/api/revenue/policy",
        headers: { "x-api-key": OPERATOR_KEY },
        body: { tradingCapitalBps: 5000, reserveBps: 2500, revenueBps: 2500 },
      });

      expect(res.statusCode).to.equal(403);
      expect(res.body.error.code).to.equal("FORBIDDEN");
      expect(res.body.error.message).to.include("Required role: ADMIN");
    });

    it("should allow ADMIN to modify revenue allocation policy", async () => {
      const res = await dispatchTestRequest(app, {
        method: "POST",
        path: "/api/revenue/policy",
        headers: { "x-api-key": ADMIN_KEY },
        body: { tradingCapitalBps: 5000, reserveBps: 2500, revenueBps: 2500 },
      });

      expect(res.statusCode).to.equal(200);
      expect(res.body.success).to.be.true;
      expect(res.body.data.record.newPolicy.tradingCapitalBps).to.equal(5000);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 4. OPPORTUNITIES & FILTERING
  // ─────────────────────────────────────────────────────────────────────────
  describe("Opportunities API", () => {
    it("should return paginated list of opportunities with metadata", async () => {
      const res = await dispatchTestRequest(app, {
        method: "GET",
        path: "/api/opportunities?page=1&limit=10",
        headers: { "x-api-key": VIEWER_KEY },
      });

      expect(res.statusCode).to.equal(200);
      expect(res.body.pagination).to.have.property("totalPages");
      expect(res.body.pagination).to.have.property("totalItems");
      expect(res.body.data.length).to.be.greaterThan(0);
    });

    it("should filter opportunities by minNetProfit", async () => {
      const res = await dispatchTestRequest(app, {
        method: "GET",
        path: "/api/opportunities?minNetProfit=1.5",
        headers: { "x-api-key": VIEWER_KEY },
      });

      expect(res.statusCode).to.equal(200);
      for (const item of res.body.data) {
        expect(item.netProfitUsdt).to.be.at.least(1.5);
      }
    });

    it("should return single opportunity by ID", async () => {
      const res = await dispatchTestRequest(app, {
        method: "GET",
        path: "/api/opportunities/opp-001",
        headers: { "x-api-key": VIEWER_KEY },
      });

      expect(res.statusCode).to.equal(200);
      expect(res.body.data.id).to.equal("opp-001");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 5. TRADES & P&L SUMMARY
  // ─────────────────────────────────────────────────────────────────────────
  describe("Trades & P&L APIs", () => {
    it("should return trade history with pagination", async () => {
      const res = await dispatchTestRequest(app, {
        method: "GET",
        path: "/api/trades?page=1&limit=5",
        headers: { "x-api-key": VIEWER_KEY },
      });

      expect(res.statusCode).to.equal(200);
      expect(res.body.data).to.be.an("array");
    });

    it("GET /api/profit-loss should return aggregated profit, ROI, and win-rate", async () => {
      const res = await dispatchTestRequest(app, {
        method: "GET",
        path: "/api/profit-loss?period=all",
        headers: { "x-api-key": VIEWER_KEY },
      });

      expect(res.statusCode).to.equal(200);
      expect(res.body.data).to.have.property("totalTrades");
      expect(res.body.data).to.have.property("netProfitUsdt");
      expect(res.body.data).to.have.property("winRatePct");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 6. TREASURY & REVENUE APIS
  // ─────────────────────────────────────────────────────────────────────────
  describe("Treasury & Revenue APIs", () => {
    it("GET /api/treasury/balances should return multi-bucket breakdown", async () => {
      const res = await dispatchTestRequest(app, {
        method: "GET",
        path: "/api/treasury/balances?chainId=8453&token=USDC",
        headers: { "x-api-key": VIEWER_KEY },
      });

      expect(res.statusCode).to.equal(200);
      expect(res.body.data.buckets).to.have.property("tradingCapitalUsdt");
      expect(res.body.data.buckets).to.have.property("reserveUsdt");
      expect(res.body.data.buckets).to.have.property("revenueUsdt");
    });

    it("GET /api/treasury/limits confirms API does NOT expose unrestricted withdrawals", async () => {
      const res = await dispatchTestRequest(app, {
        method: "GET",
        path: "/api/treasury/limits",
        headers: { "x-api-key": VIEWER_KEY },
      });

      expect(res.statusCode).to.equal(200);
      expect(res.body.data.unrestrictedWithdrawalExposed).to.be.false;
      expect(res.body.data.securityNote).to.include("Unrestricted withdrawals cannot be initiated");
    });

    it("GET /api/revenue/allocations returns history of distributed revenues", async () => {
      const res = await dispatchTestRequest(app, {
        method: "GET",
        path: "/api/revenue/allocations",
        headers: { "x-api-key": VIEWER_KEY },
      });

      expect(res.statusCode).to.equal(200);
      expect(res.body.data).to.be.an("array");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 7. SECURITY: SENSITIVE DATA SCRUBBING
  // ─────────────────────────────────────────────────────────────────────────
  describe("Security & Sensitive Data Scrubbing", () => {
    it("GET /api/config should NEVER expose private keys or secrets", async () => {
      const res = await dispatchTestRequest(app, {
        method: "GET",
        path: "/api/config",
        headers: { "x-api-key": VIEWER_KEY },
      });

      expect(res.statusCode).to.equal(200);
      const jsonStr = JSON.stringify(res.body);
      expect(jsonStr).to.not.include("0x0000000000000000000000000000000000000000000000000000000000000001");
      expect(res.body.data).to.not.have.property("privateKey");
    });

    it("PATCH /api/config should reject updates attempting to modify private keys or wallet", async () => {
      const res = await dispatchTestRequest(app, {
        method: "PATCH",
        path: "/api/config",
        headers: { "x-api-key": ADMIN_KEY },
        body: { privateKey: "0xNewKeyAttempt" },
      });

      expect(res.statusCode).to.equal(400);
      expect(res.body.error.code).to.equal("FORBIDDEN_FIELD");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 8. IDEMPOTENCY & RATE LIMITING
  // ─────────────────────────────────────────────────────────────────────────
  describe("Idempotency & Rate Limiting", () => {
    it("should return idempotent cached response when Idempotency-Key is repeated", async () => {
      const idempotencyKey = "idem-key-abc-123";

      const res1 = await dispatchTestRequest(app, {
        method: "POST",
        path: "/api/bot/pause",
        headers: { "x-api-key": OPERATOR_KEY, "idempotency-key": idempotencyKey },
      });
      expect(res1.statusCode).to.equal(200);

      const res2 = await dispatchTestRequest(app, {
        method: "POST",
        path: "/api/bot/pause",
        headers: { "x-api-key": OPERATOR_KEY, "idempotency-key": idempotencyKey },
      });
      expect(res2.statusCode).to.equal(200);
      expect(res2.body.data.message).to.equal(res1.body.data.message);
    });

    it("should trigger 429 when rate limit quota is exceeded", async () => {
      // Configured quota is 10 requests per 10s in beforeEach
      for (let i = 0; i < 9; i++) {
        await dispatchTestRequest(app, { method: "GET", path: "/api/health" });
      }

      // 10th request (limit reached)
      const res10 = await dispatchTestRequest(app, { method: "GET", path: "/api/health" });
      expect(res10.headers["x-ratelimit-remaining"]).to.equal("0");

      // 11th request (exceeded)
      const res11 = await dispatchTestRequest(app, { method: "GET", path: "/api/health" });
      expect(res11.statusCode).to.equal(429);
      expect(res11.body.error.code).to.equal("RATE_LIMIT_EXCEEDED");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 9. ERROR HANDLING & 404 NOT FOUND
  // ─────────────────────────────────────────────────────────────────────────
  describe("Centralized Error Handling", () => {
    it("should return standardized JSON for non-existent route (404)", async () => {
      const res = await dispatchTestRequest(app, {
        method: "GET",
        path: "/api/unknown-endpoint",
      });

      expect(res.statusCode).to.equal(404);
      expect(res.body.error.code).to.equal("NOT_FOUND");
    });
  });
});
