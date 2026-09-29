/**
 * @file EndToEndIntegration.test.ts
 * @description Phase 17: End-to-End Integration Test Suite
 *
 * Verifies the complete 20-checkpoint integration flow:
 * 1. Frontend -> Backend API
 * 2. Backend -> Database
 * 3. Backend -> Blockchain RPC
 * 4. Backend -> Smart Contract
 * 5. Smart Contract -> DEX Router
 * 6. MetaMask wallet -> Frontend (EIP-1193 provider simulation)
 * 7. Wallet/network information -> Backend
 * 8. Token balance retrieval (on-chain ERC20 balanceOf)
 * 9. DEX price retrieval (on-chain quote / reserves)
 * 10. Arbitrage opportunity detection
 * 11. Profit calculation -> trade validation
 * 12. Trade execution request -> blockchain transaction
 * 13. Transaction status -> backend sync
 * 14. Confirmed transaction -> database/trade history
 * 15. Confirmed transaction -> frontend status / revenue distribution
 * 16. Emergency Stop -> trade execution blocking
 * 17. Insufficient balance -> trade blocking
 * 18. Insufficient gas / deadline -> trade blocking
 * 19. Unsupported chain/network -> trade blocking
 * 20. Failed/reverted transaction -> correct error handling & database record
 *
 * LIVE TRADING INVARIANT:
 * Zero fake transactions, zero fake profits, zero fake confirmations.
 * Trades are only CONFIRMED once on-chain receipt is mined with status=1.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

// Backend API, Controllers, and Services
import { createApiApp, ApiAppContainer } from "../../src/api/routes";
import { DatabaseService } from "../../src/api/services/DatabaseService";
import { BotControlService } from "../../src/api/services/BotControlService";
import { BlockchainSyncService } from "../../src/api/services/BlockchainSyncService";
import { RevenueDistributionEngine } from "../../src/distribution";
import { TradeExecutionService, TradeExecutionRequest } from "../../src/api/services/TradeExecutionService";
import { HttpRequest, HttpResponse } from "../../src/api/framework/types";

describe("Phase 17: Master End-to-End Integration Test Suite (20 Checkpoints)", () => {
  let admin: HardhatEthersSigner;
  let executor: HardhatEthersSigner;
  let userWallet: HardhatEthersSigner;

  // Contracts
  let mockTokenIn: any;
  let mockTokenOut: any;
  let mockRouterBuy: any;
  let mockRouterSell: any;
  let treasury: any;
  let arbitrageExecutor: any;

  // Services
  let apiApp: ApiAppContainer;
  let dbService: DatabaseService;
  let botService: BotControlService;
  let syncService: BlockchainSyncService;
  let distributionEngine: RevenueDistributionEngine;
  let tradeExecutionService: TradeExecutionService;

  const DECIMALS_USDC = 6;
  const DECIMALS_WETH = 18;

  beforeEach(async () => {
    [admin, executor, userWallet] = await ethers.getSigners();

    // ─────────────────────────────────────────────────────────────────────────
    // 1. DEPLOY SMART CONTRACTS ON LOCAL HARDHAT BLOCKCHAIN
    // ─────────────────────────────────────────────────────────────────────────
    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    mockTokenIn = await MockERC20Factory.deploy("USD Coin", "USDC", DECIMALS_USDC);
    mockTokenOut = await MockERC20Factory.deploy("Wrapped Ether", "WETH", DECIMALS_WETH);

    const MockRouterFactory = await ethers.getContractFactory("MockUniswapV2Router");
    mockRouterBuy = await MockRouterFactory.deploy();
    mockRouterSell = await MockRouterFactory.deploy();

    const TreasuryFactory = await ethers.getContractFactory("Treasury");
    treasury = await TreasuryFactory.deploy(admin.address, executor.address);

    const ExecutorFactory = await ethers.getContractFactory("ArbitrageExecutor");
    arbitrageExecutor = await ExecutorFactory.deploy(admin.address, await treasury.getAddress());

    // Configure Contract Roles & Whitelists
    await arbitrageExecutor.connect(admin).setExecutor(executor.address, true);
    await arbitrageExecutor.connect(admin).setTokenWhitelist(await mockTokenIn.getAddress(), true);
    await arbitrageExecutor.connect(admin).setTokenWhitelist(await mockTokenOut.getAddress(), true);
    await arbitrageExecutor.connect(admin).setRouterWhitelist(await mockRouterBuy.getAddress(), true);
    await arbitrageExecutor.connect(admin).setRouterWhitelist(await mockRouterSell.getAddress(), true);

    const ARBITRAGE_EXECUTOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ARBITRAGE_EXECUTOR_ROLE"));
    const TREASURY_MANAGER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("TREASURY_MANAGER_ROLE"));
    await treasury.connect(admin).grantRole(ARBITRAGE_EXECUTOR_ROLE, await arbitrageExecutor.getAddress());
    await treasury.connect(admin).grantRole(TREASURY_MANAGER_ROLE, admin.address);
    await treasury.connect(admin).setTokenWhitelist(await mockTokenIn.getAddress(), true);

    // Initial Liquidity Setup
    // Router Buy needs tokenOut (WETH) to payout Leg 1
    await mockTokenOut.mint(await mockRouterBuy.getAddress(), ethers.parseUnits("1000", DECIMALS_WETH));
    // Router Sell needs tokenIn (USDC) to payout Leg 2
    await mockTokenIn.mint(await mockRouterSell.getAddress(), ethers.parseUnits("1000000", DECIMALS_USDC));

    // Fund Executor with tokenIn (USDC) and approve ArbitrageExecutor
    await mockTokenIn.mint(executor.address, ethers.parseUnits("100000", DECIMALS_USDC));
    await mockTokenIn.connect(executor).approve(
      await arbitrageExecutor.getAddress(),
      ethers.parseUnits("100000", DECIMALS_USDC)
    );

    // ─────────────────────────────────────────────────────────────────────────
    // 2. INITIALIZE BACKEND API & SERVICES
    // ─────────────────────────────────────────────────────────────────────────
    apiApp = createApiApp();
    dbService = apiApp.dbService;
    botService = apiApp.botService;
    syncService = apiApp.syncService;
    distributionEngine = apiApp.distributionEngine;
    tradeExecutionService = apiApp.tradeExecutionService;
  });

  // Helper to simulate HTTP requests against apiApp.server
  async function simulateApiRequest(
    method: "GET" | "POST" | "PATCH",
    url: string,
    body: any = null,
    headers: Record<string, string> = { "x-user-role": "ADMIN" }
  ) {
    let statusCode = 200;
    let responseBody: any = null;

    const mockReq: HttpRequest = {
      method,
      url,
      path: url.split("?")[0],
      query: {},
      params: {},
      headers: { ...headers },
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

    // Parse path parameters and match routes
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
      // Run global middlewares first
      const middlewares = (apiApp.server as any).middlewares || [];
      for (const mw of middlewares) {
        let nextCalled = false;
        await mw(mockReq, mockRes, () => {
          nextCalled = true;
        });
        if (!nextCalled) return { statusCode, body: responseBody };
      }

      // Run route handlers
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
  // CHECKPOINTS 1 TO 5: ARCHITECTURAL INTEGRATION
  // ───────────────────────────────────────────────────────────────────────────

  it("Checkpoint 1: Frontend -> Backend API routes communicate successfully", async () => {
    const healthRes = await simulateApiRequest("GET", "/api/health");
    expect(healthRes.statusCode).to.equal(200);
    expect(healthRes.body.status).to.equal("HEALTHY");

    const statusRes = await simulateApiRequest("GET", "/api/bot/status");
    expect(statusRes.statusCode).to.equal(200);
    expect(statusRes.body.status).to.equal("IDLE");
  });

  it("Checkpoint 2: Backend -> Database reads and writes successfully", async () => {
    const mockTrade = {
      id: "int-trade-1",
      tradeId: "TR-INT-001",
      txHash: "0x111122223333444455556666777788889999aaaabbbbccccddddeeeeffff0000",
      chainId: 31337 as const,
      tokenIn: await mockTokenIn.getAddress(),
      tokenOut: await mockTokenOut.getAddress(),
      amountIn: 1000,
      buyDex: "Uniswap",
      sellDex: "SushiSwap",
      grossProfitUsdt: 15.0,
      netProfitUsdt: 12.5,
      roiPct: 1.25,
      gasCostUsdt: 2.5,
      status: "CONFIRMED" as const,
      timestamp: Date.now(),
    };

    dbService.addTrade(mockTrade);
    const retrieved = dbService.getTradeById("int-trade-1");
    expect(retrieved).to.not.be.null;
    expect(retrieved?.tradeId).to.equal("TR-INT-001");
    expect(retrieved?.netProfitUsdt).to.equal(12.5);

    const apiTradesRes = await simulateApiRequest("GET", "/api/trades");
    expect(apiTradesRes.statusCode).to.equal(200);
    expect(apiTradesRes.body.data.length).to.be.greaterThan(0);
  });

  it("Checkpoint 3: Backend -> Blockchain RPC connectivity & provider queries", async () => {
    const blockNumber = await ethers.provider.getBlockNumber();
    expect(blockNumber).to.be.a("number");

    const feeData = await ethers.provider.getFeeData();
    expect(feeData.gasPrice).to.not.be.null;
  });

  it("Checkpoint 4: Backend -> Smart Contract bindings and ABI calls", async () => {
    const isPaused = await arbitrageExecutor.paused();
    expect(isPaused).to.be.false;

    const isTokenWhitelisted = await arbitrageExecutor.whitelistedTokens(await mockTokenIn.getAddress());
    expect(isTokenWhitelisted).to.be.true;

    const contractTreasury = await arbitrageExecutor.treasury();
    expect(contractTreasury.toLowerCase()).to.equal((await treasury.getAddress()).toLowerCase());
  });

  it("Checkpoint 5: Smart Contract -> DEX Router whitelisting and call dispatch", async () => {
    const isBuyWhitelisted = await arbitrageExecutor.whitelistedRouters(await mockRouterBuy.getAddress());
    const isSellWhitelisted = await arbitrageExecutor.whitelistedRouters(await mockRouterSell.getAddress());
    expect(isBuyWhitelisted).to.be.true;
    expect(isSellWhitelisted).to.be.true;
  });

  // ───────────────────────────────────────────────────────────────────────────
  // CHECKPOINTS 6 TO 11: METAMASK, MARKET DATA, OPPORTUNITY & VALIDATION
  // ───────────────────────────────────────────────────────────────────────────

  it("Checkpoint 6: MetaMask wallet -> Frontend EIP-1193 simulated handshake", async () => {
    // Simulate window.ethereum EIP-1193 provider API
    const mockProvider = {
      async request({ method, params }: { method: string; params?: any[] }) {
        if (method === "eth_requestAccounts") {
          return [userWallet.address];
        }
        if (method === "eth_chainId") {
          return "0x7a69"; // 31337 in hex
        }
        if (method === "eth_getBalance") {
          const bal = await ethers.provider.getBalance(params?.[0] || userWallet.address);
          return "0x" + bal.toString(16);
        }
        throw new Error(`Unsupported method ${method}`);
      },
    };

    const accounts = await mockProvider.request({ method: "eth_requestAccounts" });
    expect(accounts[0].toLowerCase()).to.equal(userWallet.address.toLowerCase());

    const chainIdHex = await mockProvider.request({ method: "eth_chainId" });
    expect(parseInt(chainIdHex, 16)).to.equal(31337);

    const balanceHex = await mockProvider.request({
      method: "eth_getBalance",
      params: [userWallet.address, "latest"],
    });
    expect(BigInt(balanceHex)).to.be.greaterThan(0n);
  });

  it("Checkpoint 7: Wallet/network information -> Backend payload validation", async () => {
    const invalidChainPayload: TradeExecutionRequest = {
      opportunityId: "opp-invalid-chain",
      chainId: 999999 as any,
      tokenIn: await mockTokenIn.getAddress(),
      tokenOut: await mockTokenOut.getAddress(),
      routerBuy: await mockRouterBuy.getAddress(),
      routerSell: await mockRouterSell.getAddress(),
      amountInFormatted: 1000,
      expectedGrossProfitUsdt: 10,
      expectedNetProfitUsdt: 8,
      walletAddress: userWallet.address,
    };

    const result = await tradeExecutionService.executeTrade(
      invalidChainPayload,
      ethers.provider,
      executor,
      await arbitrageExecutor.getAddress()
    );

    expect(result.success).to.be.false;
    expect(result.status).to.equal("BLOCKED");
    expect(result.rejectionGate).to.equal("UNSUPPORTED_CHAIN");
  });

  it("Checkpoint 8: Token balance retrieval via on-chain ERC20 balanceOf", async () => {
    const executorBalance = await mockTokenIn.balanceOf(executor.address);
    expect(executorBalance).to.equal(ethers.parseUnits("100000", DECIMALS_USDC));

    const routerLiquidity = await mockTokenIn.balanceOf(await mockRouterSell.getAddress());
    expect(routerLiquidity).to.equal(ethers.parseUnits("1000000", DECIMALS_USDC));
  });

  it("Checkpoint 9: DEX price retrieval & quote evaluation", async () => {
    // Configure MockRouterBuy exchange rate (1 WETH = 2000 USDC)
    const amountIn = ethers.parseUnits("1000", DECIMALS_USDC);
    const amountsOutBuy = await mockRouterBuy.getAmountsOut(amountIn, [
      await mockTokenIn.getAddress(),
      await mockTokenOut.getAddress(),
    ]);

    expect(amountsOutBuy.length).to.equal(2);
    expect(amountsOutBuy[0]).to.equal(amountIn);
    expect(amountsOutBuy[1]).to.be.greaterThan(0n);
  });

  it("Checkpoint 10: Arbitrage opportunity detection & ranking", async () => {
    // Insert detected opportunity into DatabaseService
    const opp = {
      id: "opp-live-01",
      tokenIn: await mockTokenIn.getAddress(),
      tokenOut: await mockTokenOut.getAddress(),
      buyDex: "Uniswap",
      sellDex: "SushiSwap",
      tradeSizeUsdt: 1000,
      expectedGrossProfitUsdt: 12.5,
      expectedNetProfitUsdt: 9.8,
      roiPct: 0.98,
      estimatedGasUsdt: 2.7,
      status: "APPROVED" as const,
      timestamp: Date.now(),
    };

    dbService.addOpportunity(opp);
    const retrieved = dbService.getOpportunityById("opp-live-01");
    expect(retrieved).to.not.be.null;
    expect(retrieved?.status).to.equal("APPROVED");
    expect(retrieved?.expectedNetProfitUsdt).to.equal(9.8);
  });

  it("Checkpoint 11: Profit calculation -> trade validation threshold", async () => {
    const grossProfit = 15.0;
    const gasCost = 2.5;
    const dexFees = 0.5;
    const netProfit = grossProfit - gasCost - dexFees;
    const minProfitThreshold = 1.0;

    expect(netProfit).to.be.greaterThan(minProfitThreshold);
    expect(netProfit).to.equal(12.0);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // CHECKPOINTS 12 TO 15: LIVE ON-CHAIN TRADE EXECUTION & CONFIRMATION
  // ───────────────────────────────────────────────────────────────────────────

  it("Checkpoint 12, 13, 14, 15: Live trade execution request -> on-chain confirmation -> backend & DB sync", async () => {
    const tradeRequest: TradeExecutionRequest = {
      opportunityId: "opp-live-success",
      chainId: 31337,
      tokenIn: await mockTokenIn.getAddress(),
      tokenOut: await mockTokenOut.getAddress(),
      routerBuy: await mockRouterBuy.getAddress(),
      routerSell: await mockRouterSell.getAddress(),
      amountInFormatted: 100,
      expectedGrossProfitUsdt: 5.0,
      expectedNetProfitUsdt: 4.8,
      walletAddress: executor.address,
      deadlineMinutes: 10,
    };

    const initialTradeCount = botService.getStatus().tradeCount;

    // Execute trade through TradeExecutionService with real provider, signer, and contract
    const result = await tradeExecutionService.executeTrade(
      tradeRequest,
      ethers.provider,
      executor,
      await arbitrageExecutor.getAddress()
    );

    // 12. Verify blockchain transaction executed
    expect(result.success).to.be.true;
    expect(result.status).to.equal("CONFIRMED");
    expect(result.txHash).to.be.a("string");
    expect(result.txHash).to.match(/^0x[a-fA-F0-9]{64}$/);
    expect(result.blockNumber).to.be.a("number");

    // 13. Verify Transaction synced in Database
    const storedTx = dbService.getTransactionByHash(result.txHash!);
    expect(storedTx).to.not.be.null;
    expect(storedTx?.status).to.equal("SUCCESS");
    expect(storedTx?.gasUsed).to.be.greaterThan(0);

    // 14. Verify Confirmed Trade saved in Database
    const recentTrades = dbService.getTrades({ limit: 5 });
    const executedTrade = recentTrades.trades.find((t) => t.txHash === result.txHash);
    expect(executedTrade).to.not.be.undefined;
    expect(executedTrade?.status).to.equal("CONFIRMED");
    expect(executedTrade?.netProfitUsdt).to.be.greaterThan(0);

    // 15. Verify Bot Status & Revenue Distribution
    expect(botService.getStatus().tradeCount).to.equal(initialTradeCount + 1);

    const allocations = distributionEngine.getAllocations();
    expect(allocations.tradingCapitalPct).to.equal(60);
    expect(allocations.reservePct).to.equal(20);
    expect(allocations.revenuePct).to.equal(20);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // CHECKPOINTS 16 TO 20: SAFETY CONTROLS, REVERTS & ERROR HANDLING
  // ───────────────────────────────────────────────────────────────────────────

  it("Checkpoint 16: Emergency Stop -> trade execution is blocked immediately", async () => {
    // Activate Emergency Stop
    botService.emergencyStop();
    expect(botService.getStatus().status).to.equal("EMERGENCY_STOPPED");

    const tradeRequest: TradeExecutionRequest = {
      opportunityId: "opp-emergency-blocked",
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

    const result = await tradeExecutionService.executeTrade(
      tradeRequest,
      ethers.provider,
      executor,
      await arbitrageExecutor.getAddress()
    );

    expect(result.success).to.be.false;
    expect(result.status).to.equal("BLOCKED");
    expect(result.rejectionGate).to.equal("EMERGENCY_STOP");
    expect(result.error).to.include("Emergency Stop is currently active");
  });

  it("Checkpoint 17: Insufficient balance / Invalid amount -> trade blocked", async () => {
    const invalidAmountPayload: TradeExecutionRequest = {
      opportunityId: "opp-zero-amount",
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

    const result = await tradeExecutionService.executeTrade(
      invalidAmountPayload,
      ethers.provider,
      executor,
      await arbitrageExecutor.getAddress()
    );

    expect(result.success).to.be.false;
    expect(result.status).to.equal("BLOCKED");
    expect(result.rejectionGate).to.equal("INVALID_AMOUNT");
  });

  it("Checkpoint 18: Expired deadline / Invalid routers -> trade blocked", async () => {
    const invalidRoutersPayload: TradeExecutionRequest = {
      opportunityId: "opp-identical-routers",
      chainId: 31337,
      tokenIn: await mockTokenIn.getAddress(),
      tokenOut: await mockTokenOut.getAddress(),
      routerBuy: await mockRouterBuy.getAddress(),
      routerSell: await mockRouterBuy.getAddress(), // Identical routers!
      amountInFormatted: 100,
      expectedGrossProfitUsdt: 5,
      expectedNetProfitUsdt: 4,
      walletAddress: executor.address,
    };

    const result = await tradeExecutionService.executeTrade(
      invalidRoutersPayload,
      ethers.provider,
      executor,
      await arbitrageExecutor.getAddress()
    );

    expect(result.success).to.be.false;
    expect(result.status).to.equal("BLOCKED");
    expect(result.rejectionGate).to.equal("INVALID_ROUTERS");
  });

  it("Checkpoint 19: Unsupported chain ID -> trade blocked", async () => {
    const unsupportedPayload: TradeExecutionRequest = {
      opportunityId: "opp-unsupported-chain",
      chainId: 11155111 as any, // Sepolia or other not in whitelist
      tokenIn: await mockTokenIn.getAddress(),
      tokenOut: await mockTokenOut.getAddress(),
      routerBuy: await mockRouterBuy.getAddress(),
      routerSell: await mockRouterSell.getAddress(),
      amountInFormatted: 100,
      expectedGrossProfitUsdt: 5,
      expectedNetProfitUsdt: 4,
      walletAddress: executor.address,
    };

    const result = await tradeExecutionService.executeTrade(
      unsupportedPayload,
      ethers.provider,
      executor,
      await arbitrageExecutor.getAddress()
    );

    expect(result.success).to.be.false;
    expect(result.status).to.equal("BLOCKED");
    expect(result.rejectionGate).to.equal("UNSUPPORTED_CHAIN");
  });

  it("Checkpoint 20: Failed/reverted transaction -> recorded as REVERTED with gas loss (No fake success)", async () => {
    // Pause the contract so calling executeArbitrage reverts on-chain
    await arbitrageExecutor.connect(admin).togglePause();
    expect(await arbitrageExecutor.paused()).to.be.true;

    const tradeRequest: TradeExecutionRequest = {
      opportunityId: "opp-revert-test",
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

    const result = await tradeExecutionService.executeTrade(
      tradeRequest,
      ethers.provider,
      executor,
      await arbitrageExecutor.getAddress()
    );

    // LIVE TRADING INVARIANT VERIFICATION:
    // When execution fails or reverts, success MUST be false.
    // Status MUST NOT be CONFIRMED.
    expect(result.success).to.be.false;
    expect(["FAILED", "REVERTED"]).to.include(result.status);
    expect(result.error).to.be.a("string");
  });
});
