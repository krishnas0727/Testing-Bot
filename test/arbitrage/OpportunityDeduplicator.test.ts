import { expect } from "chai";
import { OpportunityDeduplicator } from "../../src/arbitrage/deduplicator/OpportunityDeduplicator";

describe("Phase 4: OpportunityDeduplicator Unit Tests", () => {
  it("should detect duplicate opportunity within sliding time window", () => {
    const deduplicator = new OpportunityDeduplicator(2000); // 2000ms window

    // First appearance
    const isDup1 = deduplicator.isDuplicate(8453, "WETH/USDT", "Uniswap_V2", "SushiSwap_V2", 10.0, 1.5);
    expect(isDup1).to.be.false;

    // Immediately subsequent check with same spread
    const isDup2 = deduplicator.isDuplicate(8453, "WETH/USDT", "Uniswap_V2", "SushiSwap_V2", 10.0, 1.5);
    expect(isDup2).to.be.true;
  });

  it("should distinguish different trade sizes or DEX pairs", () => {
    const deduplicator = new OpportunityDeduplicator(2000);

    const isDup1 = deduplicator.isDuplicate(8453, "WETH/USDT", "Uniswap_V2", "SushiSwap_V2", 10.0, 1.5);
    expect(isDup1).to.be.false;

    // Different size
    const isDup2 = deduplicator.isDuplicate(8453, "WETH/USDT", "Uniswap_V2", "SushiSwap_V2", 25.0, 1.5);
    expect(isDup2).to.be.false;

    // Different pair
    const isDup3 = deduplicator.isDuplicate(8453, "CBETH/USDT", "Uniswap_V2", "SushiSwap_V2", 10.0, 1.5);
    expect(isDup3).to.be.false;
  });

  it("should allow re-emission if spread significantly diverges (>25% change)", () => {
    const deduplicator = new OpportunityDeduplicator(5000);

    // Initial spread 1.0%
    const isDup1 = deduplicator.isDuplicate(8453, "WETH/USDT", "Uniswap_V2", "SushiSwap_V2", 10.0, 1.0);
    expect(isDup1).to.be.false;

    // Spread widens by 40% (1.0% -> 1.40%)
    const isDup2 = deduplicator.isDuplicate(8453, "WETH/USDT", "Uniswap_V2", "SushiSwap_V2", 10.0, 1.40);
    expect(isDup2).to.be.false; // Not duplicate because volatility divergence
  });

  it("should prune old items outside the deduplication window", async () => {
    const deduplicator = new OpportunityDeduplicator(50); // 50ms short window for test

    deduplicator.isDuplicate(8453, "WETH/USDT", "Uniswap_V2", "SushiSwap_V2", 10.0, 1.0);
    expect(deduplicator.size()).to.equal(1);

    await new Promise((resolve) => setTimeout(resolve, 60));

    const pruned = deduplicator.prune();
    expect(pruned).to.equal(1);
    expect(deduplicator.size()).to.equal(0);
  });
});
