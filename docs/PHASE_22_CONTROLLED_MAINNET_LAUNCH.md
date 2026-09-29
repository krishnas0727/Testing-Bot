# Phase 22 — Controlled Mainnet Launch Protocol & Operations Manual

## 1. Executive Summary & Objective

Phase 22 defines the rigorous, phased protocol for initiating **Controlled Mainnet Launch** of the DEX Crypto Arbitrage Bot on **Base L2 Mainnet (Chain ID: 8453)**. 

To ensure absolute capital preservation, the system enforces:
1. **Zero Fake Data Invariant**: All transactions, hashes, receipts, balances, and profits are strictly read directly from verified blockchain receipts (`status === 1`). Simulation or stub data is strictly quarantined to `MOCK` mode.
2. **Explicit Two-Factor Arming**: Live trading requires explicit configuration of both `TRADING_MODE=LIVE` and `LIVE_TRADING_ARMED=true`. System startup defaults strictly to `MOCK` mode and unarmed state.
3. **Micro-Capital Guardrails**: The initial live trade is strictly bounded between **$5.00 USD (minimum)** and **$100.00 USD (maximum)**.
4. **Net Profit Enforcement**: Trade execution is gated on a strict net profit threshold of **>= $0.10 USD**, net of all DEX fees (0.30% * 2), Base L2 L1/L2 gas costs, and dynamic slippage.
5. **Deduplication Lock**: In-flight concurrency locks prevent double-clicks and simultaneous race conditions across any token pair route.
6. **Instant Emergency Rollback**: One-click API and dashboard circuit breakers instantly disarm live mode, revert to `MOCK`, abort pending ops, and trigger the `EMERGENCY_STOP` freeze.

---

## 2. 14-Point Mainnet Pre-Launch Readiness Checklist

Prior to arming the bot for mainnet execution, all 14 gates must report `PASS`:

| # | Readiness Gate | Target Verification | Status |
|---|---|---|---|
| 1 | **Unit Tests** | Phase 15 test suites pass across all modules | `PASSED` |
| 2 | **Contract Tests** | Phase 16 smart contract test suite passes | `PASSED` |
| 3 | **Integration Tests** | Phase 17 end-to-end integration test suite passes | `PASSED` |
| 4 | **Edge-Case Tests** | Phase 19 RPC/gas/wallet failure tests pass | `PASSED` |
| 5 | **Security Review** | Phase 20 security audit resolved all critical/high blockers | `PASSED` |
| 6 | **Production Infra** | Phase 21 Docker, health endpoints, SQL schema ready | `PASSED` |
| 7 | **Backend Health** | `/api/health` and `/api/health/ready` probe `READY (200)` | `PASSED` |
| 8 | **Database Connection** | Relational DB connected and schema migrated | `PASSED` |
| 9 | **Blockchain RPC** | Base Mainnet RPC responding with block latency < 2s | `PASSED` |
| 10 | **Contract Address** | `ArbitrageExecutor` address verified on Base L2 | `VERIFIED` |
| 11 | **Contract Ownership** | Multi-sig / Cold Owner confirmed via `owner()` query | `VERIFIED` |
| 12 | **DEX Routers** | Uniswap V2 & SushiSwap V2 Base router contracts verified | `VERIFIED` |
| 13 | **Hot Wallet Gas** | Hot wallet balance >= 0.005 ETH for Base L2 execution | `VERIFIED` |
| 14 | **Master Arming** | `LIVE_TRADING_ARMED=true` explicitly set by operator | `OPERATOR_GATED` |

---

## 3. Base L2 Mainnet Network & Contract Configuration

Configuration is isolated in `src/config/mainnet.ts`:

- **Network Name**: Base Mainnet (EVM L2)
- **Chain ID**: `8453`
- **Native Gas Token**: ETH (18 decimals)
- **Explorer URL**: `https://basescan.org`

### Verified Mainnet Token Contracts

