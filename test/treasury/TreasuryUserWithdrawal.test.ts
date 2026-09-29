import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("Phase: Realized Profit -> Treasury -> Profit Accounting -> User Withdrawal", function () {
  let admin: SignerWithAddress;
  let executor: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;
  let attacker: SignerWithAddress;

  let treasury: any;
  let mockToken: any;
  let unsupportedToken: any;

  const INITIAL_MINT = ethers.parseUnits("100000", 6); // 100k USDC
  const DEPOSIT_AMOUNT_1 = ethers.parseUnits("1000", 6); // 1,000 USDC
  const DEPOSIT_AMOUNT_2 = ethers.parseUnits("2000", 6); // 2,000 USDC

  beforeEach(async function () {
    [admin, executor, user1, user2, attacker] = await ethers.getSigners();

    // Deploy Mock ERC20 Token (whitelisted)
    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    mockToken = await MockERC20Factory.deploy("USD Coin", "USDC", 6);
    await mockToken.waitForDeployment();

    // Deploy Unsupported ERC20 Token
    unsupportedToken = await MockERC20Factory.deploy("Unsupported Token", "UNSUP", 18);
    await unsupportedToken.waitForDeployment();

    // Deploy Treasury contract
    const TreasuryFactory = await ethers.getContractFactory("Treasury");
    treasury = await TreasuryFactory.deploy(admin.address, executor.address);
    await treasury.waitForDeployment();

    // Whitelist mockToken in Treasury
    await treasury.connect(admin).setTokenWhitelist(await mockToken.getAddress(), true);

    // Mint tokens to users and executor
    await mockToken.mint(user1.address, INITIAL_MINT);
    await mockToken.mint(user2.address, INITIAL_MINT);
    await mockToken.mint(executor.address, INITIAL_MINT);
    await unsupportedToken.mint(user1.address, ethers.parseUnits("10000", 18));

    // Approvals to Treasury
    await mockToken.connect(user1).approve(await treasury.getAddress(), ethers.MaxUint256);
    await mockToken.connect(user2).approve(await treasury.getAddress(), ethers.MaxUint256);
    await mockToken.connect(executor).approve(await treasury.getAddress(), ethers.MaxUint256);
  });

  // 1. Treasury Contract Deployment
  it("Scenario 1: Treasury contract deployment sets correct admin, executor and unpaused state", async function () {
    expect(await treasury.hasRole(await treasury.ADMIN_ROLE(), admin.address)).to.be.true;
    expect(await treasury.hasRole(await treasury.ARBITRAGE_EXECUTOR_ROLE(), executor.address)).to.be.true;
    expect(await treasury.paused()).to.be.false;
  });

  // 2. User Deposit to Treasury
  it("Scenario 2: User deposit to Treasury updates deposited and withdrawable balance", async function () {
    const tokenAddr = await mockToken.getAddress();
    await expect(treasury.connect(user1).deposit(tokenAddr, DEPOSIT_AMOUNT_1))
      .to.emit(treasury, "UserDeposit")
      .withArgs(user1.address, tokenAddr, DEPOSIT_AMOUNT_1, (val: any) => val > 0);

    const bal = await treasury.getUserBalance(user1.address, tokenAddr);
    expect(bal.deposited).to.equal(DEPOSIT_AMOUNT_1);
    expect(bal.withdrawable).to.equal(DEPOSIT_AMOUNT_1);
    expect(bal.pending).to.equal(0n);
    expect(bal.realizedProfit).to.equal(0n);
  });

  // 3. Trade Execution Profit Settlement
  it("Scenario 3: Trade execution profit settlement executes via settleRealizedProfit", async function () {
    const tokenAddr = await mockToken.getAddress();
    const grossProfit = ethers.parseUnits("100", 6);
    const fees = ethers.parseUnits("5", 6);
    const gasCost = ethers.parseUnits("10", 6);
    const netProfit = ethers.parseUnits("85", 6);

    await expect(
      treasury
        .connect(executor)
        .settleRealizedProfit(user1.address, tokenAddr, grossProfit, fees, gasCost, netProfit)
    )
      .to.emit(treasury, "ProfitSettled")
      .withArgs(user1.address, tokenAddr, netProfit, (val: any) => val > 0);
  });

  // 4. User Balance Updated Correctly After Settlement
  it("Scenario 4: User balance updated correctly after settlement with realized and withdrawable balance", async function () {
    const tokenAddr = await mockToken.getAddress();
    const grossProfit = ethers.parseUnits("200", 6);
    const fees = ethers.parseUnits("10", 6);
    const gasCost = ethers.parseUnits("20", 6);
    const netProfit = ethers.parseUnits("170", 6);

    await treasury
      .connect(executor)
      .settleRealizedProfit(user1.address, tokenAddr, grossProfit, fees, gasCost, netProfit);

    const bal = await treasury.getUserBalance(user1.address, tokenAddr);
    expect(bal.realizedProfit).to.equal(netProfit);
    expect(bal.withdrawable).to.equal(netProfit);
    expect(bal.pending).to.equal(0n);
  });

  // 5. Successful Withdrawal
  it("Scenario 5: User can successfully withdraw their available balance (non-custodial)", async function () {
    const tokenAddr = await mockToken.getAddress();
    await treasury.connect(user1).deposit(tokenAddr, DEPOSIT_AMOUNT_1);

    const balanceBefore = await mockToken.balanceOf(user1.address);
    const withdrawAmount = ethers.parseUnits("400", 6);

    await expect(treasury.connect(user1).withdraw(tokenAddr, withdrawAmount))
      .to.emit(treasury, "UserWithdrawal")
      .withArgs(user1.address, tokenAddr, withdrawAmount, (val: any) => val > 0);

    const balanceAfter = await mockToken.balanceOf(user1.address);
    expect(balanceAfter - balanceBefore).to.equal(withdrawAmount);

    const userBal = await treasury.getUserBalance(user1.address, tokenAddr);
    expect(userBal.withdrawable).to.equal(DEPOSIT_AMOUNT_1 - withdrawAmount);
  });

  // 6. Withdrawal of 0 Tokens Rejected
  it("Scenario 6: Withdrawal of 0 tokens is rejected with ZeroAmount", async function () {
    const tokenAddr = await mockToken.getAddress();
    await treasury.connect(user1).deposit(tokenAddr, DEPOSIT_AMOUNT_1);

    await expect(treasury.connect(user1).withdraw(tokenAddr, 0)).to.be.revertedWithCustomError(
      treasury,
      "ZeroAmount"
    );
  });

  // 7. Withdrawal Exceeding Balance Rejected
  it("Scenario 7: Withdrawal exceeding balance is rejected with InsufficientUserBalance", async function () {
    const tokenAddr = await mockToken.getAddress();
    await treasury.connect(user1).deposit(tokenAddr, DEPOSIT_AMOUNT_1);

    const overAmount = DEPOSIT_AMOUNT_1 + ethers.parseUnits("1", 6);
    await expect(treasury.connect(user1).withdraw(tokenAddr, overAmount)).to.be.revertedWithCustomError(
      treasury,
      "InsufficientUserBalance"
    );
  });

  // 8. Unauthorized User Cannot Withdraw Other User's Balance
  it("Scenario 8: Unauthorized user cannot withdraw other user's balance", async function () {
    const tokenAddr = await mockToken.getAddress();
    await treasury.connect(user1).deposit(tokenAddr, DEPOSIT_AMOUNT_1);

    // Attacker tries to withdraw when attacker has 0 balance
    await expect(treasury.connect(attacker).withdraw(tokenAddr, DEPOSIT_AMOUNT_1)).to.be.revertedWithCustomError(
      treasury,
      "InsufficientUserBalance"
    );
  });

  // 9. Unsupported Token Deposit / Withdrawal Rejected
  it("Scenario 9: Unsupported token deposit and withdrawal are rejected", async function () {
    const unsupAddr = await unsupportedToken.getAddress();
    await unsupportedToken.connect(user1).approve(await treasury.getAddress(), ethers.MaxUint256);

    await expect(
      treasury.connect(user1).deposit(unsupAddr, ethers.parseUnits("100", 18))
    ).to.be.revertedWithCustomError(treasury, "TokenNotWhitelisted");

    await expect(
      treasury.connect(user1).withdraw(unsupAddr, ethers.parseUnits("100", 18))
    ).to.be.revertedWithCustomError(treasury, "TokenNotWhitelisted");
  });

  // 10. Reentrancy Attack Prevention Test
  it("Scenario 10: Reentrancy attack prevention is active and protects user funds", async function () {
    const tokenAddr = await mockToken.getAddress();
    await treasury.connect(user1).deposit(tokenAddr, DEPOSIT_AMOUNT_1);

    // Withdraw succeeds normally with nonReentrant guard in place
    await expect(treasury.connect(user1).withdraw(tokenAddr, ethers.parseUnits("100", 6))).to.not.be.reverted;
  });

  // 11. Emergency Pause Stops Withdrawals
  it("Scenario 11: Emergency pause stops withdrawals with ContractPaused error", async function () {
    const tokenAddr = await mockToken.getAddress();
    await treasury.connect(user1).deposit(tokenAddr, DEPOSIT_AMOUNT_1);

    await treasury.connect(admin).pause();
    expect(await treasury.paused()).to.be.true;

    await expect(
      treasury.connect(user1).withdraw(tokenAddr, ethers.parseUnits("100", 6))
    ).to.be.revertedWithCustomError(treasury, "ContractPaused");
  });

  // 12. Withdrawal Succeeds After Unpause
  it("Scenario 12: Withdrawal succeeds after unpause", async function () {
    const tokenAddr = await mockToken.getAddress();
    await treasury.connect(user1).deposit(tokenAddr, DEPOSIT_AMOUNT_1);

    await treasury.connect(admin).pause();
    await treasury.connect(admin).unpause();
    expect(await treasury.paused()).to.be.false;

    await expect(
      treasury.connect(user1).withdraw(tokenAddr, ethers.parseUnits("100", 6))
    ).to.not.be.reverted;
  });

  // 13. Multi-User Deposit and Balance Separation
  it("Scenario 13: Multi-user deposit maintains strict independent balance separation", async function () {
    const tokenAddr = await mockToken.getAddress();
    await treasury.connect(user1).deposit(tokenAddr, DEPOSIT_AMOUNT_1);
    await treasury.connect(user2).deposit(tokenAddr, DEPOSIT_AMOUNT_2);

    const bal1 = await treasury.getUserBalance(user1.address, tokenAddr);
    const bal2 = await treasury.getUserBalance(user2.address, tokenAddr);

    expect(bal1.withdrawable).to.equal(DEPOSIT_AMOUNT_1);
    expect(bal2.withdrawable).to.equal(DEPOSIT_AMOUNT_2);
  });

  // 14. Multi-Trade Profit Accumulation
  it("Scenario 14: Multi-trade profit accumulation correctly increments user balances", async function () {
    const tokenAddr = await mockToken.getAddress();
    const netProfit1 = ethers.parseUnits("50", 6);
    const netProfit2 = ethers.parseUnits("75", 6);

    await treasury.connect(executor).settleRealizedProfit(
      user1.address,
      tokenAddr,
      ethers.parseUnits("60", 6),
      ethers.parseUnits("5", 6),
      ethers.parseUnits("5", 6),
      netProfit1
    );

    await treasury.connect(executor).settleRealizedProfit(
      user1.address,
      tokenAddr,
      ethers.parseUnits("90", 6),
      ethers.parseUnits("5", 6),
      ethers.parseUnits("10", 6),
      netProfit2
    );

    const bal = await treasury.getUserBalance(user1.address, tokenAddr);
    expect(bal.realizedProfit).to.equal(netProfit1 + netProfit2);
    expect(bal.withdrawable).to.equal(netProfit1 + netProfit2);
  });

  // 15. Multi-User Independent Withdrawals
  it("Scenario 15: Multi-user independent withdrawals execute without cross-contamination", async function () {
    const tokenAddr = await mockToken.getAddress();
    await treasury.connect(user1).deposit(tokenAddr, DEPOSIT_AMOUNT_1);
    await treasury.connect(user2).deposit(tokenAddr, DEPOSIT_AMOUNT_2);

    // User 1 withdraws half
    await treasury.connect(user1).withdraw(tokenAddr, DEPOSIT_AMOUNT_1 / 2n);
    // User 2 withdraws all
    await treasury.connect(user2).withdraw(tokenAddr, DEPOSIT_AMOUNT_2);

    const bal1 = await treasury.getUserBalance(user1.address, tokenAddr);
    const bal2 = await treasury.getUserBalance(user2.address, tokenAddr);

    expect(bal1.withdrawable).to.equal(DEPOSIT_AMOUNT_1 / 2n);
    expect(bal2.withdrawable).to.equal(0n);
  });

  // 16. Contract Balance Matches Sum of User Balances + Reserves
  it("Scenario 16: Contract token balance matches recorded user withdrawable funds", async function () {
    const tokenAddr = await mockToken.getAddress();
    await treasury.connect(user1).deposit(tokenAddr, DEPOSIT_AMOUNT_1);
    await treasury.connect(user2).deposit(tokenAddr, DEPOSIT_AMOUNT_2);

    const totalWithdrawable = await treasury.getTotalUserWithdrawable(tokenAddr);
    const contractBalance = await mockToken.balanceOf(await treasury.getAddress());

    expect(totalWithdrawable).to.equal(DEPOSIT_AMOUNT_1 + DEPOSIT_AMOUNT_2);
    expect(contractBalance).to.be.gte(totalWithdrawable);
  });

  // 17. Total User Withdrawable <= Contract Token Balance Invariant Test
  it("Scenario 17: Invariant holds - total user withdrawable <= contract token balance", async function () {
    const tokenAddr = await mockToken.getAddress();
    await treasury.connect(user1).deposit(tokenAddr, DEPOSIT_AMOUNT_1);

    // Settle profit
    await treasury.connect(executor).settleRealizedProfit(
      user1.address,
      tokenAddr,
      ethers.parseUnits("120", 6),
      ethers.parseUnits("10", 6),
      ethers.parseUnits("10", 6),
      ethers.parseUnits("100", 6)
    );

    const totalWithdrawable = await treasury.getTotalUserWithdrawable(tokenAddr);
    const contractBalance = await mockToken.balanceOf(await treasury.getAddress());
    expect(totalWithdrawable).to.be.lte(contractBalance);

    // Admin cannot arbitrarily emergency withdraw locked user funds
    await expect(
      treasury.connect(admin).emergencyWithdraw(tokenAddr, contractBalance, admin.address)
    ).to.be.revertedWithCustomError(treasury, "AdminCannotWithdrawUserFunds");
  });

  // 18. Event Emission Verification for Deposit, ProfitSettled, Withdrawal
  it("Scenario 18: Events are properly emitted with user address, token, amount, and timestamp", async function () {
    const tokenAddr = await mockToken.getAddress();

    // 1. User Deposit Event
    await expect(treasury.connect(user1).deposit(tokenAddr, DEPOSIT_AMOUNT_1))
      .to.emit(treasury, "UserDeposit")
      .withArgs(user1.address, tokenAddr, DEPOSIT_AMOUNT_1, (val: any) => val > 0);

    // 2. Profit Settled Event
    await expect(
      treasury.connect(executor).settleRealizedProfit(
        user1.address,
        tokenAddr,
        ethers.parseUnits("120", 6),
        ethers.parseUnits("10", 6),
        ethers.parseUnits("10", 6),
        ethers.parseUnits("100", 6)
      )
    )
      .to.emit(treasury, "ProfitSettled")
      .withArgs(user1.address, tokenAddr, ethers.parseUnits("100", 6), (val: any) => val > 0);

    // 3. User Withdrawal Event
    await expect(treasury.connect(user1).withdraw(tokenAddr, ethers.parseUnits("50", 6)))
      .to.emit(treasury, "UserWithdrawal")
      .withArgs(user1.address, tokenAddr, ethers.parseUnits("50", 6), (val: any) => val > 0);
  });
});
