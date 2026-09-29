import { expect } from "chai";
import { ethers } from "ethers";
import { PoolDataValidator } from "../../src/market/validator/PoolDataValidator";
import { NormalizedPoolState } from "../../src/market/types";

describe("Phase 3: PoolDataValidator Unit Tests", () => {
  const validPool: NormalizedPoolState = {
    id: "8453:Uniswap_V2:WETH-USDC",
    chainId: 8453,
    dexName: "Uniswap_V2",
    protocol: "UNISWAP_V2",
    poolAddress: "0x1111111111111111111111111111111111111111",
    pairSymbol: "WETH/USDC",
    baseToken: {
      address: "0x4200000000000000000000000000000000000006",
      symbol: "WETH",
      decimals: 18,
      reserve: 50.0,
      rawReserve: ethers.parseUnits("50.0", 18)
    },
    quoteToken: {
      address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      symbol: "USDC",
      decimals: 6,
      reserve: 150000.0,
      rawReserve: ethers.parseUnits("150000.0", 6)
    },
    spotPrice: 3000.0,
    inversePrice: 1 / 3000.0,
    liquidityUsd: 300000.0,
    feeBps: 30,
    feePct: 0.003,
    blockNumber: 19800000,
    blockTimestamp: Math.floor(Date.now() / 1000),
    fetchedAt: Date.now(),
    ageMs: 500,
    freshness: "FRESH",
    isValid: true
  };

  it("should pass validation for healthy pool state", () => {
    const result = PoolDataValidator.validate(validPool);
    expect(result.isValid).to.be.true;
    expect(result.errors).to.have.lengthOf(0);
  });

  it("should detect and reject zero base token reserve", () => {
    const corruptPool: NormalizedPoolState = {
      ...validPool,
      baseToken: { ...validPool.baseToken, reserve: 0, rawReserve: 0n }
    };
    const result = PoolDataValidator.validate(corruptPool);
    expect(result.isValid).to.be.false;
    expect(result.errors.some(e => e.includes("Base token"))).to.be.true;
  });

  it("should detect and reject zero quote token reserve", () => {
    const corruptPool: NormalizedPoolState = {
      ...validPool,
      quoteToken: { ...validPool.quoteToken, reserve: 0, rawReserve: 0n }
    };
    const result = PoolDataValidator.validate(corruptPool);
    expect(result.isValid).to.be.false;
    expect(result.errors.some(e => e.includes("Quote token"))).to.be.true;
  });

  it("should detect and reject invalid NaN or negative spot price", () => {
    const corruptPool: NormalizedPoolState = {
      ...validPool,
      spotPrice: NaN
    };
    const result = PoolDataValidator.validate(corruptPool);
    expect(result.isValid).to.be.false;
    expect(result.errors.some(e => e.includes("spot price is invalid"))).to.be.true;
  });

  it("should detect identical token0 and token1 addresses", () => {
    const corruptPool: NormalizedPoolState = {
      ...validPool,
      quoteToken: { ...validPool.quoteToken, address: validPool.baseToken.address }
    };
    const result = PoolDataValidator.validate(corruptPool);
    expect(result.isValid).to.be.false;
    expect(result.errors.some(e => e.includes("identical"))).to.be.true;
  });

  it("should issue warning on stale or expired pool state", () => {
    const stalePool: NormalizedPoolState = {
      ...validPool,
      freshness: "STALE",
      ageMs: 15000
    };
    const result = PoolDataValidator.validate(stalePool);
    expect(result.isValid).to.be.true; // Valid mathematically, but warned
    expect(result.warnings.some(w => w.includes("stale"))).to.be.true;
  });
});