| Token Symbol | Decimals | Canonical Base Mainnet Contract Address |
|---|---|---|
| **USDC** (Native) | 6 | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| **WETH** (Wrapped Ether)| 18 | `0x4200000000000000000000000000000000000006` |
| **DAI** | 18 | `0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb` |

### Verified Mainnet DEX Routers

| DEX Platform | Protocol | Base Mainnet Router Address |
|---|---|---|
| **Uniswap V2** | UniswapV2Router02 | `0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24` |
| **SushiSwap V2** | SushiSwapRouter | `0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891` |

---

## 4. Controlled First Trade Execution Protocol

The first live mainnet trade must follow this deterministic, operator-supervised sequence:

```
[Operator] ──► Inspects /api/mainnet/readiness (All 14 gates verified)
     │
     ▼
[Arming] ───► Operator sets LIVE_TRADING_ARMED=true & TRADING_MODE=LIVE
     │
     ▼
[Gate 1] ───► Concurrency Lock: Checks if route lock active (Rejects duplicates)
     │
     ▼
[Gate 2] ───► Sizing Check: Enforces $5.00 <= tradeSize <= $100.00 USD
     │
     ▼
[Gate 3] ───► Gas Ceiling Check: Verifies current Base gas price <= 5.0 Gwei
     │
     ▼
[Gate 4] ───► Balance Check: Verifies hot wallet has >= 0.005 ETH for gas
     │
     ▼
[Gate 5] ───► Profitability Check: Recalculates expected net profit >= $0.10 USD
     │
     ▼
[Execution] ─► Broadcasts raw tx to Base Mainnet RPC
     │
     ▼
[Mining] ───► Awaits block receipt (confirms mined status === 1)
     │
     ├── If status === 1 ──► Records CONFIRMED trade in DB, logs real net profit
     │
     └── If status === 0 ──► Records REVERTED, logs gas loss, releases lock
```

---

## 5. Instant Rollback & Emergency Stop Procedure

If slippage anomalies, unexpected RPC latency, or network forks are detected during mainnet operation:

### Automatic Trigger
- The circuit breaker automatically halts operations if:
  - 2 consecutive trades fail or revert.
  - Gas price spikes above `5.0 Gwei`.
  - RPC node latency exceeds 3000ms.

### Manual Operator Trigger
Operators can trigger an instant rollback via the authenticated REST endpoint:
```http
POST /api/mainnet/rollback
Authorization: Bearer <OPERATOR_JWT>
Content-Type: application/json

{
  "reason": "Operator initiated precautionary pause"
}
```

### Action Executed by Rollback:
1. `TRADING_MODE` set immediately to `MOCK`.
2. `LIVE_TRADING_ARMED` flag revoked to `false`.
3. `EMERGENCY_STOP` global circuit breaker set to `true`.
4. In-flight route concurrency locks purged.
5. All pending scheduled opportunity polling tasks canceled.

---

## 6. Verification Test Suites

### TypeScript Master Suite: `test/mainnet/MainnetReadiness.test.ts`
- Verifies Base L2 chain ID and canonical token/router isolation from testnets.
- Validates the 14-point readiness checklist evaluation logic.
- Verifies trade size bounding ($5.00 to $100.00 USD).
- Verifies net profit threshold enforcement ($0.10 USD).
- Verifies in-flight deduplication concurrency locking.
- Verifies emergency rollback logic and state resets.
- Confirms zero fake receipts / mined status invariant.

### Python Verification Suite: `tests/test_mainnet_readiness.py`
- Deterministic verification of readiness rules.
- Testnet-vs-mainnet configuration isolation validation.
- Concurrency key race-condition simulation.
- Revert accounting test ensuring zero fake profits.

---

## 7. Operational Sign-Off

The system is configured in safe standby mode. Live trading remains disarmed (`LIVE_TRADING_ARMED=false`, `TRADING_MODE=MOCK`). Transition to live operations requires explicit operator action following completion of Phase 22 sign-off.
