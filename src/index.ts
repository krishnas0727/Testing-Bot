/**
 * @file index.ts
 * @description Main entrypoint and barrel exports for DEX Arbitrage & Treasury System
 */

export * from "./types";
export * from "./config";
export * from "./interfaces/IMarketDataEngine";
export * from "./interfaces/IArbitrageEngine";
export * from "./interfaces/IRiskManager";
export * from "./interfaces/ISimulationEngine";
export * from "./interfaces/IExecutionEngine";
export * from "./interfaces/ITreasuryManager";
export * from "./market";
export * from "./profit";
export * from "./arbitrage";
export * from "./risk";
export * from "./recalculation";
export * from "./simulation";
export * from "./treasury";
export * from "./distribution";
export * from "./api";
export * from "./dashboard";

import { config } from "./config";

export function initializeSystem(): void {
  console.log("=================================================");
  console.log("  DEX ARBITRAGE & TREASURY SYSTEM (PHASE 0 & 1)  ");
  console.log("=================================================");
  console.log(`Active Chain ID   : ${config.chainId} (${config.chains[config.chainId]?.name})`);
  console.log(`Trading Mode      : ${config.tradingMode}`);
  console.log(`Auto Trade Enabled: ${config.autoTradeEnabled}`);
  console.log(`Emergency Stop    : ${config.emergencyStop ? "ACTIVE" : "STANDBY"}`);
  console.log(`Default Notional  : $${config.defaultTradeAmount.toFixed(2)} USDT`);
  console.log(`Max Price Impact  : ${config.maxPriceImpactPct.toFixed(2)}%`);
  console.log(`Max Slippage      : ${config.slippagePct.toFixed(2)}%`);
  console.log("=================================================");
  console.log("Phase 0 (Definition) and Phase 1 (Setup) completed successfully.");
}

if (require.main === module) {
  initializeSystem();
}
