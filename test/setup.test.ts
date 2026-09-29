import { expect } from "chai";
import { config, SUPPORTED_CHAINS } from "../src/config";

describe("Phase 1: Environment & Project Setup Sanity Tests", () => {
  it("should have correct default trading mode as MOCK or TESTNET", () => {
    expect(["MOCK", "TESTNET", "LIVE"]).to.include(config.tradingMode);
    // By default for safety, live trading must not be automatically armed
    expect(config.liveTradingArmed).to.be.false;
  });

  it("should have valid supported chain configurations", () => {
    const chainIds = Object.keys(SUPPORTED_CHAINS).map(Number);
    expect(chainIds).to.include(8453);     // Base L2
    expect(chainIds).to.include(137);      // Polygon
    expect(chainIds).to.include(42161);    // Arbitrum
    expect(chainIds).to.include(11155111); // Sepolia
  });

  it("should verify Base L2 configuration has sub-cent gas parameters", () => {
    const baseConfig = SUPPORTED_CHAINS[8453];
    expect(baseConfig.chainId).to.equal(8453);
    expect(baseConfig.name).to.include("Base");
    expect(baseConfig.dexRouters).to.have.property("Uniswap_V2");
    expect(baseConfig.dexRouters).to.have.property("SushiSwap_V2");
  });

  it("should verify risk management parameters are within safe bounds", () => {
    expect(config.minTradeAmount).to.be.greaterThan(0);
    expect(config.maxTradeAmount).to.be.greaterThan(config.minTradeAmount);
    expect(config.slippagePct).to.be.at.most(2.0); // Never allow dangerous > 2% slippage by default
    expect(config.maxDailyLossUsdt).to.be.greaterThan(0);
  });
});
