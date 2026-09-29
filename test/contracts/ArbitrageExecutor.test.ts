import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("Phase 16: ArbitrageExecutor.sol Smart Contract Comprehensive Test Suite", () => {
  let admin: HardhatEthersSigner;
  let executor: HardhatEthersSigner;
  let attacker: HardhatEthersSigner;
  let recipient: HardhatEthersSigner;

  let arbitrageExecutor: any;
  let treasuryMock: any;
  let mockTokenIn: any;
  let mockTokenOut: any;
  let mockRouterBuy: any;
  let mockRouterSell: any;

  beforeEach(async () => {
    [admin, executor, attacker, recipient] = await ethers.getSigners();

    // 1. Deploy Mock Tokens (USDC 6 decimals, WETH 18 decimals)
    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    mockTokenIn = await MockERC20Factory.deploy("USD Coin", "USDC", 6);
    mockTokenOut = await MockERC20Factory.deploy("Wrapped Ether", "WETH", 18);

    // 2. Deploy Mock Treasury (Treasury.sol from Phase 10)
    const TreasuryFactory = await ethers.getContractFactory("Treasury");
    treasuryMock = await TreasuryFactory.deploy(admin.address, admin.address);

    // 3. Deploy Mock Routers
    const MockRouterFactory = await ethers.getContractFactory("MockUniswapV2Router");
    mockRouterBuy = await MockRouterFactory.deploy();
    mockRouterSell = await MockRouterFactory.deploy();

    // 4. Deploy ArbitrageExecutor
    const ExecutorFactory = await ethers.getContractFactory("ArbitrageExecutor");
    arbitrageExecutor = await ExecutorFactory.deploy(admin.address, await treasuryMock.getAddress());

    // 5. Configure ArbitrageExecutor Whitelists & Roles
    await arbitrageExecutor.connect(admin).setExecutor(executor.address, true);
    await arbitrageExecutor.connect(admin).setTokenWhitelist(await mockTokenIn.getAddress(), true);
    await arbitrageExecutor.connect(admin).setTokenWhitelist(await mockTokenOut.getAddress(), true);
    await arbitrageExecutor.connect(admin).setRouterWhitelist(await mockRouterBuy.getAddress(), true);
    await arbitrageExecutor.connect(admin).setRouterWhitelist(await mockRouterSell.getAddress(), true);

    // 6. Whitelist ArbitrageExecutor as authorized depositor in Treasury
    const ARBITRAGE_EXECUTOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ARBITRAGE_EXECUTOR_ROLE"));
    const TREASURY_MANAGER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("TREASURY_MANAGER_ROLE"));
    await treasuryMock.connect(admin).grantRole(ARBITRAGE_EXECUTOR_ROLE, await arbitrageExecutor.getAddress());
    await treasuryMock.connect(admin).grantRole(TREASURY_MANAGER_ROLE, admin.address);
    await treasuryMock.connect(admin).setTokenWhitelist(await mockTokenIn.getAddress(), true);

    // 7. Fund Routers with liquidity for swaps
    // Router Buy needs tokenOut (WETH) to payout Leg 1
    await mockTokenOut.mint(await mockRouterBuy.getAddress(), ethers.parseUnits("1000", 18));
    // Router Sell needs tokenIn (USDC) to payout Leg 2
    await mockTokenIn.mint(await mockRouterSell.getAddress(), ethers.parseUnits("1000000", 6));

    // 8. Fund Executor with tokenIn (USDC) and approve ArbitrageExecutor
    await mockTokenIn.mint(executor.address, ethers.parseUnits("10000", 6));
    await mockTokenIn.connect(executor).approve(await arbitrageExecutor.getAddress(), ethers.MaxUint256);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 1. CONTRACT DEPLOYMENT & INITIAL STATE
  // ─────────────────────────────────────────────────────────────────────────
  describe("1. Contract Deployment & Initial State", () => {
    it("should deploy with correct admin, treasury, and unpaused state", async () => {
      expect(await arbitrageExecutor.admin()).to.equal(admin.address);
      expect(await arbitrageExecutor.treasury()).to.equal(await treasuryMock.getAddress());
      expect(await arbitrageExecutor.paused()).to.be.false;
      expect(await arbitrageExecutor.isExecutor(admin.address)).to.be.true;
      expect(await arbitrageExecutor.isExecutor(executor.address)).to.be.true;
      expect(await arbitrageExecutor.isExecutor(attacker.address)).to.be.false;
    });

    it("should revert if deployed with zero address for admin or treasury", async () => {
      const ExecutorFactory = await ethers.getContractFactory("ArbitrageExecutor");
      await expect(
        ExecutorFactory.deploy(ethers.ZeroAddress, await treasuryMock.getAddress())
      ).to.be.revertedWithCustomError(arbitrageExecutor, "ZeroAddress");

      await expect(
        ExecutorFactory.deploy(admin.address, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(arbitrageExecutor, "ZeroAddress");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 2. TOKEN & ROUTER WHITELIST VALIDATIONS
  // ─────────────────────────────────────────────────────────────────────────
  describe("2. Token & Router Whitelist Validations", () => {
    it("should reject execution if tokenIn is not whitelisted", async () => {
      const MockERC20Factory = await ethers.getContractFactory("MockERC20");
      const unwhitelistedToken = await MockERC20Factory.deploy("Bad Token", "BAD", 18);

      const params = {
        routerBuy: await mockRouterBuy.getAddress(),
        routerSell: await mockRouterSell.getAddress(),
        tokenIn: await unwhitelistedToken.getAddress(),
        tokenOut: await mockTokenOut.getAddress(),
        amountIn: ethers.parseUnits("100", 6),
        minProfit: ethers.parseUnits("1", 6),
        deadline: Math.floor(Date.now() / 1000) + 3600,
      };

      await expect(
        arbitrageExecutor.connect(executor).executeArbitrage(params)
      ).to.be.revertedWithCustomError(arbitrageExecutor, "TokenNotWhitelisted");
    });

    it("should reject execution if tokenOut is not whitelisted", async () => {
      const MockERC20Factory = await ethers.getContractFactory("MockERC20");
      const unwhitelistedToken = await MockERC20Factory.deploy("Bad Token", "BAD", 18);

      const params = {
        routerBuy: await mockRouterBuy.getAddress(),
        routerSell: await mockRouterSell.getAddress(),
        tokenIn: await mockTokenIn.getAddress(),
        tokenOut: await unwhitelistedToken.getAddress(),
        amountIn: ethers.parseUnits("100", 6),
        minProfit: ethers.parseUnits("1", 6),
        deadline: Math.floor(Date.now() / 1000) + 3600,
      };

      await expect(
        arbitrageExecutor.connect(executor).executeArbitrage(params)
      ).to.be.revertedWithCustomError(arbitrageExecutor, "TokenNotWhitelisted");
    });

    it("should reject execution if routerBuy is not whitelisted", async () => {
      const MockRouterFactory = await ethers.getContractFactory("MockUniswapV2Router");
      const rogueRouter = await MockRouterFactory.deploy();

      const params = {
        routerBuy: await rogueRouter.getAddress(),
        routerSell: await mockRouterSell.getAddress(),
        tokenIn: await mockTokenIn.getAddress(),
        tokenOut: await mockTokenOut.getAddress(),
        amountIn: ethers.parseUnits("100", 6),
        minProfit: ethers.parseUnits("1", 6),
        deadline: Math.floor(Date.now() / 1000) + 3600,
      };

      await expect(
        arbitrageExecutor.connect(executor).executeArbitrage(params)
      ).to.be.revertedWithCustomError(arbitrageExecutor, "RouterNotWhitelisted");
    });

    it("should reject execution if routerSell is not whitelisted", async () => {
      const MockRouterFactory = await ethers.getContractFactory("MockUniswapV2Router");
      const rogueRouter = await MockRouterFactory.deploy();

      const params = {
        routerBuy: await mockRouterBuy.getAddress(),
        routerSell: await rogueRouter.getAddress(),
        tokenIn: await mockTokenIn.getAddress(),
        tokenOut: await mockTokenOut.getAddress(),
        amountIn: ethers.parseUnits("100", 6),
        minProfit: ethers.parseUnits("1", 6),
        deadline: Math.floor(Date.now() / 1000) + 3600,
      };

      await expect(
        arbitrageExecutor.connect(executor).executeArbitrage(params)
      ).to.be.revertedWithCustomError(arbitrageExecutor, "RouterNotWhitelisted");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3. INVALID PAIR & ROUTER COMBINATIONS
  // ─────────────────────────────────────────────────────────────────────────
  describe("3. Invalid Pair & Router Handling", () => {
    it("should revert with IdenticalRouters if buy and sell routers are the same", async () => {
      const routerAddr = await mockRouterBuy.getAddress();
      const params = {
        routerBuy: routerAddr,
        routerSell: routerAddr, // Identical!
        tokenIn: await mockTokenIn.getAddress(),
        tokenOut: await mockTokenOut.getAddress(),
        amountIn: ethers.parseUnits("100", 6),
        minProfit: ethers.parseUnits("1", 6),
        deadline: Math.floor(Date.now() / 1000) + 3600,
      };

      await expect(
        arbitrageExecutor.connect(executor).executeArbitrage(params)
      ).to.be.revertedWithCustomError(arbitrageExecutor, "IdenticalRouters");
    });

    it("should revert with IdenticalTokens if tokenIn and tokenOut are identical", async () => {
      const tokenAddr = await mockTokenIn.getAddress();
      const params = {
        routerBuy: await mockRouterBuy.getAddress(),
        routerSell: await mockRouterSell.getAddress(),
        tokenIn: tokenAddr,
        tokenOut: tokenAddr, // Identical!
        amountIn: ethers.parseUnits("100", 6),
        minProfit: ethers.parseUnits("1", 6),
        deadline: Math.floor(Date.now() / 1000) + 3600,
      };

      await expect(
        arbitrageExecutor.connect(executor).executeArbitrage(params)
      ).to.be.revertedWithCustomError(arbitrageExecutor, "IdenticalTokens");
    });

    it("should revert with InsufficientAmountIn if amountIn is zero", async () => {
      const params = {
        routerBuy: await mockRouterBuy.getAddress(),
        routerSell: await mockRouterSell.getAddress(),
        tokenIn: await mockTokenIn.getAddress(),
        tokenOut: await mockTokenOut.getAddress(),
        amountIn: 0,
        minProfit: ethers.parseUnits("1", 6),
        deadline: Math.floor(Date.now() / 1000) + 3600,
      };

      await expect(
        arbitrageExecutor.connect(executor).executeArbitrage(params)
      ).to.be.revertedWithCustomError(arbitrageExecutor, "InsufficientAmountIn");
    });

    it("should revert with ExpiredDeadline if current block timestamp exceeds deadline", async () => {
      const params = {
        routerBuy: await mockRouterBuy.getAddress(),
        routerSell: await mockRouterSell.getAddress(),
        tokenIn: await mockTokenIn.getAddress(),
        tokenOut: await mockTokenOut.getAddress(),
        amountIn: ethers.parseUnits("100", 6),
        minProfit: ethers.parseUnits("1", 6),
        deadline: Math.floor(Date.now() / 1000) - 100, // In the past!
      };

      await expect(
        arbitrageExecutor.connect(executor).executeArbitrage(params)
      ).to.be.revertedWithCustomError(arbitrageExecutor, "ExpiredDeadline");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 4. ATOMIC ARBITRAGE EXECUTION & PROFIT FORWARDING
  // ─────────────────────────────────────────────────────────────────────────
  describe("4. End-to-End Arbitrage Execution & Profit Safety", () => {
    it("should execute profitable arbitrage, forward profit to Treasury, and emit ArbitrageExecuted", async () => {
      const amountIn = ethers.parseUnits("100", 6); // $100 USDC in
      const minProfit = ethers.parseUnits("2", 6);   // $2 USDC minimum profit hurdle

      // Set up profitable price spread:
      // Buy Router Leg 1: 100 USDC -> 0.05 WETH (rate = 2000 USDC/WETH)
      await mockRouterBuy.setFixedOutputAmount(ethers.parseUnits("0.05", 18));

      // Sell Router Leg 2: 0.05 WETH -> 105 USDC (rate = 2100 USDC/WETH -> $5 gross profit!)
      await mockRouterSell.setFixedOutputAmount(ethers.parseUnits("105", 6));

      const params = {
        routerBuy: await mockRouterBuy.getAddress(),
        routerSell: await mockRouterSell.getAddress(),
        tokenIn: await mockTokenIn.getAddress(),
        tokenOut: await mockTokenOut.getAddress(),
        amountIn,
        minProfit,
        deadline: Math.floor(Date.now() / 1000) + 3600,
      };

      const treasuryTokenBefore = await mockTokenIn.balanceOf(await treasuryMock.getAddress());

      // Execute Arbitrage
      const tx = await arbitrageExecutor.connect(executor).executeArbitrage(params);
      await expect(tx).to.emit(arbitrageExecutor, "ArbitrageExecuted");

      // Verify Treasury received the $5 profit
      const treasuryTokenAfter = await mockTokenIn.balanceOf(await treasuryMock.getAddress());
      expect(treasuryTokenAfter - treasuryTokenBefore).to.equal(ethers.parseUnits("5", 6));
    });

    it("should REVERT with UnprofitableArbitrage if actual return < amountIn + minProfit", async () => {
      const amountIn = ethers.parseUnits("100", 6);
      const minProfit = ethers.parseUnits("5", 6); // requires $5 profit

      // Router only yields $102 (only $2 profit, which is below $5 hurdle!)
      await mockRouterBuy.setFixedOutputAmount(ethers.parseUnits("0.05", 18));
      await mockRouterSell.setFixedOutputAmount(ethers.parseUnits("102", 6));

      const params = {
        routerBuy: await mockRouterBuy.getAddress(),
        routerSell: await mockRouterSell.getAddress(),
        tokenIn: await mockTokenIn.getAddress(),
        tokenOut: await mockTokenOut.getAddress(),
        amountIn,
        minProfit,
        deadline: Math.floor(Date.now() / 1000) + 3600,
      };

      await expect(
        arbitrageExecutor.connect(executor).executeArbitrage(params)
      ).to.be.revertedWithCustomError(arbitrageExecutor, "UnprofitableArbitrage");
    });

    it("should atomically REVERT if a router swap fails, leaving zero funds stranded", async () => {
      const amountIn = ethers.parseUnits("100", 6);
      await mockRouterBuy.setFailSwap(true); // Force router swap failure

      const params = {
        routerBuy: await mockRouterBuy.getAddress(),
        routerSell: await mockRouterSell.getAddress(),
        tokenIn: await mockTokenIn.getAddress(),
        tokenOut: await mockTokenOut.getAddress(),
        amountIn,
        minProfit: ethers.parseUnits("1", 6),
        deadline: Math.floor(Date.now() / 1000) + 3600,
      };

      await expect(
        arbitrageExecutor.connect(executor).executeArbitrage(params)
      ).to.be.revertedWith("MockRouter: Swap forced failure");

      // Contract balance must remain zero (no stranded capital)
      expect(await mockTokenIn.balanceOf(await arbitrageExecutor.getAddress())).to.equal(0);
    });

    it("should atomically REVERT if caller has insufficient tokenIn balance", async () => {
      // Attacker has 0 tokens
      const params = {
        routerBuy: await mockRouterBuy.getAddress(),
        routerSell: await mockRouterSell.getAddress(),
        tokenIn: await mockTokenIn.getAddress(),
        tokenOut: await mockTokenOut.getAddress(),
        amountIn: ethers.parseUnits("100", 6),
        minProfit: ethers.parseUnits("1", 6),
        deadline: Math.floor(Date.now() / 1000) + 3600,
      };

      await arbitrageExecutor.connect(admin).setExecutor(attacker.address, true);

      await expect(
        arbitrageExecutor.connect(attacker).executeArbitrage(params)
      ).to.be.revertedWith("ERC20: transfer amount exceeds balance");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 5. ACCESS CONTROL & ROLE ENFORCEMENT
  // ─────────────────────────────────────────────────────────────────────────
  describe("5. Role & Access Control Enforcement", () => {
    it("should reject non-executors from calling executeArbitrage", async () => {
      const params = {
        routerBuy: await mockRouterBuy.getAddress(),
        routerSell: await mockRouterSell.getAddress(),
        tokenIn: await mockTokenIn.getAddress(),
        tokenOut: await mockTokenOut.getAddress(),
        amountIn: ethers.parseUnits("100", 6),
        minProfit: ethers.parseUnits("1", 6),
        deadline: Math.floor(Date.now() / 1000) + 3600,
      };

      await expect(
        arbitrageExecutor.connect(attacker).executeArbitrage(params)
      ).to.be.revertedWithCustomError(arbitrageExecutor, "Unauthorized");
    });

    it("should reject non-admin from modifying whitelists or roles", async () => {
      await expect(
        arbitrageExecutor.connect(attacker).setRouterWhitelist(attacker.address, true)
      ).to.be.revertedWithCustomError(arbitrageExecutor, "Unauthorized");

      await expect(
        arbitrageExecutor.connect(attacker).setTokenWhitelist(attacker.address, true)
      ).to.be.revertedWithCustomError(arbitrageExecutor, "Unauthorized");

      await expect(
        arbitrageExecutor.connect(attacker).setExecutor(attacker.address, true)
      ).to.be.revertedWithCustomError(arbitrageExecutor, "Unauthorized");

      await expect(
        arbitrageExecutor.connect(attacker).transferAdmin(attacker.address)
      ).to.be.revertedWithCustomError(arbitrageExecutor, "Unauthorized");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 6. EMERGENCY CONTROLS & WITHDRAWAL
  // ─────────────────────────────────────────────────────────────────────────
  describe("6. Emergency Controls & Pause Behavior", () => {
    it("should toggle pause and reject arbitrage execution while paused", async () => {
      await arbitrageExecutor.connect(admin).togglePause();
      expect(await arbitrageExecutor.paused()).to.be.true;

      const params = {
        routerBuy: await mockRouterBuy.getAddress(),
        routerSell: await mockRouterSell.getAddress(),
        tokenIn: await mockTokenIn.getAddress(),
        tokenOut: await mockTokenOut.getAddress(),
        amountIn: ethers.parseUnits("100", 6),
        minProfit: ethers.parseUnits("1", 6),
        deadline: Math.floor(Date.now() / 1000) + 3600,
      };

      await expect(
        arbitrageExecutor.connect(executor).executeArbitrage(params)
      ).to.be.revertedWithCustomError(arbitrageExecutor, "ContractPaused");

      // Unpause and verify execution works again
      await arbitrageExecutor.connect(admin).togglePause();
      expect(await arbitrageExecutor.paused()).to.be.false;
    });

    it("should allow admin emergency token withdrawal", async () => {
      // Simulate stranded funds
      await mockTokenIn.mint(await arbitrageExecutor.getAddress(), ethers.parseUnits("50", 6));

      const beforeBalance = await mockTokenIn.balanceOf(recipient.address);
      await arbitrageExecutor.connect(admin).emergencyWithdraw(
        await mockTokenIn.getAddress(),
        ethers.parseUnits("50", 6),
        recipient.address
      );
      const afterBalance = await mockTokenIn.balanceOf(recipient.address);

      expect(afterBalance - beforeBalance).to.equal(ethers.parseUnits("50", 6));
    });

    it("should allow admin emergency ETH withdrawal", async () => {
      // Send 1 ETH to contract
      await admin.sendTransaction({
        to: await arbitrageExecutor.getAddress(),
        value: ethers.parseEther("1.0"),
      });

      const beforeBal = await ethers.provider.getBalance(recipient.address);
      await arbitrageExecutor.connect(admin).emergencyWithdrawETH(recipient.address);
      const afterBal = await ethers.provider.getBalance(recipient.address);

      expect(afterBal - beforeBal).to.equal(ethers.parseEther("1.0"));
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 7. TRANSACTION SIMULATION VIEW FUNCTION
  // ─────────────────────────────────────────────────────────────────────────
  describe("7. simulateArbitrage View Function", () => {
    it("should simulate profitable arbitrage off-chain without committing state", async () => {
      await mockRouterBuy.setFixedOutputAmount(ethers.parseUnits("0.05", 18));
      await mockRouterSell.setFixedOutputAmount(ethers.parseUnits("105", 6));

      const params = {
        routerBuy: await mockRouterBuy.getAddress(),
        routerSell: await mockRouterSell.getAddress(),
        tokenIn: await mockTokenIn.getAddress(),
        tokenOut: await mockTokenOut.getAddress(),
        amountIn: ethers.parseUnits("100", 6),
        minProfit: ethers.parseUnits("2", 6),
        deadline: Math.floor(Date.now() / 1000) + 3600,
      };

      const [profitable, expectedProfit, leg1, leg2] = await arbitrageExecutor.simulateArbitrage(params);
      expect(profitable).to.be.true;
      expect(expectedProfit).to.equal(ethers.parseUnits("5", 6));
      expect(leg1).to.equal(ethers.parseUnits("0.05", 18));
      expect(leg2).to.equal(ethers.parseUnits("105", 6));
    });

    it("should return profitable=false when simulated returns do not meet minProfit", async () => {
      await mockRouterBuy.setFixedOutputAmount(ethers.parseUnits("0.05", 18));
      await mockRouterSell.setFixedOutputAmount(ethers.parseUnits("101", 6)); // Only $1 profit

      const params = {
        routerBuy: await mockRouterBuy.getAddress(),
        routerSell: await mockRouterSell.getAddress(),
        tokenIn: await mockTokenIn.getAddress(),
        tokenOut: await mockTokenOut.getAddress(),
        amountIn: ethers.parseUnits("100", 6),
        minProfit: ethers.parseUnits("2", 6), // requires $2
        deadline: Math.floor(Date.now() / 1000) + 3600,
      };

      const [profitable, expectedProfit] = await arbitrageExecutor.simulateArbitrage(params);
      expect(profitable).to.be.false;
      expect(expectedProfit).to.equal(0);
    });
  });
});
