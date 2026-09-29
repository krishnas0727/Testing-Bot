import { expect } from "chai";
import { ethers } from "hardhat";
import { Treasury, MockERC20 } from "../../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("Phase 10: Treasury.sol Smart Contract Security & Accounting Tests", () => {
  let treasury: Treasury;
  let usdt: MockERC20;
  let usdc: MockERC20;
  let admin: HardhatEthersSigner;
  let manager: HardhatEthersSigner;
  let executor: HardhatEthersSigner;
  let pauser: HardhatEthersSigner;
  let attacker: HardhatEthersSigner;
  let recipient: HardhatEthersSigner;

  const ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));
  const TREASURY_MANAGER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("TREASURY_MANAGER_ROLE"));
  const ARBITRAGE_EXECUTOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ARBITRAGE_EXECUTOR_ROLE"));
  const PAUSER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("PAUSER_ROLE"));

  beforeEach(async () => {
    [admin, manager, executor, pauser, attacker, recipient] = await ethers.getSigners();

    // Deploy mock tokens
    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    usdt = (await MockERC20Factory.deploy("Tether USD", "USDT", 6)) as unknown as MockERC20;
    usdc = (await MockERC20Factory.deploy("USD Coin", "USDC", 6)) as unknown as MockERC20;

    // Deploy Treasury contract
    const TreasuryFactory = await ethers.getContractFactory("Treasury");
    treasury = (await TreasuryFactory.deploy(admin.address, executor.address)) as unknown as Treasury;

    // Grant roles
    await treasury.connect(admin).grantRole(TREASURY_MANAGER_ROLE, manager.address);
    await treasury.connect(admin).grantRole(PAUSER_ROLE, pauser.address);

    // Whitelist USDT and USDC
    await treasury.connect(manager).setTokenWhitelist(await usdt.getAddress(), true);
    await treasury.connect(manager).setTokenWhitelist(await usdc.getAddress(), true);

    // Mint tokens to executor and admin
    await usdt.mint(executor.address, ethers.parseUnits("10000.0", 6));
    await usdt.mint(admin.address, ethers.parseUnits("10000.0", 6));
    await usdc.mint(executor.address, ethers.parseUnits("10000.0", 6));
  });

  describe("Access Control & Role Initialization", () => {
    it("should assign correct initial roles to admin and executor", async () => {
      expect(await treasury.hasRole(ADMIN_ROLE, admin.address)).to.be.true;
      expect(await treasury.hasRole(TREASURY_MANAGER_ROLE, admin.address)).to.be.true;
      expect(await treasury.hasRole(ARBITRAGE_EXECUTOR_ROLE, executor.address)).to.be.true;
      expect(await treasury.hasRole(PAUSER_ROLE, pauser.address)).to.be.true;
      expect(await treasury.hasRole(ADMIN_ROLE, attacker.address)).to.be.false;
      expect(await treasury.hasRole(ARBITRAGE_EXECUTOR_ROLE, attacker.address)).to.be.false;
    });

    it("should allow admin to grant and revoke roles", async () => {
      await treasury.connect(admin).grantRole(TREASURY_MANAGER_ROLE, attacker.address);
      expect(await treasury.hasRole(TREASURY_MANAGER_ROLE, attacker.address)).to.be.true;

      await treasury.connect(admin).revokeRole(TREASURY_MANAGER_ROLE, attacker.address);
      expect(await treasury.hasRole(TREASURY_MANAGER_ROLE, attacker.address)).to.be.false;
    });

    it("should prevent non-admin from granting roles", async () => {
      await expect(
        treasury.connect(attacker).grantRole(ADMIN_ROLE, attacker.address)
      ).to.be.revertedWithCustomError(treasury, "Unauthorized");
    });
  });

  describe("Profit Reception & Multi-Bucket Accounting", () => {
    it("should allow authorized executor to deposit realized profit and allocate across 5 buckets", async () => {
      const profitAmount = ethers.parseUnits("1000.0", 6); // 1,000 USDT
      const usdtAddress = await usdt.getAddress();

      // Approve Treasury
      await usdt.connect(executor).approve(await treasury.getAddress(), profitAmount);

      // Deposit Profit
      await expect(treasury.connect(executor).depositProfit(usdtAddress, profitAmount))
        .to.emit(treasury, "ProfitReceived")
        .withArgs(
          executor.address,
          usdtAddress,
          profitAmount,
          ethers.parseUnits("500.0", 6), // 50% Trading Capital
          ethers.parseUnits("150.0", 6), // 15% Gas Reserve
          ethers.parseUnits("150.0", 6), // 15% Profit Reserve
          ethers.parseUnits("100.0", 6), // 10% Emergency Reserve
          ethers.parseUnits("100.0", 6), // 10% Revenue
          await ethers.provider.getBlock("latest").then((b) => b!.timestamp + 1)
        );

      const balances = await treasury.getBucketBalances(usdtAddress);
      expect(balances.tradingCapital).to.equal(ethers.parseUnits("500.0", 6));
      expect(balances.gasReserve).to.equal(ethers.parseUnits("150.0", 6));
      expect(balances.profitReserve).to.equal(ethers.parseUnits("150.0", 6));
      expect(balances.emergencyReserve).to.equal(ethers.parseUnits("100.0", 6));
      expect(balances.revenue).to.equal(ethers.parseUnits("100.0", 6));
      expect(balances.totalRealizedProfit).to.equal(profitAmount);
    });

    it("should reject profit deposit from unauthorized address", async () => {
      const usdtAddress = await usdt.getAddress();
      await expect(
        treasury.connect(attacker).depositProfit(usdtAddress, 1000n)
      ).to.be.revertedWithCustomError(treasury, "Unauthorized");
    });

    it("should reject deposit of non-whitelisted token", async () => {
      const MockERC20Factory = await ethers.getContractFactory("MockERC20");
      const shitcoin = await MockERC20Factory.deploy("Shitcoin", "SCAM", 18);
      const scamAddress = await shitcoin.getAddress();

      await expect(
        treasury.connect(executor).depositProfit(scamAddress, 1000n)
      ).to.be.revertedWithCustomError(treasury, "TokenNotWhitelisted");
    });
  });

  describe("Withdrawals & Limit Security", () => {
    beforeEach(async () => {
      // Fund Treasury with 1,000 USDT in profit
      const profitAmount = ethers.parseUnits("1000.0", 6);
      const usdtAddress = await usdt.getAddress();
      await usdt.connect(executor).approve(await treasury.getAddress(), profitAmount);
      await treasury.connect(executor).depositProfit(usdtAddress, profitAmount);

      // Set withdrawal limits: max 300 per tx, max 600 daily
      await treasury.connect(admin).setWithdrawalLimits(
        usdtAddress,
        ethers.parseUnits("300.0", 6),
        ethers.parseUnits("600.0", 6)
      );
    });

    it("should allow treasury manager to withdraw within limits", async () => {
      const usdtAddress = await usdt.getAddress();
      const withdrawAmount = ethers.parseUnits("200.0", 6);

      // Bucket 0 = TRADING_CAPITAL
      await expect(
        treasury.connect(manager).withdraw(usdtAddress, withdrawAmount, recipient.address, 0)
      )
        .to.emit(treasury, "Withdrawal")
        .withArgs(
          recipient.address,
          usdtAddress,
          withdrawAmount,
          0,
          await ethers.provider.getBlock("latest").then((b) => b!.timestamp + 1)
        );

      expect(await usdt.balanceOf(recipient.address)).to.equal(withdrawAmount);
    });

    it("should reject withdrawal exceeding per-transaction limit", async () => {
      const usdtAddress = await usdt.getAddress();
      const excessiveAmount = ethers.parseUnits("350.0", 6); // 350 > 300 max

      await expect(
        treasury.connect(manager).withdraw(usdtAddress, excessiveAmount, recipient.address, 0)
      ).to.be.revertedWithCustomError(treasury, "WithdrawalLimitExceeded");
    });

    it("should reject withdrawal exceeding daily limit", async () => {
      const usdtAddress = await usdt.getAddress();
      // Withdraw 250 twice = 500
      await treasury.connect(manager).withdraw(usdtAddress, ethers.parseUnits("250.0", 6), recipient.address, 0);
      await treasury.connect(manager).withdraw(usdtAddress, ethers.parseUnits("250.0", 6), recipient.address, 0);

      // Third withdrawal of 200 would make 700 > 600 daily limit
      await expect(
        treasury.connect(manager).withdraw(usdtAddress, ethers.parseUnits("200.0", 6), recipient.address, 0)
      ).to.be.revertedWithCustomError(treasury, "DailyWithdrawalLimitExceeded");
    });

    it("should prevent unauthorized users or executor from withdrawing", async () => {
      const usdtAddress = await usdt.getAddress();
      // ArbitrageExecutor should NOT have withdrawal permissions
      await expect(
        treasury.connect(executor).withdraw(usdtAddress, 100n, recipient.address, 0)
      ).to.be.revertedWithCustomError(treasury, "Unauthorized");

      // Attacker should NOT have withdrawal permissions
      await expect(
        treasury.connect(attacker).withdraw(usdtAddress, 100n, recipient.address, 0)
      ).to.be.revertedWithCustomError(treasury, "Unauthorized");
    });

    it("should reject withdrawal if bucket has insufficient balance", async () => {
      const usdtAddress = await usdt.getAddress();
      // Revenue bucket has 100 USDT; try to withdraw 200 USDT
      await expect(
        treasury.connect(manager).withdraw(usdtAddress, ethers.parseUnits("200.0", 6), recipient.address, 4) // Bucket 4 = REVENUE
      ).to.be.revertedWithCustomError(treasury, "InsufficientBucketBalance");
    });
  });

  describe("Circuit Breaker & Pause Protection", () => {
    it("should pause and block deposits and withdrawals when paused", async () => {
      const usdtAddress = await usdt.getAddress();
      await treasury.connect(pauser).pause();
      expect(await treasury.paused()).to.be.true;

      await expect(
        treasury.connect(executor).depositProfit(usdtAddress, 100n)
      ).to.be.revertedWithCustomError(treasury, "ContractPaused");

      await expect(
        treasury.connect(manager).withdraw(usdtAddress, 100n, recipient.address, 0)
      ).to.be.revertedWithCustomError(treasury, "ContractPaused");

      // Unpause restores functionality
      await treasury.connect(pauser).unpause();
      expect(await treasury.paused()).to.be.false;
    });

    it("should allow admin emergency withdrawal even during crisis", async () => {
      const usdtAddress = await usdt.getAddress();
      await usdt.mint(await treasury.getAddress(), ethers.parseUnits("500.0", 6));

      await expect(
        treasury.connect(admin).emergencyWithdraw(usdtAddress, ethers.parseUnits("500.0", 6), recipient.address)
      ).to.emit(treasury, "EmergencyWithdrawal");

      expect(await usdt.balanceOf(recipient.address)).to.equal(ethers.parseUnits("500.0", 6));
    });
  });

  describe("Configuration & Allocation Adjustments", () => {
    it("should allow admin to update allocation ratios summing to 10,000 bps", async () => {
      await expect(
        treasury.connect(admin).setAllocationRatios(4000, 2000, 2000, 1000, 1000)
      ).to.emit(treasury, "AllocationUpdated");

      expect(await treasury.tradingCapitalBps()).to.equal(4000);
      expect(await treasury.gasReserveBps()).to.equal(2000);
    });

    it("should reject allocation ratios not summing to 10,000 bps", async () => {
      await expect(
        treasury.connect(admin).setAllocationRatios(5000, 2000, 2000, 1000, 500) // Sum = 10500
      ).to.be.revertedWithCustomError(treasury, "InvalidAllocationSum");
    });

    it("should support Phase 11 3-bucket allocation (60% Trading, 20% Reserve, 20% Revenue)", async () => {
      await treasury.connect(admin).setThreeBucketAllocation(6000, 2000, 2000);

      expect(await treasury.tradingCapitalBps()).to.equal(6000);
      expect(await treasury.profitReserveBps()).to.equal(2000);
      expect(await treasury.revenueBps()).to.equal(2000);
      expect(await treasury.gasReserveBps()).to.equal(0);
      expect(await treasury.emergencyReserveBps()).to.equal(0);
    });

    it("should reject 3-bucket allocation not summing to 10,000 bps", async () => {
      await expect(
        treasury.connect(admin).setThreeBucketAllocation(6000, 2000, 2500) // Sum = 10500
      ).to.be.revertedWithCustomError(treasury, "InvalidAllocationSum");
    });

    it("should reject non-admin from updating 3-bucket allocation", async () => {
      await expect(
        treasury.connect(attacker).setThreeBucketAllocation(6000, 2000, 2000)
      ).to.be.revertedWithCustomError(treasury, "Unauthorized");
    });
  });

  describe("Multiple Tokens & Reentrancy Safety", () => {
    it("should track multiple tokens independently in the accounting ledger", async () => {
      const usdtAddress = await usdt.getAddress();
      const usdcAddress = await usdc.getAddress();

      await usdt.connect(executor).approve(await treasury.getAddress(), ethers.parseUnits("100.0", 6));
      await usdc.connect(executor).approve(await treasury.getAddress(), ethers.parseUnits("200.0", 6));

      await treasury.connect(executor).depositProfit(usdtAddress, ethers.parseUnits("100.0", 6));
      await treasury.connect(executor).depositProfit(usdcAddress, ethers.parseUnits("200.0", 6));

      const usdtBalances = await treasury.getBucketBalances(usdtAddress);
      const usdcBalances = await treasury.getBucketBalances(usdcAddress);

      expect(usdtBalances.totalRealizedProfit).to.equal(ethers.parseUnits("100.0", 6));
      expect(usdcBalances.totalRealizedProfit).to.equal(ethers.parseUnits("200.0", 6));
    });

    it("should revert on failed ERC-20 transfer", async () => {
      const usdtAddress = await usdt.getAddress();
      await usdt.connect(executor).approve(await treasury.getAddress(), 1000n);
      await usdt.setFailTransfer(true);

      await expect(
        treasury.connect(executor).depositProfit(usdtAddress, 1000n)
      ).to.be.revertedWithCustomError(treasury, "TransferFailed");
    });
  });
});
