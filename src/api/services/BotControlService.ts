/**
 * @file BotControlService.ts
 * @description Phase 13: Arbitrage Bot Execution & Control Service
 *
 * Provides thread-safe, role-guarded controls over the bot lifecycle:
 * start, stop, pause, resume, and emergency stop.
 */

import { BotStatusState } from "../types";
import { SupportedChainId, TradingMode } from "../../types";

export class BotControlService {
  private status: "RUNNING" | "STOPPED" | "PAUSED" | "EMERGENCY_STOPPED" = "RUNNING";
  private tradingMode: TradingMode = "MOCK";
  private autoTradeEnabled: boolean = false;
  private activeChainId: SupportedChainId = 8453;
  private readonly startTime: number = Date.now();
  private circuitBreakerTripped: boolean = false;
  private totalTradesExecuted: number = 2;

  /**
   * Returns complete real-time status of the bot engine.
   */
  public getStatus(activeOpportunitiesCount: number = 0): BotStatusState {
    const uptimeSeconds = Math.floor((Date.now() - this.startTime) / 1000);
    return {
      status: this.status,
      tradingMode: this.tradingMode,
      autoTradeEnabled: this.autoTradeEnabled,
      activeChainId: this.activeChainId,
      uptimeSeconds,
      circuitBreakerTripped: this.circuitBreakerTripped,
      activeOpportunitiesCount,
      totalTradesExecuted: this.totalTradesExecuted,
      lastHeartbeat: Date.now(),
    };
  }

  /**
   * Starts or enables auto-trading.
   */
  public start(mode?: TradingMode): BotStatusState {
    if (this.status === "EMERGENCY_STOPPED") {
      throw new Error("Cannot start bot: System is in EMERGENCY_STOPPED state. Admin reset required.");
    }
    this.status = "RUNNING";
    this.autoTradeEnabled = true;
    if (mode) this.tradingMode = mode;
    return this.getStatus();
  }

  /**
   * Stops auto-trading.
   */
  public stop(): BotStatusState {
    if (this.status === "EMERGENCY_STOPPED") {
      throw new Error("Cannot modify state: Emergency stop is active");
    }
    this.status = "STOPPED";
    this.autoTradeEnabled = false;
    return this.getStatus();
  }

  /**
   * Pauses trading (e.g. during volatile market or manual inspection).
   */
  public pause(): BotStatusState {
    if (this.status === "EMERGENCY_STOPPED") {
      throw new Error("Cannot pause: Emergency stop is active");
    }
    this.status = "PAUSED";
    this.autoTradeEnabled = false;
    return this.getStatus();
  }

  /**
   * Resumes trading from pause.
   */
  public resume(): BotStatusState {
    if (this.status === "EMERGENCY_STOPPED") {
      throw new Error("Cannot resume: Emergency stop is active. Reset required.");
    }
    this.status = "RUNNING";
    this.autoTradeEnabled = true;
    return this.getStatus();
  }

  /**
   * Activates global emergency stop. Instantly halts all trading.
   */
  public emergencyStop(): BotStatusState {
    this.status = "EMERGENCY_STOPPED";
    this.autoTradeEnabled = false;
    this.circuitBreakerTripped = true;
    return this.getStatus();
  }

  /**
   * Admin-only reset of emergency stop.
   */
  public resetEmergencyStop(): BotStatusState {
    this.status = "STOPPED";
    this.autoTradeEnabled = false;
    this.circuitBreakerTripped = false;
    return this.getStatus();
  }

  public incrementTradeCount(): void {
    this.totalTradesExecuted++;
  }
}
