/**
 * @file CircuitBreaker.ts
 * @description Centralized Circuit Breaker with 3-state machine (CLOSED, OPEN, HALF_OPEN)
 * and automatic cooldown/recovery mechanism for abnormal market conditions.
 */

import { CircuitBreakerState, CircuitBreakerStatus } from "./types";

export class CircuitBreaker {
  private state: CircuitBreakerState = "CLOSED";
  private tripReason?: string;
  private consecutiveFailures: number = 0;
  private currentDailyLossUsdt: number = 0;
  private lastTripTimestamp?: number;
  private lastStateChangeTimestamp: number = Date.now();
  private cooldownMs: number;
  private maxConsecutiveFailures: number;
  private maxDailyLossUsdt: number;

  constructor(
    cooldownMs: number = 30000,
    maxConsecutiveFailures: number = 3,
    maxDailyLossUsdt: number = 10.0
  ) {
    this.cooldownMs = cooldownMs;
    this.maxConsecutiveFailures = maxConsecutiveFailures;
    this.maxDailyLossUsdt = maxDailyLossUsdt;
  }

  /**
   * Evaluates current circuit breaker state, handling cooldown transitions
   */
  public getState(): CircuitBreakerState {
    const now = Date.now();

    // If currently OPEN, check if cooldown has elapsed to transition to HALF_OPEN
    if (this.state === "OPEN" && this.lastTripTimestamp) {
      if (now - this.lastTripTimestamp >= this.cooldownMs) {
        this.transitionTo("HALF_OPEN", "Cooldown period elapsed; entering HALF_OPEN recovery test mode");
      }
    }

    return this.state;
  }

  public isBlocked(): boolean {
    return this.getState() === "OPEN";
  }

  /**
   * Manually or automatically trip the circuit breaker
   */
  public trip(reason: string): void {
    this.tripReason = reason;
    this.lastTripTimestamp = Date.now();
    this.transitionTo("OPEN", reason);
  }

  /**
   * Records a failure event (e.g. simulation revert, execution error)
   */
  public recordFailure(reason: string): void {
    this.consecutiveFailures++;

    if (this.state === "HALF_OPEN") {
      this.trip(`Failure during HALF_OPEN recovery attempt: ${reason}`);
      return;
    }

    if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
      this.trip(`Consecutive failure threshold reached (${this.consecutiveFailures}/${this.maxConsecutiveFailures}): ${reason}`);
    }
  }

  /**
   * Records a successful execution / simulation
   */
  public recordSuccess(): void {
    this.consecutiveFailures = 0;
    if (this.state === "HALF_OPEN") {
      this.transitionTo("CLOSED", "Recovery test succeeded; circuit breaker fully restored to CLOSED");
      this.tripReason = undefined;
    }
  }

  /**
   * Records trade PnL against the daily loss budget
   */
  public recordTradePnl(netProfitUsdt: number): void {
    if (netProfitUsdt < 0) {
      this.currentDailyLossUsdt += Math.abs(netProfitUsdt);
      if (this.currentDailyLossUsdt >= this.maxDailyLossUsdt) {
        this.trip(`Daily loss limit reached: -$${this.currentDailyLossUsdt.toFixed(2)} USDT (max: -$${this.maxDailyLossUsdt.toFixed(2)} USDT)`);
      }
    }
  }

  /**
   * Resets the circuit breaker back to normal CLOSED state
   */
  public reset(): void {
    this.consecutiveFailures = 0;
    this.currentDailyLossUsdt = 0;
    this.tripReason = undefined;
    this.lastTripTimestamp = undefined;
    this.transitionTo("CLOSED", "Manual administrative reset");
  }

  public getStatus(): CircuitBreakerStatus {
    return {
      state: this.getState(),
      tripReason: this.tripReason,
      consecutiveFailures: this.consecutiveFailures,
      currentDailyLossUsdt: this.currentDailyLossUsdt,
      lastTripTimestamp: this.lastTripTimestamp,
      lastStateChangeTimestamp: this.lastStateChangeTimestamp
    };
  }

  private transitionTo(newState: CircuitBreakerState, reason: string): void {
    this.state = newState;
    this.lastStateChangeTimestamp = Date.now();
  }
}
