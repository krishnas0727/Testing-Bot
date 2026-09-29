/**
 * @file index.ts
 * @description Barrel exports for Phase 3: Market Data Engine
 */

export * from "./types";
export * from "./adapters/IDEXAdapter";
export * from "./adapters/UniswapV2Adapter";
export * from "./normalizer/DataNormalizer";
export * from "./validator/PoolDataValidator";
export * from "./cache/PoolStateCache";
export * from "./MarketDataService";
