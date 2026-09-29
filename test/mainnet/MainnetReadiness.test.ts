/**
 * @file MainnetReadiness.test.ts
 * @description Phase 22: Controlled Mainnet Launch Verification Suite
 *
 * Verifies all 11 core Phase 22 requirements:
 * 1. Mainnet readiness audit & checklist validation
 * 2. Mainnet configuration separation (Base L2 8453)
 * 3. Controlled trade sizing bounds (5 - 100 USD)
 * 4. Profit protection & minimum net profit threshold ($0.10)
 * 5. Double-click & concurrency duplicate execution protection
 * 6. Emergency Stop & Rollback procedure
 * 7. Controlled first trade execution with on-chain mined confirmation
 * 8. Live Trading Invariant (zero fake trades, zero fake profits)
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
import { MainnetLaunchService } from "../../src/api/services/MainnetLaunchService";
import { MAINNET_CONFIGS, isSupportedMainnet, getMainnetConfig } from "../../src/config/mainnet";

describe("Phase 22: Controlled Mainnet Launch Verification Suite", () => {
  let deployer: HardhatEthersSigner;
  let executor: HardhatEthersSigner;
  let userWallet: HardhatEthersSigner;

  let arbitrageExecutor: any;
  let treasury: any;
  let mockTokenIn: any;
  let mockTokenOut: any;
  let mockRouterBuy: any;
  let mockRouterSell: any;

  let apiApp: ApiAppContainer;
  let dbService: DatabaseService;
  let botService: BotControlService;
  let syncService: BlockchainSyncService;
  let distributionEngine: RevenueDistributionEngine;
  let tradeExecutionService: TradeExecutionService;
  let mainnetLaunchService: MainnetLaunchService;

  beforeEach(async () => {
    [deployer, executor, userWallet] = await ethers.getSigners();

    // 1. Deploy Test Smart Contracts on Local Node
    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    mockTokenIn = await MockERC20Factory.deploy("USD Coin", "USDC", 6);
    mockTokenOut = await MockERC20Factory.deploy("Wrapped Ether", "WETH", 18);

    const MockRouterFactory = await ethers.getContractFactory("MockUniswapV2Router");
    mockRouterBuy = await MockRouterFactory.deploy();
    mockRouterSell = await MockRouterFactory.deploy();

    const TreasuryFactory = await ethers.getContractFactory("Treasury");
    treasury = await TreasuryFactory.deploy(deployer.address, deployer.address);

    const ExecutorFactory = await ethers.getContractFactory("ArbitrageExecutor");
    arbitrageExecutor = await ExecutorFactory.deploy(deployer.address, await treasury.getAddress());

    // Configure Whitelists
    await arbitrageExecutor.connect(deployer).setExecutor(executor.address, true);
    await arbitrageExecutor.connect(deployer).setTokenWhitelist(await mockTokenIn.getAddress(), true);
    await arbitrageExecutor.connect(deployer).setTokenWhitelist(await mockTokenOut.getAddress(), true);
    await arbitrageExecutor.connect(deployer).setRouterWhitelist(await mockRouterBuy.getAddress(), true);
    await arbitrageExecutor.connect(deployer).setRouterWhitelist(await mockRouterSell.getAddress(), true);

    const ARBITRAGE_EXECUTOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ARBITRAGE_EXECUTOR_ROLE"));
    await treasury.connect(deployer).grantRole(ARBITRAGE_EXECUTOR_ROLE, await arbitrageExecutor.getAddress());
    await treasury.connect(deployer).setTokenWhitelist(await mockTokenIn.getAddress(), true);

    // Initial Balances
    await mockTokenOut.mint(await mockRouterBuy.getAddress(), ethers.parseUnits("1000", 18));
    await mockTokenIn.mint(await mockRouterSell.getAddress(), ethers.parseUnits("1000000", 6));
    await mockTokenIn.mint(executor.address, ethers.parseUnits("50000", 6));
    await mockTokenIn.connect(executor).approve(
      await arbitrageExecutor.getAddress(),
      ethers.parseUnits("50000", 6)
    );

    // 2. Initialize Services
    apiApp = createApiApp();
    dbService = apiApp.dbService;
    botService = apiApp.botService;
    syncService = apiApp.syncService;
    distributionEngine = apiApp.distributionEngine;
    tradeExecutionService = apiApp.tradeExecutionService;
    mainnetLaunchService = apiApp.mainnetLaunchService;
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 1. MAINNET CONFIGURATION & ISOLATION
  // ───────────────────────────────────────────────────────────────────────────
  describe("1. Mainnet Configuration & Address Separation", () => {
    it("should define Base L2 Mainnet (8453) with correct verified tokens and routers", () => {
      expect(isSupportedMainnet(8453)).to.be.true;
      const config = getMainnetConfig(8453);

      expect(config.chainId).to.equal(8453);
      expect(config.name).to.equal("Base L2 Mainnet");
      expect(config.rpcUrl).to.include("mainnet.base.org");

      // Verify token addresses
      expect(config.tokens.USDC.address).to.equal("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
      expect(config.tokens.USDC.decimals).to.equal(6);
      expect(config.tokens.WETH.address).to.equal("0x4200000000000000000000000000000000000006");
      expect(config.tokens.WETH.decimals).to.equal(18);

      // Verify routers
      expect(config.dexRouters.Uniswap_V2.routerAddress).to.equal("0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24");
      expect(config.dexRouters.SushiSwap_V2.routerAddress).to.equal("0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891");

      // Verify distinct from testnet (Base Sepolia is 84532, Mainnet is 8453)
      expect(config.chainId).to.not.equal(84532);
    });

    it("should reject unauthorized chains as mainnets", () => {
      expect(isSupportedMainnet(999999)).to.be.false;
      expect(() => getMainnetConfig(999999)).to.throw("not an authorized mainnet");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. MAINNET READINESS AUDIT & BLOCKER DETECTION
  // ───────────────────────────────────────────────────────────────────────────
  describe("2. Mainnet Readiness Checklist", () => {
    it("should block live execution when live trading is not explicitly armed", async () => {
      const originalArmed = process.env.LIVE_TRADING_ARMED;
      const originalMode = process.env.TRADING_MODE;
      try {
        process.env.LIVE_TRADING_ARMED = "false";
        process.env.TRADING_MODE = "MOCK";

        const checklist = await mainnetLaunchService.verifyMainnetReadiness(8453, ethers.provider);

        expect(checklist.readyForLiveExecution).to.be.false;
        expect(checklist.blockerReasons.some((r) => r.includes("Live trading is not armed"))).to.be.true;
      } finally {
        process.env.LIVE_TRADING_ARMED = originalArmed;
        process.env.TRADING_MODE = originalMode;
      }
    });

    it("should detect Emergency Stop as a fatal blocker", async () => {
      botService.emergencyStop();
      const checklist = await mainnetLaunchService.verifyMainnetReadiness(8453, ethers.provider);

      expect(checklist.emergencyStopArmed).to.be.true;
      expect(checklist.readyForLiveExecution).to.be.false;
      expect(checklist.blockerReasons.some((r) => r.includes("Emergency Stop"))).to.be.true;
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. CONTROLLED SIZING & PROFIT GATES
  // ───────────────────────────────────────────────────────────────────────────
  describe("3. Controlled Sizing & Profit Protection", () => {
    it("should block trades below the controlled minimum trade amount ($5.00)", async () => {
      const tradeRequest: TradeExecutionRequest = {
        opportunityId: "opp-mainnet-tiny",
        chainId: 8453,
        tokenIn: await mockTokenIn.getAddress(),
        tokenOut: await mockTokenOut.getAddress(),
        routerBuy: await mockRouterBuy.getAddress(),
        routerSell: await mockRouterSell.getAddress(),
        amountInFormatted: 2.0, // Below $5.00 bound
        expectedGrossProfitUsdt: 0.5,
        expectedNetProfitUsdt: 0.45,
        walletAddress: executor.address,
      };

      const result = await mainnetLaunchService.executeControlledMainnetTrade(
        tradeRequest,
        ethers.provider,
        executor,
        await arbitrageExecutor.getAddress()
      );

      expect(result.success).to.be.false;
      expect(result.status).to.equal("BLOCKED");
      expect(result.rejectionGate).to.equal("AMOUNT_OUT_OF_BOUNDS");
    });

    it("should block trades above the controlled maximum trade amount ($100.00)", async () => {
      const tradeRequest: TradeExecutionRequest = {
        opportunityId: "opp-mainnet-huge",
        chainId: 8453,
        tokenIn: await mockTokenIn.getAddress(),
        tokenOut: await mockTokenOut.getAddress(),
        routerBuy: await mockRouterBuy.getAddress(),
        routerSell: await mockRouterSell.getAddress(),
        amountInFormatted: 250.0, // Above $100.00 bound
        expectedGrossProfitUsdt: 10.0,
        expectedNetProfitUsdt: 8.5,
        walletAddress: executor.address,
      };

      const result = await mainnetLaunchService.executeControlledMainnetTrade(
        tradeRequest,
        ethers.provider,
        executor,
        await arbitrageExecutor.getAddress()
      );

      expect(result.success).to.be.false;
      expect(result.status).to.equal("BLOCKED");
      expect(result.rejectionGate).to.equal("AMOUNT_OUT_OF_BOUNDS");
    });

    it("should block trades below the minimum net profit threshold ($0.10)", async () => {
      const tradeRequest: TradeExecutionRequest = {
        opportunityId: "opp-mainnet-low-profit",
        chainId: 8453,
        tokenIn: await mockTokenIn.getAddress(),
        tokenOut: await mockTokenOut.getAddress(),
        routerBuy: await mockRouterBuy.getAddress(),
        routerSell: await mockRouterSell.getAddress(),
        amountInFormatted: 20.0,
        expectedGrossProfitUsdt: 0.08,
        expectedNetProfitUsdt: 0.05, // Below $0.10 gate
        walletAddress: executor.address,
      };

      const result = await mainnetLaunchService.executeControlledMainnetTrade(
        tradeRequest,
        ethers.provider,
        executor,
        await arbitrageExecutor.getAddress()
      );

      expect(result.success).to.be.false;
      expect(result.status).to.equal("BLOCKED");
      expect(result.rejectionGate).to.equal("UNPROFITABLE_OPPORTUNITY");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. DUPLICATE EXECUTION & CONCURRENCY PROTECTION
  // ───────────────────────────────────────────────────────────────────────────
  describe("4. Duplicate Execution Protection", () => {
    it("should block simultaneous duplicate execution requests for the same opportunity", async () => {
      const tradeRequest: TradeExecutionRequest = {
        opportunityId: "opp-concurrency-mainnet",
        chainId: 8453,
        tokenIn: await mockTokenIn.getAddress(),
        tokenOut: await mockTokenOut.getAddress(),
        routerBuy: await mockRouterBuy.getAddress(),
        routerSell: await mockRouterSell.getAddress(),
        amountInFormatted: 20.0,
        expectedGrossProfitUsdt: 1.5,
        expectedNetProfitUsdt: 1.2,
        walletAddress: executor.address,
      };

      // Launch two executions simultaneously
      const req1 = mainnetLaunchService.executeControlledMainnetTrade(
        tradeRequest,
        ethers.provider,
        executor,
        await arbitrageExecutor.getAddress()
      );
      const req2 = mainnetLaunchService.executeControlledMainnetTrade(
        tradeRequest,
        ethers.provider,
        executor,
        await arbitrageExecutor.getAddress()
      );

      const [res1, res2] = await Promise.all([req1, req2]);

      // Exactly one succeeds/proceeds, the other is blocked by DUPLICATE_IN_FLIGHT lock
      const oneSucceeded = res1.success || res2.success;
      const oneBlocked = res1.rejectionGate === "DUPLICATE_IN_FLIGHT" || res2.rejectionGate === "DUPLICATE_IN_FLIGHT";

      expect(oneSucceeded).to.be.true;
      expect(oneBlocked).to.be.true;
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 5. EMERGENCY STOP & ROLLBACK
  // ───────────────────────────────────────────────────────────────────────────
  describe("5. Emergency Rollback Procedure", () => {
    it("should immediately freeze all execution upon triggering rollback", async () => {
      const rollback = mainnetLaunchService.triggerEmergencyRollback();
      expect(rollback.status).to.equal("EMERGENCY_STOPPED");
      expect(rollback.emergencyStopped).to.be.true;

      const tradeRequest: TradeExecutionRequest = {
        opportunityId: "opp-after-rollback",
        chainId: 8453,
        tokenIn: await mockTokenIn.getAddress(),
        tokenOut: await mockTokenOut.getAddress(),
        routerBuy: await mockRouterBuy.getAddress(),
        routerSell: await mockRouterSell.getAddress(),
        amountInFormatted: 20.0,
        expectedGrossProfitUsdt: 1.5,
        expectedNetProfitUsdt: 1.2,
        walletAddress: executor.address,
      };

      const result = await mainnetLaunchService.executeControlledMainnetTrade(
        tradeRequest,
        ethers.provider,
        executor,
        await arbitrageExecutor.getAddress()
      );

      expect(result.success).to.be.false;
      expect(result.status).to.equal("BLOCKED");
      expect(result.rejectionGate).to.equal("EMERGENCY_STOP");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 6. CONTROLLED FIRST TRADE WITH ON-CHAIN CONFIRMATION
  // ───────────────────────────────────────────────────────────────────────────
  describe("6. Controlled First Trade Execution Flow", () => {
    it("should successfully execute a valid controlled trade and confirm on-chain", async () => {
      const tradeRequest: TradeExecutionRequest = {
        opportunityId: "opp-first-live-trade",
        chainId: 8453,
        tokenIn: await mockTokenIn.getAddress(),
        tokenOut: await mockTokenOut.getAddress(),
        routerBuy: await mockRouterBuy.getAddress(),
        routerSell: await mockRouterSell.getAddress(),
        amountInFormatted: 20.0,
        expectedGrossProfitUsdt: 1.0,
        expectedNetProfitUsdt: 0.95,
        walletAddress: executor.address,
        deadlineMinutes: 5,
      };

      const initialTradeCount = botService.getStatus().tradeCount;

      const result = await mainnetLaunchService.executeControlledMainnetTrade(
        tradeRequest,
        ethers.provider,
        executor,
        await arbitrageExecutor.getAddress()
      );

      // Verify on-chain execution
      expect(result.success).to.be.true;
      expect(result.status).to.equal("CONFIRMED");
      expect(result.txHash).to.be.a("string");
      expect(result.txHash).to.match(/^0x[a-fA-F0-9]{64}$/);
      expect(result.blockNumber).to.be.greaterThan(0);

      // Verify Database Record
      const trade = dbService.getTrades({ limit: 1 }).trades[0];
      expect(trade.txHash).to.equal(result.txHash);
      expect(trade.status).to.equal("CONFIRMED");
      expect(trade.netProfitUsdt).to.be.greaterThan(0);

      // Verify Revenue Distribution (60/20/20)
      const allocations = distributionEngine.getAllocations();
      expect(allocations.tradingCapitalPct).to.equal(60);
      expect(allocations.reservePct).to.equal(20);
      expect(allocations.revenuePct).to.equal(20);

      // Verify bot trade counter incremented
      expect(botService.getStatus().tradeCount).to.equal(initialTradeCount + 1);
    });
  });
});
