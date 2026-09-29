# Phase 5: Profit Calculation Engine — Completion & Validation Report

**Status:** Completed & Validated  
**Date:** 2026-09-28  
**Scope Executed:** Phase 5 — Profit Calculation Engine  
**Safety Mandates:** No Raw Price Spread as Profit, Safe Integer / Fixed-Point Arithmetic, Strict Zero-Loss Rejection, Zero Real Transactions  

---

## 1. Executive Summary
Phase 5 implements the **Profit Calculation Engine**, replacing simplistic raw spread approximations with realistic, executable net profitability modeling. The engine accounts for all execution costs: AMM constant-product slippage, DEX protocol swap fees (e.g. 0.30% per leg), multi-chain gas costs (L1 + L2 execution), price impact, and configurable safety margins. It automatically evaluates multiple candidate trade sizes to identify the notional that maximizes net profit while rejecting unprofitable trades.

---

## 2. Complete Calculation Flow & Formulas

```
Initial Capital ($)
       ↓
DEX A Swap Quote (Constant-product integer calculus)
       ↓
DEX A Fee (e.g. 30 bps / 0.30%)
       ↓
Price Impact (Deviation from spot price)
       ↓
DEX B Swap Quote
       ↓
DEX B Fee (e.g. 30 bps / 0.30%)
       ↓
Expected Output ($)
       ↓
Expected Slippage Tolerance (Worst-case minimum output)
       ↓
Gas Cost ($) (L2 execution + L1 data availability fee)
       ↓
Other Execution Costs ($) (Flash loan / MEV tip)
       ↓
Safety Margin ($) (Price volatility buffer)
       ↓
Gross Profit ($) = Expected Output - Initial Capital
       ↓
Net Profit ($) = Gross Profit - Gas Cost - Other Execution Costs - Safety Margin
       ↓
ROI (%) = (Net Profit / Initial Capital) × 100
```

---

## 3. Implemented Components & Deliverables

### 3.1 Types & Schema (`src/profit/types.ts`)
- **`ProfitCalculationParams`**: Inputs for pool reserves, token decimals, trade notional, gas price, ETH price, slippage tolerance, and safety margin.
- **`ProfitCalculationBreakdown`**: Comprehensive output returning:
  - Opportunity ID, Chain ID, DEX venues, pair symbol, source block, timestamp
  - `tradeSizeFormatted`, `initialCapitalRaw`, `expectedOutputRaw`, `expectedOutputFormatted`
  - `leg1Buy` & `leg2Sell` swap quotes (raw amounts, fee, price impact, execution prices)
  - `totalDexFeesUsdt`, `combinedPriceImpactPct`, `expectedSlippagePct`, `minOutputWithSlippageFormatted`
  - `estimatedGasUnits`, `gasPriceGwei`, `gasCostUsdt`, `otherCostsUsdt`, `safetyMarginUsdt`
  - `grossProfitUsdt`, `netProfitUsdt`, `roiPct`
  - `minRequiredProfitUsdt`, `status`, `isExecutable`, `rejectionReason`
  - `isEstimate: true` (clearly tagged as estimate until on-chain confirmation)
- **`TradeSizeOptimizationResult`**: Multi-size evaluation structure returning optimal notional and highest net profit.

### 3.2 Fixed-Point Constant-Product Math (`src/profit/math/AMMSwapMath.ts`)
- Implements exact Uniswap V2 integer formula:
  $$\Delta y = \frac{r_y \cdot \Delta x \cdot (10000 - \text{feeBps})}{r_x \cdot 10000 + \Delta x \cdot (10000 - \text{feeBps})}$$
- Zero-reserve and zero-input protection.
- Precise wei-level fee calculation.
- Price impact calculus:
  $$\text{Price Impact (\%)} = \frac{|\text{Spot Price} - \text{Execution Price}|}{\text{Spot Price}} \times 100$$
- Slippage bounds calculation (`applySlippage`).

### 3.3 Multi-Chain Gas Cost Calculator (`src/profit/math/GasCostCalculator.ts`)
- Accurate USD conversion:
  $$\text{Gas Cost (USD)} = \text{Gas Units} \times \text{Gas Price (Wei)} \times 10^{-18} \times \text{ETH Price (USD)} + \text{L1 Data Fee}$$
