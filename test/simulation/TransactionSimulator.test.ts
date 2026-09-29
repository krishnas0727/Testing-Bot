import { expect } from "chai";
import { ethers } from "ethers";
import { TransactionSimulator } from "../../src/simulation/TransactionSimulator";
import { TransactionBuilder } from "../../src/simulation/TransactionBuilder";
import { SimulationRequest } from "../../src/simulation/types";

describe("Phase 8: Transaction Simulation & Pre-Flight Validation Tests", () => {
  const getBaseRequest = (): SimulationRequest => {
    const nowSec = Math.floor(Date.now() / 1000);
    return {
      opportunityId: "opp_sim_test_101",
      chainId: 8453,
      contractAddress: "0x3333333333333333333333333333333333333333",
      executorAddress: "0x4444444444444444444444444444444444444444",
      buyDex: "Uniswap_V2",
      sellDex: "SushiSwap_V2",
      routerBuyAddress: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
      routerSellAddress: "0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891",
      tokenInAddress: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", // USDT
      tokenOutAddress: "0x4200000000000000000000000000000000000006", // WETH
      tokenInSymbol: "USDT",
      tokenOutSymbol: "WETH",
      tokenInDecimals: 6,
      tokenOutDecimals: 18,
      amountInRaw: 50000000n, // $50 USDT
      amountInFormatted: 50.0,
      expectedOutputRaw: 50700000n, // $50.70 USDT
      expectedOutputFormatted: 50.70,
      minOutputRaw: 50450000n, // $50.45 USDT (0.5% slippage floor)
      minOutputFormatted: 50.45,
      minNetProfitUsdt: 0.01,
      deadlineTimestamp: nowSec + 120, // 2 minutes in future
      currentBlock: 15000001,
      maxGasCostUsdt: 0.25,
      ethPriceUsdt: 3000.0,
      gasPriceGwei: 0.006,
      mockState: {
        isBuyRouterWhitelisted: true,
        isSellRouterWhitelisted: true,
        isTokenInWhitelisted: true,
        isTokenOutWhitelisted: true,
        isContractPaused: false,
        isExecutorAuthorized: true
      }
    };
  };

  it("should pass simulation for valid trade and mark isReadyForExecution = true", async () => {
    const simulator = new TransactionSimulator();
    const result = await simulator.simulateTransaction(getBaseRequest());

    expect(result.simulationStatus).to.equal("SIMULATION_PASSED");
    expect(result.isReadyForExecution).to.be.true;
    expect(result.revertReason).to.be.undefined;
    expect(result.transactionCalldata).to.be.a("string");
    expect(result.transactionCalldata.startsWith("0x")).to.be.true;
    expect(result.expectedNetProfitUsdt).to.be.greaterThan(0);
    expect(result.validationChecks.balanceValid).to.be.true;
    expect(result.validationChecks.allowanceValid).to.be.true;
    expect(result.validationChecks.tokenValid).to.be.true;
    expect(result.validationChecks.routerValid).to.be.true;
    expect(result.validationChecks.contractNotPaused).to.be.true;
    expect(result.validationChecks.executorAuthorized).to.be.true;
  });

  it("should catch transaction revert and mark SIMULATION_FAILED", async () => {
    const simulator = new TransactionSimulator();
    const req = getBaseRequest();
    req.mockState!.shouldRevert = true;
    req.mockState!.revertCustomError = "UnprofitableArbitrage(50100000, 50450000)";

    const result = await simulator.simulateTransaction(req);
    expect(result.simulationStatus).to.equal("SIMULATION_FAILED");
    expect(result.isReadyForExecution).to.be.false;
    expect(result.revertReason).to.include("UnprofitableArbitrage");
  });

  it("should detect insufficient executor balance", async () => {
    const simulator = new TransactionSimulator();
    const req = getBaseRequest();
    req.mockState!.executorBalanceRaw = 10000000n; // Only $10 < $50

    const result = await simulator.simulateTransaction(req);
    expect(result.simulationStatus).to.equal("SIMULATION_FAILED");
    expect(result.isReadyForExecution).to.be.false;
    expect(result.validationChecks.balanceValid).to.be.false;
    expect(result.revertReason).to.include("InsufficientBalance");
  });

  it("should detect insufficient executor allowance", async () => {
    const simulator = new TransactionSimulator();
    const req = getBaseRequest();
    req.mockState!.executorAllowanceRaw = 0n; // 0 allowance

    const result = await simulator.simulateTransaction(req);
    expect(result.simulationStatus).to.equal("SIMULATION_FAILED");
    expect(result.isReadyForExecution).to.be.false;
    expect(result.validationChecks.allowanceValid).to.be.false;
    expect(result.revertReason).to.include("InsufficientAllowance");
  });

  it("should reject non-whitelisted or identical routers", async () => {
    const simulator = new TransactionSimulator();
    const req = getBaseRequest();
    req.mockState!.isBuyRouterWhitelisted = false;

    const result = await simulator.simulateTransaction(req);
    expect(result.simulationStatus).to.equal("SIMULATION_FAILED");
    expect(result.validationChecks.routerValid).to.be.false;
    expect(result.revertReason).to.include("RouterNotWhitelisted");

    // Identical routers
    const req2 = getBaseRequest();
    req2.routerSellAddress = req2.routerBuyAddress;
    const result2 = await simulator.simulateTransaction(req2);
    expect(result2.simulationStatus).to.equal("SIMULATION_FAILED");
    expect(result2.revertReason).to.include("IdenticalRouters");
  });

  it("should reject non-whitelisted or identical tokens", async () => {
    const simulator = new TransactionSimulator();
    const req = getBaseRequest();
    req.mockState!.isTokenInWhitelisted = false;

    const result = await simulator.simulateTransaction(req);
    expect(result.simulationStatus).to.equal("SIMULATION_FAILED");
    expect(result.validationChecks.tokenValid).to.be.false;
    expect(result.revertReason).to.include("TokenNotWhitelisted");

    // Identical tokens
    const req2 = getBaseRequest();
    req2.tokenOutAddress = req2.tokenInAddress;
    const result2 = await simulator.simulateTransaction(req2);
    expect(result2.simulationStatus).to.equal("SIMULATION_FAILED");
    expect(result2.revertReason).to.include("IdenticalTokens");
  });

  it("should reject when simulated output violates slippage floor", async () => {
    const simulator = new TransactionSimulator();
    const req = getBaseRequest();
    req.mockState!.simulatedOutputRaw = 50200000n; // $50.20 < $50.45 minOutput

    const result = await simulator.simulateTransaction(req);
    expect(result.simulationStatus).to.equal("SIMULATION_FAILED");
    expect(result.isReadyForExecution).to.be.false;
    expect(result.validationChecks.outputValid).to.be.false;
    expect(result.revertReason).to.include("SlippageViolation");
  });

  it("should reject when simulated gas cost exceeds ceiling", async () => {
    const simulator = new TransactionSimulator();
    const req = getBaseRequest();
    req.mockState!.simulatedGasUsed = 35000000n; // Huge gas units -> $0.63 > $0.25

    const result = await simulator.simulateTransaction(req);
    expect(result.simulationStatus).to.equal("SIMULATION_FAILED");
    expect(result.validationChecks.gasValid).to.be.false;
    expect(result.revertReason).to.include("ExcessiveGasCost");
  });

  it("should reject when simulated net profit is below minimum required threshold", () => {
    const simulator = new TransactionSimulator();
    const req = getBaseRequest();
    // Output barely above input, net profit after gas is < $0.01
    req.mockState!.simulatedOutputRaw = 50011000n; // $50.011 (profit $0.011 - $0.005 gas = $0.006 < $0.01)

    return simulator.simulateTransaction(req).then((result) => {
      expect(result.simulationStatus).to.equal("SIMULATION_FAILED");
      expect(result.validationChecks.minProfitValid).to.be.false;
      expect(result.revertReason).to.include("UnprofitableArbitrage");
    });
  });

  it("should reject when transaction deadline is expired", async () => {
    const simulator = new TransactionSimulator();
    const req = getBaseRequest();
    req.deadlineTimestamp = Math.floor(Date.now() / 1000) - 10; // Expired 10s ago

    const result = await simulator.simulateTransaction(req);
    expect(result.simulationStatus).to.equal("SIMULATION_FAILED");
    expect(result.validationChecks.deadlineValid).to.be.false;
    expect(result.revertReason).to.include("ExpiredDeadline");
  });

  it("should reject when ArbitrageExecutor contract is paused", async () => {
    const simulator = new TransactionSimulator();
    const req = getBaseRequest();
    req.mockState!.isContractPaused = true;

    const result = await simulator.simulateTransaction(req);
    expect(result.simulationStatus).to.equal("SIMULATION_FAILED");
    expect(result.validationChecks.contractNotPaused).to.be.false;
    expect(result.revertReason).to.include("ContractPaused");
  });

  it("should reject when caller is an unauthorized executor", async () => {
    const simulator = new TransactionSimulator();
    const req = getBaseRequest();
    req.mockState!.isExecutorAuthorized = false;

    const result = await simulator.simulateTransaction(req);
    expect(result.simulationStatus).to.equal("SIMULATION_FAILED");
    expect(result.validationChecks.executorAuthorized).to.be.false;
    expect(result.revertReason).to.include("Unauthorized");
  });

  it("should reject upon RPC failure", async () => {
    const simulator = new TransactionSimulator();
    const req = getBaseRequest();
    req.mockState!.rpcFailure = true;

    const result = await simulator.simulateTransaction(req);
    expect(result.simulationStatus).to.equal("SIMULATION_FAILED");
    expect(result.revertReason).to.include("RPC Error");
  });

  it("should accurately encode and decode executeArbitrage transaction calldata", () => {
    const contractParams = {
      routerBuy: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
      routerSell: "0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891",
      tokenIn: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
      tokenOut: "0x4200000000000000000000000000000000000006",
      amountIn: 50000000n,
      minProfit: 10000n,
      deadline: 1800000000n
    };

    const calldata = TransactionBuilder.encodeExecuteArbitrage(contractParams);
    expect(calldata.startsWith("0x")).to.be.true;

    // Decode with Interface to verify round-trip fidelity
    const iface = TransactionBuilder.getInterface();
    const parsed = iface.parseTransaction({ data: calldata });
    expect(parsed?.name).to.equal("executeArbitrage");
    expect(parsed?.args[0].amountIn).to.equal(50000000n);
    expect(parsed?.args[0].routerBuy).to.equal(contractParams.routerBuy);
  });
});
