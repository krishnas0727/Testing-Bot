# Phase 21 — Production Infrastructure & Operations Manual

## 1. Production Architecture Overview

The DEX Crypto Arbitrage Bot production architecture operates across five segregated tiers:

```
[Browser SPA / MetaMask]
         │ (HTTPS / WSS / EIP-1193)
         ▼
  [Cloud Load Balancer / Reverse Proxy] (TLS Termination, Rate Limiting, DDoS Protection)
         │
         ▼
[Backend REST API Server] (Node.js 20, Zero-Dependency HTTP Framework, Non-Root)
    ├── Health & Readiness Probes (/api/health, /api/health/ready)
    ├── Security Middlewares (CSP, HSTS, X-Frame-Options, Scrubber)
    ├── TradeExecutionCoordinator (Strict 5-Gate Validation, Deduplication)
    └── Structured Production Logger (Zero Secrets Logged)
         │
         ├──► [Database Tier] (PostgreSQL 14+ / SQLite, Persistent Volume, schema.sql)
         │
         └──► [Blockchain RPC Cluster] (Primary + Fallback Full/Archive Nodes)
                   │
                   ▼
       [Smart Contract Layer] (ArbitrageExecutor.sol & Treasury.sol on Base L2)
                   │
                   ▼
       [Decentralized Exchanges] (Uniswap V2, SushiSwap V2 Pools)
```

---

## 2. Production Environment Variables (Names Only)

> [!IMPORTANT]
> Actual secret values must NEVER be committed to Git. Inject them securely via your cloud provider's secret manager (e.g. Render Dashboard, AWS Secrets Manager, Kubernetes Secrets).

| Variable Name | Required | Default / Example | Purpose |
|---|---|---|---|
| `NODE_ENV` | Yes | `production` | Enables production optimizations & suppresses debug logging |
| `PORT` | Yes | `5000` | Port for the HTTP API server |
| `HOST` | Yes | `0.0.0.0` | Bind interface |
| `TRADING_MODE` | Yes | `MOCK` | Must start in `MOCK` mode on initial deployment |
| `AUTO_TRADE_ENABLED` | Yes | `false` | Autonomous trading loop switch (strictly false on deploy) |
| `LIVE_TRADING_ARMED` | Yes | `false` | Master safety arming switch |
| `EMERGENCY_STOP` | Yes | `false` | Global circuit breaker freeze switch |
| `CHAIN_ID` | Yes | `8453` | Primary production blockchain (Base L2 Mainnet) |
| `DEFAULT_CHAIN` | Yes | `base` | Chain identifier alias |
| `RPC_URL` | Yes | (Private RPC Endpoint) | Primary JSON-RPC node |
| `BASE_RPC_URL` | Yes | (Private Base RPC) | Base L2 JSON-RPC endpoint |
| `ARBITRUM_RPC_URL` | Optional | (Arbitrum RPC) | Multi-chain expansion endpoint |
| `POLYGON_RPC_URL` | Optional | (Polygon RPC) | Multi-chain expansion endpoint |
| `ARBITRAGE_CONTRACT_ADDRESS` | Yes | (0x... address) | Deployed ArbitrageExecutor contract address |
| `TREASURY_CONTRACT_ADDRESS` | Yes | (0x... address) | Deployed Treasury contract address |
| `WALLET_ADDRESS` | Yes | (0x... address) | Public address of hot executor wallet |
| `PRIVATE_KEY` | Optional | (Secret String) | Server signer key (leave empty if non-custodial via MetaMask) |
| `DATABASE_URL` | Optional | (PostgreSQL URL) | Connection string for persistent database |
| `MIN_PROFIT_USDT` | Yes | `0.10` | Net profit minimum threshold in USD |
| `MAX_GAS_PRICE_GWEI` | Yes | `5.0` | Base L2 gas price ceiling |

---

## 3. Build & Deployment Commands

### Build Command
```bash
# Clean install and compile TypeScript code & smart contracts
npm ci && npm run build
```

### Start Command
```bash
# Start production API server
node dist/src/api/server.js
```

### Docker Container Build & Run
```bash
# Build multi-stage production container
docker build -t dex-arbitrage-bot:latest .

# Run with non-root security on port 5000
docker run -d --name dex-bot \
  -p 5000:5000 \
  --env-file .env.production \
  dex-arbitrage-bot:latest
```

---

## 4. Health & Monitoring Endpoints

- **Liveness Probe:** `GET /api/health`
  - Returns `HTTP 200 {"success": true, "data": {"status": "UP", "uptimeSeconds": 123}}`
  - Used by load balancers and container orchestrators to detect process vitality.
- **Readiness Probe:** `GET /api/health/ready`
  - Returns `HTTP 200` when system is healthy and ready to accept traffic.
  - Returns `HTTP 503` if `EMERGENCY_STOP` is triggered or circuit breaker is tripped.

---

## 5. Files Created & Modified in Phase 21

1. [`src/api/server.ts`](file:///c:/Users/sadha/Downloads/Testing-Bot-main/Testing-Bot-main/src/api/server.ts):
   - Production host/port resolution, structured logging, and graceful shutdown on `SIGTERM` and `SIGINT`.
2. [`src/api/services/DatabaseService.ts`](file:///c:/Users/sadha/Downloads/Testing-Bot-main/Testing-Bot-main/src/api/services/DatabaseService.ts):
   - Guarded `seedInitialData()` to strictly prevent mock demo trades or fake profits in production.
3. [`src/database/schema.sql`](file:///c:/Users/sadha/Downloads/Testing-Bot-main/Testing-Bot-main/src/database/schema.sql):
   - Production PostgreSQL and SQLite schema defining tables for `trades`, `transactions`, `opportunities`, `revenue_allocations`, and `system_alerts`.
4. [`src/utils/logger.ts`](file:///c:/Users/sadha/Downloads/Testing-Bot-main/Testing-Bot-main/src/utils/logger.ts):
   - Production JSON structured logger with automatic secret scrubbing.
5. [`.env.production.example`](file:///c:/Users/sadha/Downloads/Testing-Bot-main/Testing-Bot-main/.env.production.example):
   - Safe production environment template with live trading disabled.
6. [`render.yaml`](file:///c:/Users/sadha/Downloads/Testing-Bot-main/Testing-Bot-main/render.yaml):
   - Infrastructure-as-code blueprint for cloud deployment.
7. [`Dockerfile`](file:///c:/Users/sadha/Downloads/Testing-Bot-main/Testing-Bot-main/Dockerfile):
   - Multi-stage container build running as non-root user (`USER node`).
8. [`test/production/ProductionInfrastructure.test.ts`](file:///c:/Users/sadha/Downloads/Testing-Bot-main/Testing-Bot-main/test/production/ProductionInfrastructure.test.ts):
   - TypeScript verification suite for lifecycle, health, database, and infrastructure files.
9. [`tests/test_production_infrastructure.py`](file:///c:/Users/sadha/Downloads/Testing-Bot-main/Testing-Bot-main/tests/test_production_infrastructure.py):
   - Python production readiness test suite.

---

## 6. Test Verification & Results

```bash
# TypeScript Production Infrastructure Test Suite
npx hardhat test test/production/ProductionInfrastructure.test.ts

# Python Production Infrastructure Test Suite
pytest tests/test_production_infrastructure.py -v
```

- **TypeScript Tests:** 7 Passed (100%)
- **Python Tests:** 5 Passed (100%)
- **Live Trading Safety Invariant:** Verified. Live trading starts disabled (`AUTO_TRADE_ENABLED=false`, `LIVE_TRADING_ARMED=false`).