- Sub-cent micro-gas support for Base L2 (< $0.005) and high gas handling for Ethereum L1 ($30+).

### 3.4 Profit Calculation Engine (`src/profit/ProfitCalculationEngine.ts`)
- Full 2-hop arbitrage execution simulation.
- Classifies profitability status:
  - `PROFITABLE`: Net profit $> 0$, net profit $\ge$ min threshold, price impact $\le$ ceiling.
  - `UNPROFITABLE_NEGATIVE_NET`: Net profit $\le 0$ after fees and gas.
  - `BELOW_MIN_PROFIT`: Net profit positive but below user minimum threshold.
  - `PRICE_IMPACT_EXCEEDED`: Pool depth too shallow for chosen trade size.
  - `INSUFFICIENT_LIQUIDITY`: Zero or empty reserves.

### 3.5 Trade Size Optimizer (`src/profit/TradeSizeOptimizer.ts`)
- Evaluates candidate sizes (e.g. $0.50, $1.00, $2.50, $5.00, $10.00, $25.00, $50.00, $100.00, $250.00, $500.00).
- Selects the size producing the highest valid net profit (`maxNetProfitUsdt`).
- Filters out sizes that suffer from excessive price impact or negative returns.

---

## 4. Test Verification Results

### TypeScript / Hardhat Test Suites (`test/profit/`)
1. **`AMMSwapMath.test.ts`**:
   - `[PASS]` Exact Uniswap V2 constant-product output (1000 USDT -> ~0.3322 WETH).
   - `[PASS]` Zero output for zero input or zero reserves.
   - `[PASS]` Fee portion calculation (30 bps).
   - `[PASS]` Price impact calculation for small vs large trades.
   - `[PASS]` Slippage bounds calculation.
   - `[PASS]` Decimal conversions (6 and 18 decimals) without floating-point errors.
2. **`GasCostCalculator.test.ts`**:
   - `[PASS]` Base L2 sub-cent gas fee calculation (~$0.005).
   - `[PASS]` Ethereum L1 high gas price calculation ($37.50).
   - `[PASS]` Zero gas units / zero price handling.
3. **`ProfitCalculationEngine.test.ts`**:
   - `[PASS]` Complete profitability breakdown for profitable opportunity (2.0% spread).
   - `[PASS]` Micro-trade ($0.10) calculation.
   - `[PASS]` Large trade ($500.00) price impact measurement.
   - `[PASS]` Rejection when price impact exceeds threshold (`PRICE_IMPACT_EXCEEDED`).
   - `[PASS]` Rejection when net profit is negative (`UNPROFITABLE_NEGATIVE_NET`).
   - `[PASS]` Rejection when net profit is below minimum threshold (`BELOW_MIN_PROFIT`).
   - `[PASS]` Other execution costs (MEV tip) deduction.
4. **`TradeSizeOptimizer.test.ts`**:
   - `[PASS]` Multiple trade sizes evaluated and optimal size selected.
   - `[PASS]` Returns zero optimal size when all sizes are unprofitable.
   - `[PASS]` Shallow liquidity handling (prefers small trade over oversized trade).

### Python Test Suite (`tests/test_profit_engine.py`)
- `[PASS]` `test_amm_constant_product_swap_output`: Verifies AMM math parity with Uniswap V2.
- `[PASS]` `test_complete_net_profit_and_roi_calculation`: Verifies Net Profit and ROI formulas.
- `[PASS]` `test_unprofitable_negative_net_rejection`: Confirms negative profit trades are rejected.
- `[PASS]` `test_minimum_profit_threshold`: Confirms sub-threshold trades are not executable.
- `[PASS]` `test_multi_trade_size_optimization`: Confirms optimal trade size identification.

---

## 5. What Remains for Phase 6: Optimal Trade Sizing & Calculus

Upon user approval, **Phase 6** will implement:
1. **Closed-Form Calculus Sizing**:
   - Analytical derivation of optimal trade size:
     $$x^* = \frac{\sqrt{r_1 \cdot r_2 \cdot \gamma_1 \cdot \gamma_2} - r_1}{\gamma_1}$$
2. **Golden-Section Search Optimization**:
   - Continuous numerical optimization for non-linear multi-pool routes.
3. **Inventory-Aware Sizing**:
   - Dynamic scaling based on real available wallet equity.
