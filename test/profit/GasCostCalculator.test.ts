import { expect } from "chai";
import { GasCostCalculator } from "../../src/profit/math/GasCostCalculator";

describe("Phase 5: GasCostCalculator Unit Tests", () => {
  it("should calculate correct gas cost on Base L2 with sub-cent fees", () => {
    // 250,000 gas units, 0.006 Gwei, ETH = $3000
    // Execution Cost Native = 250,000 * 0.006e-9 = 0.0000015 ETH
    // Execution Cost USD = 0.0000015 * 3000 = $0.0045 USDT (< $0.005)
    const result = GasCostCalculator.calculateGasCost(
      250000n,
      0.006,
      3000.0,
      8453,
      0.0005 // L1 DA fee
    );

    expect(result.gasCostUsdt).to.be.closeTo(0.005, 0.001);
    expect(result.gasCostUsdt).to.be.greaterThan(0);
  });

  it("should handle high gas price scenarios (e.g. Ethereum L1 spike)", () => {
    // 250,000 gas units, 50 Gwei, ETH = $3000
    // Cost = 250,000 * 50e-9 * 3000 = $37.50
    const result = GasCostCalculator.calculateGasCost(
      250000n,
      50.0,
      3000.0,
      1
    );

    expect(result.gasCostUsdt).to.equal(37.5);
  });

  it("should return zero for zero gas units or zero price", () => {
    expect(GasCostCalculator.calculateGasCost(0n, 10, 3000).gasCostUsdt).to.equal(0);
    expect(GasCostCalculator.calculateGasCost(250000n, 0, 3000).gasCostUsdt).to.equal(0);
    expect(GasCostCalculator.calculateGasCost(250000n, 10, 0).gasCostUsdt).to.equal(0);
  });
});
