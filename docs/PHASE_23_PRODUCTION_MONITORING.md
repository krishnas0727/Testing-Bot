# Phase 23 — Production Monitoring Manual & Architecture Guide

## 1. Executive Summary & Objective

Phase 23 implements institutional-grade **Production Monitoring & Telemetry** for the DEX Crypto Arbitrage Bot operating on **Base L2 Mainnet (Chain ID: 8453)**. 

The monitoring system provides non-invasive, real-time observability across all critical subsystems while strictly guaranteeing:
1. **Zero Fake Data Invariant**: Telemetry only reports confirmed, verified on-chain data. Successful trade counts, confirmed statuses, and realized profits are strictly updated only upon confirmed receipt mining (`status === 1`).
2. **Zero Secret Leakage**: Automatic recursive scrubbing redacts private keys, mnemonics, seeds, passwords, and API secrets from all structured logs, diagnostic payloads, and health endpoints.
3. **Network Mismatch Circuit Breaker**: If the RPC or connected wallet returns a chain ID differing from expected Base Mainnet (`8453`), the system immediately trips the emergency circuit breaker and blocks live execution.
4. **Deduplicated Alerting**: Throttled alert dispatch suppresses notification storms by aggregating repeated alerts of the same type within a 60-second sliding window.
5. **Non-Invasive Fail-Safe**: Monitoring probes execute within resilient exception handlers and timeouts; probe failures never crash the trading daemon or trade coordinator.

---

## 2. Production Monitoring Architecture

```
[Decentralized Exchanges]  [Base L2 RPC Node]   [PostgreSQL Database]   [Client Wallet]
        │                         │                       │                    │
        ▼                         ▼                       ▼                    ▼
   [DEX Probe]              [RPC Latency &]         [Database Ping]      [Wallet State &]
(Uniswap/SushiSwap)       (Block Height / Lag)    (Connection Pool)    (Address / Balances)
        │                         │                       │                    │
        └─────────────────┬───────┴───────────────────────┴────────────────────┘
                          ▼
        ┌──────────────────────────────────────────────────────────┐
        │        ProductionMonitoringService (Phase 23)            │
        │  ├── Application Health Engine (HEALTHY/DEGRADED/UNAVAIL)│
        │  ├── Blockchain & Network Mismatch Guard (Chain 8453)    │
        │  ├── Trade & Profit Invariant Tracker (Mined Status === 1│
        │  ├── Gas Conditions & Hot Wallet Gating (0.005 ETH Min)  │
        │  ├── Error Taxonomy & Sensitive Data Scrubber            │
        │  ├── Deduplicated Alert Dispatcher (60s Window)          │
        │  └── Emergency Auto-Rollback (2 Consecutive Fails)       │
        └──────────────────────────┬───────────────────────────────┘
                                   │
                ┌──────────────────┴──────────────────┐
                ▼                                     ▼
      [REST Health Endpoints]               [Structured Logger]
  • GET  /api/health (Liveness)        • INFO: Trade/Tx Milestones
  • GET  /api/health/ready (Readiness) • WARNING: Gas Spike / Throttles
  • GET  /api/monitoring/status        • ERROR: DEX / RPC Failures
  • POST /api/monitoring/probe         • CRITICAL: Network Mismatch / Breaker
  • POST /api/monitoring/wallet/revalidate
```

---

## 3. Component Health Classification Matrix

Component health is evaluated across three strict operational tiers:

| Component | Healthy (200) | Degraded (200) | Unavailable (503) |
|---|---|---|---|
| **Backend API** | Heap < 1GB, Uptime stable | Heap >= 1GB or high event loop lag | Server unresponsive or fatal exit |
| **Database** | Read/write latency < 200ms | Latency 200ms – 1000ms | Connection refused / Pool exhausted |
| **Base RPC** | Latency < 1000ms, Block delta < 3s | Latency 1000ms – 2000ms | RPC timeout (>2s), Rate limit 429, or Down |
| **Smart Contract** | Bytecode verified on Base L2 | Latency querying contract state | Address has no bytecode (`0x`) |
| **DEX Routers** | Both Uniswap V2 & SushiSwap V2 active | 1 router slow or quote delayed | Both routers unresponsive or pool drained |
| **Circuit Breaker** | Circuit closed (`NORMAL`) | N/A | Circuit tripped (`EMERGENCY_STOP`) |

---

## 4. Endpoints Implemented

### Public Endpoints (No Auth Required)
- `GET /api/health`: Basic liveness probe returning system uptime and overall status (`UP`). Zero internal secrets or sensitive topologies exposed.
- `GET /api/health/ready`: Deep readiness probe returning component-level health status (`READY` / `NOT_READY`). Returns HTTP 503 if any critical service is `UNAVAILABLE`.

### Operator / Viewer Endpoints (Role-Guarded)
- `GET /api/monitoring/status` (Role: `VIEWER`): Complete telemetry snapshot including:
  - Application Health matrix
  - Blockchain metrics (Chain ID, RPC latency, block height, network mismatch flag)
  - Gas metrics (Gwei price, ceiling, hot wallet balance, funded state)
  - Connected wallet state (address, native & token balances, revalidation state)
  - DEX metrics (availability, latency, liquidity depth)
  - Recent classified errors (scrubbed)
  - Active alerts
