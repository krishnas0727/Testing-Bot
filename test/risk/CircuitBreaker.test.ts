import { expect } from "chai";
import { CircuitBreaker } from "../../src/risk/CircuitBreaker";

describe("Phase 6: CircuitBreaker Unit & State Transition Tests", () => {
  it("should start in CLOSED state and not block execution", () => {
    const cb = new CircuitBreaker(1000, 3, 10.0);
    expect(cb.getState()).to.equal("CLOSED");
    expect(cb.isBlocked()).to.be.false;
  });

  it("should trip and transition to OPEN when consecutive failures reach threshold", () => {
    const cb = new CircuitBreaker(1000, 3, 10.0);

    cb.recordFailure("Simulation revert 1");
    expect(cb.getState()).to.equal("CLOSED");

    cb.recordFailure("Simulation revert 2");
    expect(cb.getState()).to.equal("CLOSED");

    cb.recordFailure("Simulation revert 3");
    expect(cb.getState()).to.equal("OPEN");
    expect(cb.isBlocked()).to.be.true;
    expect(cb.getStatus().consecutiveFailures).to.equal(3);
    expect(cb.getStatus().tripReason).to.include("Consecutive failure threshold reached");
  });

  it("should reset consecutive failure count upon recording success", () => {
    const cb = new CircuitBreaker(1000, 3, 10.0);

    cb.recordFailure("Failure 1");
    cb.recordFailure("Failure 2");
    expect(cb.getStatus().consecutiveFailures).to.equal(2);

    cb.recordSuccess();
    expect(cb.getStatus().consecutiveFailures).to.equal(0);
    expect(cb.getState()).to.equal("CLOSED");
  });

  it("should trip when daily loss limit is reached", () => {
    const cb = new CircuitBreaker(1000, 3, 10.0);

    cb.recordTradePnl(-4.0); // Loss of $4
    expect(cb.getState()).to.equal("CLOSED");

    cb.recordTradePnl(-6.5); // Cumulative loss $10.5 > $10.0 max
    expect(cb.getState()).to.equal("OPEN");
    expect(cb.isBlocked()).to.be.true;
    expect(cb.getStatus().tripReason).to.include("Daily loss limit reached");
  });

  it("should allow manual trip and administrative reset", () => {
    const cb = new CircuitBreaker(1000, 3, 10.0);

    cb.trip("Manual emergency shutdown by admin");
    expect(cb.getState()).to.equal("OPEN");
    expect(cb.isBlocked()).to.be.true;

    cb.reset();
    expect(cb.getState()).to.equal("CLOSED");
    expect(cb.isBlocked()).to.be.false;
    expect(cb.getStatus().tripReason).to.be.undefined;
  });

  it("should transition from OPEN to HALF_OPEN after cooldown elapses", async () => {
    const cooldownMs = 50; // Short cooldown for testing
    const cb = new CircuitBreaker(cooldownMs, 2, 10.0);

    cb.trip("Temporary network instability");
    expect(cb.getState()).to.equal("OPEN");

    await new Promise((resolve) => setTimeout(resolve, 60));

    // After cooldown, should be HALF_OPEN
    expect(cb.getState()).to.equal("HALF_OPEN");
    expect(cb.isBlocked()).to.be.false; // HALF_OPEN allows a test opportunity
  });

  it("should recover from HALF_OPEN to CLOSED upon successful execution", async () => {
    const cooldownMs = 30;
    const cb = new CircuitBreaker(cooldownMs, 2, 10.0);

    cb.trip("Testing recovery");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(cb.getState()).to.equal("HALF_OPEN");

    cb.recordSuccess();
    expect(cb.getState()).to.equal("CLOSED");
  });

  it("should immediately trip back to OPEN if a failure occurs during HALF_OPEN", async () => {
    const cooldownMs = 30;
    const cb = new CircuitBreaker(cooldownMs, 2, 10.0);

    cb.trip("Initial trip");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(cb.getState()).to.equal("HALF_OPEN");

    cb.recordFailure("Test trade failed during recovery");
    expect(cb.getState()).to.equal("OPEN");
    expect(cb.getStatus().tripReason).to.include("Failure during HALF_OPEN");
  });
});
