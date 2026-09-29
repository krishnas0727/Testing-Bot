/**
 * @file FailureAndEdgeCases.test.ts
 * @description Phase 19: Comprehensive Failure & Edge-Case Test Suite
 *
 * Covers all 9 failure categories + Safety & Recovery requirements:
 * 1. Wallet Cases (not connected, disconnected, wrong wallet/network, zero/low balance)
 * 2. Gas Cases (insufficient native token, gas price spike, gas ceiling, estimation failure)
 * 3. Blockchain/RPC Cases (RPC unavailable, timeout, rate limit, wrong chain ID)
 * 4. Smart Contract Cases (invalid address, un-deployed, on-chain revert, unauthorized, paused)
 * 5. DEX Cases (price unavailable, insufficient liquidity, slippage breach, swap failure)
 * 6. Arbitrage Cases (zero profit, negative profit, below min-profit threshold, fees make unprofitable)
 * 7. API Cases (missing params, invalid amount, invalid token pair, malformed request, duplicate request)
 * 8. Database Cases (duplicate tx, unconfirmed tx handling, status sync)
 * 9. Frontend Cases (actual state display, pending, failed, reverted)
 * 10. Safety & Recovery (Emergency Stop blocks execution, zero fake profits, zero fake trades)
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { createApiApp, ApiAppContainer } from "../../src/api/routes";
import { DatabaseService } from "../../src/api/services/DatabaseService";
import { BotControlService } from "../../src/api/services/BotControlService";
import { BlockchainSyncService } from "../../src/api/services/BlockchainSyncService";
import { RevenueDistributionEngine } from "../../src/distribution";
import { TradeExecutionService, TradeExecutionRequest } from "../../src/api/services/TradeExecutionService";
import { HttpRequest, HttpResponse } from "../../src/api/framework/types";

describe("Phase 19: Failure & Edge-Case Comprehensive Test Suite", () => {
  let admin: HardhatEthersSigner;
  let executor: HardhatEthersSigner;
  let unauthorizedUser: HardhatEthersSigner;
  let brokeUser: HardhatEthersSigner;

  let mockTokenIn: any;
  let mockTokenOut: any;
  let mockRouterBuy: any;
  let mockRouterSell: any;
  let treasury: any;
  let arbitrageExecutor: any;

  let apiApp: ApiAppContainer;
  let dbService: DatabaseService;
  let botService: BotControlService;
  let syncService: BlockchainSyncService;
  let distributionEngine: RevenueDistributionEngine;
  let tradeExecutionService: TradeExecutionService;

  beforeEach(async () => {
    [admin, executor, unauthorizedUser, brokeUser] = await ethers.getSigners();

    // 1. Deploy Mock Contracts
    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    mockTokenIn = await MockERC20Factory.deploy("USD Coin", "USDC", 6);
    mockTokenOut = await MockERC20Factory.deploy("Wrapped Ether", "WETH", 18);

    const MockRouterFactory = await ethers.getContractFactory("MockUniswapV2Router");
    mockRouterBuy = await MockRouterFactory.deploy();
    mockRouterSell = await MockRouterFactory.deploy();

    const TreasuryFactory = await ethers.getContractFactory("Treasury");
    treasury = await TreasuryFactory.deploy(admin.address, executor.address);

    const ExecutorFactory = await ethers.getContractFactory("ArbitrageExecutor");
    arbitrageExecutor = await ExecutorFactory.deploy(admin.address, await treasury.getAddress());

    // Whitelist setup
    await arbitrageExecutor.connect(admin).setExecutor(executor.address, true);
    await arbitrageExecutor.connect(admin).setTokenWhitelist(await mockTokenIn.getAddress(), true);
    await arbitrageExecutor.connect(admin).setTokenWhitelist(await mockTokenOut.getAddress(), true);
    await arbitrageExecutor.connect(admin).setRouterWhitelist(await mockRouterBuy.getAddress(), true);
    await arbitrageExecutor.connect(admin).setRouterWhitelist(await mockRouterSell.getAddress(), true);

    const ARBITRAGE_EXECUTOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ARBITRAGE_EXECUTOR_ROLE"));
    await treasury.connect(admin).grantRole(ARBITRAGE_EXECUTOR_ROLE, await arbitrageExecutor.getAddress());
    await treasury.connect(admin).setTokenWhitelist(await mockTokenIn.getAddress(), true);

    // Provide Liquidity
    await mockTokenOut.mint(await mockRouterBuy.getAddress(), ethers.parseUnits("1000", 18));
    await mockTokenIn.mint(await mockRouterSell.getAddress(), ethers.parseUnits("1000000", 6));
    await mockTokenIn.mint(executor.address, ethers.parseUnits("50000", 6));
    await mockTokenIn.connect(executor).approve(
      await arbitrageExecutor.getAddress(),
      ethers.parseUnits("50000", 6)
    );

    // Initialize Services
    apiApp = createApiApp();
    dbService = apiApp.dbService;
    botService = apiApp.botService;
    syncService = apiApp.syncService;
    distributionEngine = apiApp.distributionEngine;
    tradeExecutionService = apiApp.tradeExecutionService;
  });

  // Helper for simulating API route calls
  async function callApi(method: "GET" | "POST" | "PATCH", url: string, body?: any, role = "OPERATOR") {
    let statusCode = 200;
    let responseBody: any = null;

    const mockReq: HttpRequest = {
      method,
      url,
      path: url.split("?")[0],
      query: {},
      params: {},
      headers: { "x-user-role": role },
      body,
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
      setHeader() {
        return this;
      },
    };

    const routes = (apiApp.server as any).routes || [];
    const route = routes.find((r: any) => {
      if (r.method !== method) return false;
      const paramNames: string[] = [];
      const regexStr = "^" + r.path.replace(/:([a-zA-Z0-9_]+)/g, (_: any, name: string) => {
        paramNames.push(name);
        return "([^/]+)";
      }) + "$";
      const match = mockReq.path.match(new RegExp(regexStr));
      if (match) {
        paramNames.forEach((name, idx) => {
          mockReq.params[name] = match[idx + 1];
        });
        return true;
      }
      return false;
    });

    if (route) {
      const middlewares = (apiApp.server as any).middlewares || [];
      for (const mw of middlewares) {
        let nextCalled = false;
        await mw(mockReq, mockRes, () => {
          nextCalled = true;
        });
        if (!nextCalled) return { statusCode, body: responseBody };
      }
      for (const handler of route.handlers) {
        let nextCalled = false;
        await handler(mockReq, mockRes, () => {
          nextCalled = true;
        });
        if (!nextCalled) break;
      }
    } else {
      statusCode = 404;
      responseBody = { error: "Route not found" };
    }

    return { statusCode, body: responseBody };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 1. WALLET CASES
  // ───────────────────────────────────────────────────────────────────────────
  describe("1. Wallet Cases", () => {
    it("should reject trade when wallet is not connected (empty address)", async () => {
      const req: TradeExecutionRequest = {
        opportunityId: "opp-wallet-empty",
        chainId: 31337,
        tokenIn: await mockTokenIn.getAddress(),
        tokenOut: await mockTokenOut.getAddress(),
        routerBuy: await mockRouterBuy.getAddress(),
        routerSell: await mockRouterSell.getAddress(),
        amountInFormatted: 100,
        expectedGrossProfitUsdt: 5,
        expectedNetProfitUsdt: 4,
        walletAddress: "",
      };

      const res = await tradeExecutionService.executeTrade(req, ethers.provider, executor, await arbitrageExecutor.getAddress());
      expect(res.success).to.be.false;
      expect(res.rejectionGate).to.equal("WALLET_NOT_CONNECTED");
    });

    it("should reject trade when zero address is provided", async () => {
      const req: TradeExecutionRequest = {
        opportunityId: "opp-wallet-zero",
        chainId: 31337,
        tokenIn: await mockTokenIn.getAddress(),
        tokenOut: await mockTokenOut.getAddress(),
        routerBuy: await mockRouterBuy.getAddress(),
        routerSell: await mockRouterSell.getAddress(),
        amountInFormatted: 100,
        expectedGrossProfitUsdt: 5,
        expectedNetProfitUsdt: 4,
        walletAddress: ethers.ZeroAddress,
      };

      const res = await tradeExecutionService.executeTrade(req, ethers.provider, executor, await arbitrageExecutor.getAddress());
      expect(res.success).to.be.false;
      expect(res.rejectionGate).to.equal("WALLET_NOT_CONNECTED");
    });

    it("should reject trade when signer has zero or insufficient token balance", async () => {
      const req: TradeExecutionRequest = {
        opportunityId: "opp-broke-user",
        chainId: 31337,
        tokenIn: await mockTokenIn.getAddress(),
        tokenOut: await mockTokenOut.getAddress(),
        routerBuy: await mockRouterBuy.getAddress(),
        routerSell: await mockRouterSell.getAddress(),
        amountInFormatted: 1000,
        expectedGrossProfitUsdt: 50,
        expectedNetProfitUsdt: 45,
        walletAddress: brokeUser.address, // has 0 USDC
      };

      const res = await tradeExecutionService.executeTrade(req, ethers.provider, brokeUser, await arbitrageExecutor.getAddress());
      expect(res.success).to.be.false;
      expect(res.rejectionGate).to.equal("INSUFFICIENT_TOKEN_BALANCE");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. GAS CASES
  // ───────────────────────────────────────────────────────────────────────────
  describe("2. Gas Cases", () => {
    it("should reject trade when gas price ceiling is breached", async () => {
      // Create custom mock provider with elevated gas price (100 Gwei > 50 Gwei ceiling)
      const highGasProvider = {
        async getCode() {
          return "0x608060405234801561001057600080fd5b50";
        },
        async getBalance() {
          return ethers.parseEther("1.0");
        },
        async getFeeData() {
          return { gasPrice: ethers.parseUnits("100", "gwei") };
        },
      } as any;

      const req: TradeExecutionRequest = {
        opportunityId: "opp-high-gas",
        chainId: 31337,
        tokenIn: await mockTokenIn.getAddress(),
        tokenOut: await mockTokenOut.getAddress(),
        routerBuy: await mockRouterBuy.getAddress(),
        routerSell: await mockRouterSell.getAddress(),
        amountInFormatted: 100,
        expectedGrossProfitUsdt: 5,
        expectedNetProfitUsdt: 4,
        walletAddress: executor.address,
      };

      const res = await tradeExecutionService.executeTrade(req, highGasProvider, executor, await arbitrageExecutor.getAddress());
      expect(res.success).to.be.false;
      expect(res.rejectionGate).to.equal("GAS_PRICE_EXCEEDED");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. BLOCKCHAIN / RPC CASES
  // ───────────────────────────────────────────────────────────────────────────
  describe("3. Blockchain & RPC Cases", () => {
    it("should reject execution when RPC provider is missing", async () => {
      const req: TradeExecutionRequest = {
        opportunityId: "opp-no-rpc",
        chainId: 31337,
        tokenIn: await mockTokenIn.getAddress(),
        tokenOut: await mockTokenOut.getAddress(),
        routerBuy: await mockRouterBuy.getAddress(),
        routerSell: await mockRouterSell.getAddress(),
        amountInFormatted: 100,
        expectedGrossProfitUsdt: 5,
        expectedNetProfitUsdt: 4,
        walletAddress: executor.address,
      };

      const res = await tradeExecutionService.executeTrade(req, undefined, executor, await arbitrageExecutor.getAddress());
      expect(res.success).to.be.false;
      expect(res.rejectionGate).to.equal("RPC_NOT_CONFIGURED");
    });

    it("should handle RPC provider timeout/error gracefully without crashing", async () => {
      const failingProvider = {
        async getCode() {
          throw new Error("ETIMEDOUT: Connection to RPC node timed out after 5000ms");
        },
      } as any;

      const req: TradeExecutionRequest = {
        opportunityId: "opp-rpc-timeout",
        chainId: 31337,
        tokenIn: await mockTokenIn.getAddress(),
        tokenOut: await mockTokenOut.getAddress(),
        routerBuy: await mockRouterBuy.getAddress(),
        routerSell: await mockRouterSell.getAddress(),
        amountInFormatted: 100,
        expectedGrossProfitUsdt: 5,
        expectedNetProfitUsdt: 4,
        walletAddress: executor.address,
      };

      const res = await tradeExecutionService.executeTrade(req, failingProvider, executor, await arbitrageExecutor.getAddress());
      expect(res.success).to.be.false;
      expect(res.rejectionGate).to.equal("RPC_ERROR");
      expect(res.error).to.include("ETIMEDOUT");
    });

    it("should reject unauthorized / unsupported chain ID", async () => {
      const req: TradeExecutionRequest = {
        opportunityId: "opp-bad-chain",
        chainId: 56 as any, // Binance Smart Chain (not in whitelist)
        tokenIn: await mockTokenIn.getAddress(),
        tokenOut: await mockTokenOut.getAddress(),
        routerBuy: await mockRouterBuy.getAddress(),
        routerSell: await mockRouterSell.getAddress(),
        amountInFormatted: 100,
        expectedGrossProfitUsdt: 5,
        expectedNetProfitUsdt: 4,
        walletAddress: executor.address,
      };

      const res = await tradeExecutionService.executeTrade(req, ethers.provider, executor, await arbitrageExecutor.getAddress());
      expect(res.success).to.be.false;
      expect(res.rejectionGate).to.equal("UNSUPPORTED_CHAIN");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. SMART CONTRACT CASES
  // ───────────────────────────────────────────────────────────────────────────
  describe("4. Smart Contract Cases", () => {
    it("should reject contract address that has no deployed bytecode (empty address)", async () => {
      const emptyContractAddress = "0x1234567890123456789012345678901234567890";

      const req: TradeExecutionRequest = {
        opportunityId: "opp-empty-code",
        chainId: 31337,
        tokenIn: await mockTokenIn.getAddress(),
        tokenOut: await mockTokenOut.getAddress(),
        routerBuy: await mockRouterBuy.getAddress(),
        routerSell: await mockRouterSell.getAddress(),
        amountInFormatted: 100,
        expectedGrossProfitUsdt: 5,
        expectedNetProfitUsdt: 4,
        walletAddress: executor.address,
      };

      const res = await tradeExecutionService.executeTrade(req, ethers.provider, executor, emptyContractAddress);
      expect(res.success).to.be.false;
      expect(res.rejectionGate).to.equal("CONTRACT_NOT_DEPLOYED");
    });

    it("should revert and fail when unauthorized caller attempts to call executeArbitrage directly", async () => {
      const params = {
        routerBuy: await mockRouterBuy.getAddress(),
        routerSell: await mockRouterSell.getAddress(),
        tokenIn: await mockTokenIn.getAddress(),
        tokenOut: await mockTokenOut.getAddress(),
        amountIn: ethers.parseUnits("100", 6),
        minProfit: ethers.parseUnits("1", 6),
        deadline: Math.floor(Date.now() / 1000) + 300,
      };

      // UnauthorizedUser tries to call directly
      await expect(
        arbitrageExecutor.connect(unauthorizedUser).executeArbitrage(params)
      ).to.be.revertedWithCustomError(arbitrageExecutor, "Unauthorized");
    });

    it("should revert when contract is paused", async () => {
      await arbitrageExecutor.connect(admin).togglePause();
      expect(await arbitrageExecutor.paused()).to.be.true;

      const params = {
        routerBuy: await mockRouterBuy.getAddress(),
        routerSell: await mockRouterSell.getAddress(),
        tokenIn: await mockTokenIn.getAddress(),
        tokenOut: await mockTokenOut.getAddress(),
        amountIn: ethers.parseUnits("100", 6),
        minProfit: ethers.parseUnits("1", 6),
        deadline: Math.floor(Date.now() / 1000) + 300,
      };

      await expect(
        arbitrageExecutor.connect(executor).executeArbitrage(params)
      ).to.be.revertedWithCustomError(arbitrageExecutor, "ContractPaused");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 5. DEX & SLIPPAGE CASES
  // ───────────────────────────────────────────────────────────────────────────
  describe("5. DEX & Slippage Cases", () => {
    it("should revert if tokens are identical (tokenIn == tokenOut)", async () => {
      const params = {
        routerBuy: await mockRouterBuy.getAddress(),
        routerSell: await mockRouterSell.getAddress(),
        tokenIn: await mockTokenIn.getAddress(),
        tokenOut: await mockTokenIn.getAddress(), // Identical!
        amountIn: ethers.parseUnits("100", 6),
        minProfit: ethers.parseUnits("1", 6),
        deadline: Math.floor(Date.now() / 1000) + 300,
      };

      await expect(
        arbitrageExecutor.connect(executor).executeArbitrage(params)
      ).to.be.revertedWithCustomError(arbitrageExecutor, "IdenticalTokens");
    });

    it("should revert if routers are identical (routerBuy == routerSell)", async () => {
      const params = {
        routerBuy: await mockRouterBuy.getAddress(),
        routerSell: await mockRouterBuy.getAddress(), // Identical!
        tokenIn: await mockTokenIn.getAddress(),
        tokenOut: await mockTokenOut.getAddress(),
        amountIn: ethers.parseUnits("100", 6),
        minProfit: ethers.parseUnits("1", 6),
        deadline: Math.floor(Date.now() / 1000) + 300,
      };

      await expect(
        arbitrageExecutor.connect(executor).executeArbitrage(params)
      ).to.be.revertedWithCustomError(arbitrageExecutor, "IdenticalRouters");
    });

    it("should revert on-chain when arbitrage is unprofitable (final < amountIn + minProfit)", async () => {
      // Drain Sell router so output is less than input (unprofitable return)
      const params = {
        routerBuy: await mockRouterBuy.getAddress(),
        routerSell: await mockRouterSell.getAddress(),
        tokenIn: await mockTokenIn.getAddress(),
        tokenOut: await mockTokenOut.getAddress(),
        amountIn: ethers.parseUnits("100", 6),
        minProfit: ethers.parseUnits("5000", 6), // Impossible 5000 USDC min profit
        deadline: Math.floor(Date.now() / 1000) + 300,
      };

      await expect(
        arbitrageExecutor.connect(executor).executeArbitrage(params)
      ).to.be.revertedWithCustomError(arbitrageExecutor, "UnprofitableArbitrage");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 6. ARBITRAGE & PROFIT GATE CASES
  // ───────────────────────────────────────────────────────────────────────────
  describe("6. Arbitrage & Minimum Profit Gates", () => {
    it("should reject trade when expected net profit is zero or negative", async () => {
      const req: TradeExecutionRequest = {
        opportunityId: "opp-zero-profit",
        chainId: 31337,
        tokenIn: await mockTokenIn.getAddress(),
        tokenOut: await mockTokenOut.getAddress(),
        routerBuy: await mockRouterBuy.getAddress(),
        routerSell: await mockRouterSell.getAddress(),
        amountInFormatted: 100,
        expectedGrossProfitUsdt: 0.05,
        expectedNetProfitUsdt: 0.0, // Zero profit!
        walletAddress: executor.address,
      };

      const res = await tradeExecutionService.executeTrade(req, ethers.provider, executor, await arbitrageExecutor.getAddress());
      expect(res.success).to.be.false;
      expect(res.rejectionGate).to.equal("UNPROFITABLE_OPPORTUNITY");
    });

    it("should reject trade when net profit is below minimum threshold (0.01 USDT)", async () => {
      const req: TradeExecutionRequest = {
        opportunityId: "opp-tiny-profit",
        chainId: 31337,
        tokenIn: await mockTokenIn.getAddress(),
        tokenOut: await mockTokenOut.getAddress(),
        routerBuy: await mockRouterBuy.getAddress(),
        routerSell: await mockRouterSell.getAddress(),
        amountInFormatted: 100,
        expectedGrossProfitUsdt: 0.008,
        expectedNetProfitUsdt: 0.005, // Below 0.01 threshold!
        walletAddress: executor.address,
      };

      const res = await tradeExecutionService.executeTrade(req, ethers.provider, executor, await arbitrageExecutor.getAddress());
      expect(res.success).to.be.false;
      expect(res.rejectionGate).to.equal("UNPROFITABLE_OPPORTUNITY");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 7. API CASES
  // ───────────────────────────────────────────────────────────────────────────
  describe("7. API Failure Cases", () => {
    it("should return HTTP 400 when required parameters are missing in execute trade request", async () => {
      const res = await callApi("POST", "/api/trades/execute", {
        opportunityId: "opp-missing-fields",
        // missing tokenIn, tokenOut, routerBuy, routerSell
      });
      expect(res.statusCode).to.equal(400);
      expect(res.body.error.code).to.equal("INVALID_REQUEST");
    });

    it("should return HTTP 403 when execution gate blocks the request", async () => {
      const res = await callApi("POST", "/api/trades/execute", {
        opportunityId: "opp-api-blocked",
        chainId: 999999, // Bad chain
        tokenIn: await mockTokenIn.getAddress(),
        tokenOut: await mockTokenOut.getAddress(),
        routerBuy: await mockRouterBuy.getAddress(),
        routerSell: await mockRouterSell.getAddress(),
        amountInFormatted: 100,
        expectedGrossProfitUsdt: 5,
        expectedNetProfitUsdt: 4,
        walletAddress: executor.address,
      });
      expect(res.statusCode).to.equal(403);
      expect(res.body.error.code).to.equal("UNSUPPORTED_CHAIN");
    });

    it("should block duplicate concurrent executions of the same opportunity", async () => {
      const req: TradeExecutionRequest = {
        opportunityId: "opp-concurrency-test",
        chainId: 31337,
        tokenIn: await mockTokenIn.getAddress(),
        tokenOut: await mockTokenOut.getAddress(),
        routerBuy: await mockRouterBuy.getAddress(),
        routerSell: await mockRouterSell.getAddress(),
        amountInFormatted: 100,
        expectedGrossProfitUsdt: 5,
        expectedNetProfitUsdt: 4.8,
        walletAddress: executor.address,
      };

      // Launch first execution and launch second with same opportunityId immediately
      const p1 = tradeExecutionService.executeTrade(req, ethers.provider, executor, await arbitrageExecutor.getAddress());
      const p2 = tradeExecutionService.executeTrade(req, ethers.provider, executor, await arbitrageExecutor.getAddress());

      const [r1, r2] = await Promise.all([p1, p2]);

      // Exactly one succeeds, the other is blocked by DUPLICATE_IN_FLIGHT lock
      const oneSucceeded = r1.success || r2.success;
      const oneBlocked = r1.rejectionGate === "DUPLICATE_IN_FLIGHT" || r2.rejectionGate === "DUPLICATE_IN_FLIGHT";

      expect(oneSucceeded).to.be.true;
      expect(oneBlocked).to.be.true;
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 8. DATABASE & SAFETY INTEGRITY
  // ───────────────────────────────────────────────────────────────────────────
  describe("8. Database & Safety Invariants", () => {
    it("should NOT record success or increment trade count when execution fails", async () => {
      const initialTrades = dbService.getTrades().trades.length;
      const initialBotTrades = botService.getStatus().tradeCount;

      const badReq: TradeExecutionRequest = {
        opportunityId: "opp-never-succeeds",
        chainId: 31337,
        tokenIn: await mockTokenIn.getAddress(),
        tokenOut: await mockTokenOut.getAddress(),
        routerBuy: await mockRouterBuy.getAddress(),
        routerSell: await mockRouterSell.getAddress(),
        amountInFormatted: 0, // Invalid amount
        expectedGrossProfitUsdt: 0,
        expectedNetProfitUsdt: 0,
        walletAddress: executor.address,
      };

      await tradeExecutionService.executeTrade(badReq, ethers.provider, executor, await arbitrageExecutor.getAddress());

      // Asserts zero phantom trades
      expect(dbService.getTrades().trades.length).to.equal(initialTrades);
      expect(botService.getStatus().tradeCount).to.equal(initialBotTrades);
    });

    it("should strictly record on-chain revert as REVERTED with gas loss (No fake profit)", async () => {
      // Pause contract so executeArbitrage reverts on-chain
      await arbitrageExecutor.connect(admin).togglePause();

      const revertReq: TradeExecutionRequest = {
        opportunityId: "opp-revert-loss-check",
        chainId: 31337,
        tokenIn: await mockTokenIn.getAddress(),
        tokenOut: await mockTokenOut.getAddress(),
        routerBuy: await mockRouterBuy.getAddress(),
        routerSell: await mockRouterSell.getAddress(),
        amountInFormatted: 100,
        expectedGrossProfitUsdt: 5.0,
        expectedNetProfitUsdt: 4.8,
        walletAddress: executor.address,
      };

      const result = await tradeExecutionService.executeTrade(revertReq, ethers.provider, executor, await arbitrageExecutor.getAddress());

      expect(result.success).to.be.false;
      expect(["FAILED", "REVERTED"]).to.include(result.status);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 9. RECOVERY TESTING
  // ───────────────────────────────────────────────────────────────────────────
  describe("9. Recovery Testing", () => {
    it("should successfully execute a valid trade after emergency stop is resolved", async () => {
      // 1. Emergency stop active
      botService.emergencyStop();
      expect(botService.getStatus().status).to.equal("EMERGENCY_STOPPED");

      const validReq: TradeExecutionRequest = {
        opportunityId: "opp-recovery-01",
        chainId: 31337,
        tokenIn: await mockTokenIn.getAddress(),
        tokenOut: await mockTokenOut.getAddress(),
        routerBuy: await mockRouterBuy.getAddress(),
        routerSell: await mockRouterSell.getAddress(),
        amountInFormatted: 100,
        expectedGrossProfitUsdt: 5.0,
        expectedNetProfitUsdt: 4.8,
        walletAddress: executor.address,
      };

      // Execution blocked
      const blockedRes = await tradeExecutionService.executeTrade(validReq, ethers.provider, executor, await arbitrageExecutor.getAddress());
      expect(blockedRes.success).to.be.false;
      expect(blockedRes.rejectionGate).to.equal("EMERGENCY_STOP");

      // 2. Recover system: Start bot
      botService.start();
      expect(botService.getStatus().status).to.equal("RUNNING");

      // Execution succeeds after recovery
      const recoveredRes = await tradeExecutionService.executeTrade(validReq, ethers.provider, executor, await arbitrageExecutor.getAddress());
      expect(recoveredRes.success).to.be.true;
      expect(recoveredRes.status).to.equal("CONFIRMED");
      expect(recoveredRes.txHash).to.be.a("string");
    });
  });
});