- `POST /api/monitoring/probe` (Role: `OPERATOR`): On-demand diagnostic health probe triggering active RPC, DB, and router checks.
- `POST /api/monitoring/wallet/revalidate` (Role: `OPERATOR`): Explicit operator revalidation unblocking live trading after a wallet disconnect or account change.

---

## 5. Error Taxonomy & Structured Logging

All errors are classified into strict diagnostic taxonomies with automatic secret scrubbing:

| Category | Typical Trigger | Severity | Action Taken |
|---|---|---|---|
| `RPC_ERROR` | RPC node timeout, 429 rate limit, node restart | `ERROR` / `CRITICAL` | Fallback RPC query; halts live trade if persistent |
| `NETWORK_MISMATCH`| Connected chainId != 8453 | `CRITICAL` | Instant Emergency Stop; sets mode to MOCK |
| `CONTRACT_REVERT` | On-chain execution reverted (slippage/min profit) | `ERROR` | Records loss of gas cost; increments consecutive fails |
| `DEX_FAILURE` | Router unresponsive or liquidity depleted | `ERROR` | Blocks trade on affected DEX pair |
| `INSUFFICIENT_GAS` | Hot wallet ETH < 0.005 ETH or gas > 5.0 Gwei | `CRITICAL` | Pauses live execution until replenished |
| `SLIPPAGE_FAILURE`| Price moved beyond configured tolerance | `WARNING` | Pre-flight recalculation aborts execution |
| `TRANSACTION_TIMEOUT`| Mempool pending time exceeded deadline | `WARNING` | Aborts pending trade receipt tracking |

---

## 6. Alert System & Anti-Storm Deduplication

The alert system handles 12 critical operational conditions:
1. `BACKEND_DOWN`
2. `DATABASE_UNAVAILABLE`
3. `RPC_UNAVAILABLE`
4. `NETWORK_MISMATCH`
5. `REPEATED_TRADE_FAILURES`
6. `CONTRACT_ERROR`
7. `DEX_UNAVAILABLE`
8. `INSUFFICIENT_GAS`
9. `INSUFFICIENT_TOKEN_BALANCE`
10. `EMERGENCY_STOP_ACTIVATED`
11. `UNEXPECTED_TRADE_FAILURE`
12. `ABNORMAL_EXECUTION_BEHAVIOR`

### Deduplication Mechanism
When an alert fires, its key is cached with a timestamp. If an identical alert type triggers again within 60 seconds, the dispatcher suppresses the duplicate alert and increments an internal `occurrenceCount`, preventing alert storms while ensuring operator visibility.

---

## 7. Verification Test Evidence

### TypeScript Test Suite: `test/monitoring/ProductionMonitoring.test.ts`
- **Application Health**: Verifies `HEALTHY`, `DEGRADED`, and `UNAVAILABLE` state calculations and secret exclusion from public endpoints.
- **Network Mismatch**: Simulates non-Base chain ID (e.g. 31337 or 1) and verifies immediate Emergency Stop and mode reset to `MOCK`.
- **Trade Invariant**: Confirms zero premature updates; verifies confirmed status only on `status === 1`; verifies revert accounting with gas loss.
- **Consecutive Failures**: Confirms that 2 consecutive failures immediately trigger auto-rollback.
- **Gas Monitoring**: Tests gas price ceiling (>5.0 Gwei) and low balance (<0.005 ETH) circuit breakers.
- **Wallet Re-Validation**: Verifies account switch and disconnect trip revalidation flags.
- **Secret Scrubbing**: Tests that private keys, passwords, and tokens are scrubbed from error logs.
- **Alert Deduplication**: Verifies that duplicate alerts within 60s are throttled.
- **REST Endpoints**: Validates `/api/monitoring/status` and `/api/monitoring/probe`.

### Python Test Suite: `tests/test_production_monitoring.py`
- Deterministic logic testing for health synthesis, chain ID mismatch tripping, trade lifecycle accounting, consecutive failure circuit breaking, and secret scrubbing.

---

## 8. Exact Commands to Run Verification

```bash
# Run TypeScript Production Monitoring Test Suite
npx hardhat test test/monitoring/ProductionMonitoring.test.ts

# Run Python Production Monitoring Test Suite
pytest tests/test_production_monitoring.py -v
```

---

## 9. Monitoring Limitations & Production Considerations

1. **Subshell RPC Emulation**: In environments where public Base RPC endpoints require rate-limited API keys, fallback RPC endpoints must be configured via `BASE_RPC_FALLBACK_URL`.
2. **MetaMask Event Latency**: EIP-1193 events (`accountsChanged`, `chainChanged`) in client browsers depend on user interaction with the MetaMask popup.
3. **L1 Data Fee Estimation**: Base L2 transactions include an L1 data publication fee. The monitoring engine estimates this using the Base GasPriceOracle contract.
