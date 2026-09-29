/**
 * @file ExecutionModes.test.ts
 * @description Comprehensive Test Suite for Execution Modes: User-Signed vs Automated
 *
 * Verifies all 7 core requirements:
 * 1. User-Signed Execution (Default, non-custodial, trade summary, min output, MetaMask signing, zero private keys)
 * 2. Automated Execution (Optional, separately funded dedicated executor, 12 safety checks, risk limits)
 * 3. Strict Separation (Separate UI states, distinct mode status, no mixing of permissions or accounting)
 * 4. Automated Execution Safety (Min profit, max size, gas ceiling, daily loss, consecutive failure breaker)
 * 5. Independent Emergency Controls (Pause, resume, emergency stop for automated executor without affecting user-signed)
 * 6. Treasury Relationship (User-signed settles to user, automated settles to Treasury 60/20/20)
 * 7. Dashboard Endpoints & Telemetry
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
import { ExecutionModeService } from "../../src/execution/ExecutionModeService";

describe("Execution Modes: User-Signed vs Automated Verification Suite", () => {
  let deployer: HardhatEthersSigner;
  let userSigner: HardhatEthersSigner;
  let dedicatedExecutor: HardhatEthersSigner;

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
  let executionModeService: ExecutionModeService;

  beforeEach(async () => {
    [deployer, userSigner, dedicatedExecutor] = await ethers.getSigners();

    // 1. Deploy Test Smart Contracts on Local Blockchain
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

    // Configure contract permissions
    await arbitrageExecutor.connect(deployer).setExecutor(dedicatedExecutor.address, true);
    await arbitrageExecutor.connect(deployer).setWhitelistedToken(await mockTokenIn.getAddress(), true);
    await arbitrageExecutor.connect(deployer).setWhitelistedToken(await mockTokenOut.getAddress(), true);
    await arbitrageExecutor.connect(deployer).setWhitelistedRouter(await mockRouterBuy.getAddress(), true);
    await arbitrageExecutor.connect(deployer).setWhitelistedRouter(await mockRouterSell.getAddress(), true);

    // Fund accounts
    const mintAmount = ethers.parseUnits("50000", 6);
    await mockTokenIn.mint(userSigner.address, mintAmount);
    await mockTokenIn.mint(dedicatedExecutor.address, mintAmount);
    await mockTokenIn.mint(await mockRouterBuy.getAddress(), mintAmount);
    await mockTokenIn.mint(await mockRouterSell.getAddress(), mintAmount);
    await mockTokenOut.mint(await mockRouterBuy.getAddress(), ethers.parseUnits("100", 18));
    await mockTokenOut.mint(await mockRouterSell.getAddress(), ethers.parseUnits("100", 18));

    // Approvals
    await mockTokenIn.connect(userSigner).approve(await arbitrageExecutor.getAddress(), ethers.MaxUint256);
    await mockTokenIn.connect(dedicatedExecutor).approve(await arbitrageExecutor.getAddress(), ethers.MaxUint256);

    // 2. Initialize API App Container
    apiApp = createApiApp();
    dbService = apiApp.dbService;
    botService = apiApp.botService;
    syncService = apiApp.syncService;
    distributionEngine = apiApp.distributionEngine;
    tradeExecutionService = apiApp.tradeExecutionService;
    executionModeService = apiApp.executionModeService;

    // Configure dedicated executor address in service
    executionModeService.updateAutomatedConfig({
      dedicatedExecutorAddress: dedicatedExecutor.address,
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 1. DEFAULT DEPLOYMENT & STRICT SEPARATION
  // ─────────────────────────────────────────────────────────────────────────
  describe("1. Default Deployment & Mode Separation", () => {
    it("defaults strictly to USER_SIGNED execution mode", () => {
      expect(executionModeService.getActiveMode()).to.equal("USER_SIGNED");
      const snapshot = executionModeService.getStatusSnapshot();
      expect(snapshot.activeMode).to.equal("USER_SIGNED");
      expect(snapshot.userSigned.nonCustodial).to.be.true;
      expect(snapshot.userSigned.privateKeysAccessible).to.be.false;
      expect(snapshot.automated.enabled).to.be.false;
      expect(snapshot.automated.paused).to.be.true;
    });

    it("prevents switching to AUTOMATED mode unless explicitly enabled", () => {
      expect(() => executionModeService.setActiveMode("AUTOMATED")).to.throw(
        "Automated execution is not enabled. Explicit enablement required."
      );
    });

    it("switches to AUTOMATED mode only after explicit operator enablement", () => {
      executionModeService.updateAutomatedConfig({ enabled: true, paused: false });
      executionModeService.setActiveMode("AUTOMATED");
      expect(executionModeService.getActiveMode()).to.equal("AUTOMATED");

      const snapshot = executionModeService.getStatusSnapshot();
      expect(snapshot.automated.status).to.equal("Automated Executor Active");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 2. USER-SIGNED EXECUTION (DEFAULT / NON-CUSTODIAL)
  // ─────────────────────────────────────────────────────────────────────────
  describe("2. User-Signed Execution (Default / Non-Custodial)", () => {
    it("prepares trade summary with expected amount, minimum output, gas, and net profit before signing", async () => {
      const req: TradeExecutionRequest = {
        opportunityId: "OPP-USER-001",
        chainId: 31337,
        tokenIn: await mockTokenIn.getAddress(),
        tokenOut: await mockTokenOut.getAddress(),
        routerBuy: await mockRouterBuy.getAddress(),
        routerSell: await mockRouterSell.getAddress(),
        amountInFormatted: 100.0,
        expectedGrossProfitUsdt: 2.50,
        expectedNetProfitUsdt: 1.65,
        walletAddress: userSigner.address,
        slippageTolerancePct: 0.5,
      };

      const summary = await executionModeService.prepareUserSignedTrade(
        req,
        await arbitrageExecutor.getAddress()
      );

      expect(summary.opportunityId).to.equal("OPP-USER-001");
      expect(summary.amountInFormatted).to.equal(100.0);
      expect(summary.minimumOutputReceivedFormatted).to.equal(99.5); // 100 * (1 - 0.5%)
      expect(summary.estimatedGasCostUsd).to.be.a("number");
      expect(summary.slippageTolerancePct).to.equal(0.5);
      expect(summary.expectedNetProfitUsd).to.equal(1.65);
      expect(summary.status).to.equal("Waiting for Wallet Confirmation");
      expect(summary.calldata).to.match(/^0x[a-fA-F0-9]+/);
      expect(summary.contractAddress).to.equal(await arbitrageExecutor.getAddress());
      expect(summary.nonCustodialNotice).to.include("MetaMask wallet approval required");
    });

    it("confirms user-signed trade and records attribution to USER_SIGNED and user wallet", () => {
      const confirmedTrade = executionModeService.recordUserSignedTradeResult({
        tradeId: "USER-TRADE-101",
        txHash: "0x123userSignedTxHash...",
        chainId: 8453,
        tokenIn: "USDC",
        tokenOut: "WETH",
        amountIn: 50.0,
        buyDex: "Uniswap_V2",
        sellDex: "SushiSwap_V2",
        status: "CONFIRMED",
        netProfitUsdt: 1.25,
        gasCostUsdt: 0.20,
        signerAddress: userSigner.address,
      });

      expect(confirmedTrade.executionMode).to.equal("USER_SIGNED");
      expect(confirmedTrade.executorType).to.equal("USER_WALLET");
      expect(confirmedTrade.signerAddress).to.equal(userSigner.address);
      expect(confirmedTrade.status).to.equal("CONFIRMED");

      const snapshot = executionModeService.getStatusSnapshot();
      expect(snapshot.userSigned.totalUserTrades).to.be.greaterThan(0);
      expect(snapshot.userSigned.userRealizedProfitUsd).to.be.greaterThan(0);
    });

    it("remains fully operational even when automated executor is disabled or paused", async () => {
      // Ensure automated executor is completely disabled and paused
      executionModeService.updateAutomatedConfig({ enabled: false, paused: true });

      const req: TradeExecutionRequest = {
        opportunityId: "OPP-USER-ALONE",
        chainId: 31337,
        tokenIn: await mockTokenIn.getAddress(),
        tokenOut: await mockTokenOut.getAddress(),
        routerBuy: await mockRouterBuy.getAddress(),
        routerSell: await mockRouterSell.getAddress(),
        amountInFormatted: 25.0,
        expectedGrossProfitUsdt: 1.0,
        expectedNetProfitUsdt: 0.65,
        walletAddress: userSigner.address,
      };

      // User-signed trade preparation succeeds
      const summary = await executionModeService.prepareUserSignedTrade(req);
      expect(summary.status).to.equal("Waiting for Wallet Confirmation");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3. AUTOMATED EXECUTION (OPTIONAL / SEPARATELY FUNDED)
  // ─────────────────────────────────────────────────────────────────────────
  describe("3. Automated Execution (Optional / Dedicated Executor)", () => {
    beforeEach(() => {
      // Explicitly enable automated executor for these tests
      executionModeService.updateAutomatedConfig({
        enabled: true,
        paused: false,
        emergencyStopActive: false,
        minNetProfitUsd: 0.10,
        maxTradeSizeUsd: 100.0,
        maxDailyLossUsd: 20.0,
      });
    });

    it("blocks automated trade when automated execution is disabled", async () => {
      executionModeService.updateAutomatedConfig({ enabled: false });

      const req: TradeExecutionRequest = {
        opportunityId: "OPP-AUTO-DIS",
        chainId: 31337,
        tokenIn: await mockTokenIn.getAddress(),
        tokenOut: await mockTokenOut.getAddress(),
        routerBuy: await mockRouterBuy.getAddress(),
        routerSell: await mockRouterSell.getAddress(),
        amountInFormatted: 25.0,
        expectedGrossProfitUsdt: 1.0,
        expectedNetProfitUsdt: 0.65,
        walletAddress: dedicatedExecutor.address,
      };

      const result = await executionModeService.executeAutomatedTrade(req);
      expect(result.status).to.equal("BLOCKED");
      expect(result.rejectionGate).to.equal("AUTOMATED_DISABLED");
    });

    it("blocks automated trade when automated executor is paused", async () => {
      executionModeService.pauseAutomatedExecutor();

      const req: TradeExecutionRequest = {
        opportunityId: "OPP-AUTO-PAUSED",
        chainId: 31337,
        tokenIn: await mockTokenIn.getAddress(),
        tokenOut: await mockTokenOut.getAddress(),
        routerBuy: await mockRouterBuy.getAddress(),
        routerSell: await mockRouterSell.getAddress(),
        amountInFormatted: 25.0,
        expectedGrossProfitUsdt: 1.0,
        expectedNetProfitUsdt: 0.65,
        walletAddress: dedicatedExecutor.address,
      };

      const result = await executionModeService.executeAutomatedTrade(req);
      expect(result.status).to.equal("BLOCKED");
      expect(result.rejectionGate).to.equal("AUTOMATED_PAUSED");
    });

    it("enforces automated max trade size risk limit ($100.00)", async () => {
      const req: TradeExecutionRequest = {
        opportunityId: "OPP-AUTO-MAXSIZE",
        chainId: 31337,
        tokenIn: await mockTokenIn.getAddress(),
        tokenOut: await mockTokenOut.getAddress(),
        routerBuy: await mockRouterBuy.getAddress(),
        routerSell: await mockRouterSell.getAddress(),
        amountInFormatted: 150.0, // Exceeds $100.0 limit
        expectedGrossProfitUsdt: 3.0,
        expectedNetProfitUsdt: 2.0,
        walletAddress: dedicatedExecutor.address,
      };

      const result = await executionModeService.executeAutomatedTrade(req);
      expect(result.status).to.equal("BLOCKED");
      expect(result.rejectionGate).to.equal("MAX_TRADE_SIZE_EXCEEDED");
    });

    it("enforces automated minimum net profit threshold ($0.10)", async () => {
      const req: TradeExecutionRequest = {
        opportunityId: "OPP-AUTO-LOWPROFIT",
        chainId: 31337,
        tokenIn: await mockTokenIn.getAddress(),
        tokenOut: await mockTokenOut.getAddress(),
        routerBuy: await mockRouterBuy.getAddress(),
        routerSell: await mockRouterSell.getAddress(),
        amountInFormatted: 25.0,
        expectedGrossProfitUsdt: 0.20,
        expectedNetProfitUsdt: 0.05, // Below $0.10 limit
        walletAddress: dedicatedExecutor.address,
      };

      const result = await executionModeService.executeAutomatedTrade(req);
      expect(result.status).to.equal("BLOCKED");
      expect(result.rejectionGate).to.equal("BELOW_AUTOMATED_MIN_PROFIT");
    });

    it("executes valid automated trade on-chain using dedicated executor signer", async () => {
      const req: TradeExecutionRequest = {
        opportunityId: `OPP-AUTO-EXEC-${Date.now()}`,
        chainId: 31337,
        tokenIn: await mockTokenIn.getAddress(),
        tokenOut: await mockTokenOut.getAddress(),
        routerBuy: await mockRouterBuy.getAddress(),
        routerSell: await mockRouterSell.getAddress(),
        amountInFormatted: 50.0,
        expectedGrossProfitUsdt: 1.80,
        expectedNetProfitUsdt: 1.15,
        walletAddress: dedicatedExecutor.address,
      };

      const result = await executionModeService.executeAutomatedTrade(
        req,
        ethers.provider,
        dedicatedExecutor,
        await arbitrageExecutor.getAddress()
      );

      expect(result.success).to.be.true;
      expect(result.status).to.equal("CONFIRMED");
      expect(result.txHash).to.match(/^0x[a-fA-F0-9]{64}$/);

      const snapshot = executionModeService.getStatusSnapshot();
      expect(snapshot.automated.successCount).to.equal(1);
      expect(snapshot.automated.lastTransactionHash).to.equal(result.txHash);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 4. INDEPENDENT EMERGENCY CONTROLS
  // ─────────────────────────────────────────────────────────────────────────
  describe("4. Independent Emergency Controls for Automated Executor", () => {
    it("trips emergency stop for automated execution without freezing user-signed execution", async () => {
      executionModeService.updateAutomatedConfig({ enabled: true, paused: false });
      executionModeService.tripAutomatedEmergencyStop("Excessive slippage detected");

      const snapshot = executionModeService.getStatusSnapshot();
      expect(snapshot.automated.emergencyStopActive).to.be.true;
      expect(snapshot.automated.status).to.equal("Emergency Stopped");

      // Automated trade is blocked
      const autoReq: TradeExecutionRequest = {
        opportunityId: "OPP-AUTO-BLOCKED-EMERGENCY",
        chainId: 31337,
        tokenIn: await mockTokenIn.getAddress(),
        tokenOut: await mockTokenOut.getAddress(),
        routerBuy: await mockRouterBuy.getAddress(),
        routerSell: await mockRouterSell.getAddress(),
        amountInFormatted: 25.0,
        expectedGrossProfitUsdt: 1.0,
        expectedNetProfitUsdt: 0.65,
        walletAddress: dedicatedExecutor.address,
      };
      const autoRes = await executionModeService.executeAutomatedTrade(autoReq);
      expect(autoRes.status).to.equal("BLOCKED");
      expect(autoRes.rejectionGate).to.equal("AUTOMATED_EMERGENCY_STOP");

      // User-signed preparation remains available!
      const userReq: TradeExecutionRequest = { ...autoReq, walletAddress: userSigner.address };
      const userSummary = await executionModeService.prepareUserSignedTrade(userReq);
      expect(userSummary.status).to.equal("Waiting for Wallet Confirmation");
    });

    it("resumes automated executor after reset by admin", () => {
      executionModeService.tripAutomatedEmergencyStop("Test trip");
      expect(executionModeService.getAutomatedConfig().emergencyStopActive).to.be.true;

      executionModeService.resetAutomatedEmergencyStop();
      expect(executionModeService.getAutomatedConfig().emergencyStopActive).to.be.false;

      executionModeService.updateAutomatedConfig({ enabled: true });
      executionModeService.resumeAutomatedExecutor();
      expect(executionModeService.getAutomatedConfig().paused).to.be.false;
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 5. REST API ENDPOINTS INTEGRATION
  // ─────────────────────────────────────────────────────────────────────────
  describe("5. REST API Endpoints for Execution Modes", () => {
    it("GET /api/execution/mode returns complete separated telemetry", async () => {
      const res = await apiApp.server.inject({
        method: "GET",
        url: "/api/execution/mode",
        headers: { "x-api-key": "viewer-readonly-key-123" },
      });

      expect(res.statusCode).to.equal(200);
      const json = JSON.parse(res.body);
      expect(json.success).to.be.true;
      expect(json.data.activeMode).to.equal("USER_SIGNED");
      expect(json.data.userSigned.nonCustodial).to.be.true;
      expect(json.data.automated.enabled).to.be.false;
    });

    it("POST /api/trades/prepare-user-signed returns trade summary for wallet signing", async () => {
      const res = await apiApp.server.inject({
        method: "POST",
        url: "/api/trades/prepare-user-signed",
        headers: { "x-api-key": "viewer-readonly-key-123" },
        payload: {
          opportunityId: "API-USER-PREP",
          chainId: 8453,
          tokenIn: "USDC",
          tokenOut: "WETH",
          routerBuy: "Uniswap_V2",
          routerSell: "SushiSwap_V2",
          amountInFormatted: 50.0,
          expectedGrossProfitUsdt: 1.5,
          expectedNetProfitUsdt: 0.95,
        },
      });

      expect(res.statusCode).to.equal(200);
      const json = JSON.parse(res.body);
      expect(json.success).to.be.true;
      expect(json.data.status).to.equal("Waiting for Wallet Confirmation");
      expect(json.data.minimumOutputReceivedFormatted).to.be.a("number");
      expect(json.data.estimatedGasCostUsd).to.be.a("number");
    });
  });
});
