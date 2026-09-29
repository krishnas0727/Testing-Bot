# DEX Arbitrage Bot & Treasury System — Project Charter

## 1. Project Objective & Vision
The objective of this project is to build an enterprise-grade, high-performance, non-custodial **Decentralized Exchange (DEX) Arbitrage & Treasury System**. The system continuously monitors cross-DEX price discrepancies, models atomic triangular and cross-venue execution routes, validates multi-tier risk gates, conducts pre-flight RPC simulations, executes atomic zero-loss on-chain swaps via smart contracts, and systematically directs net profits into an automated Multi-Bucket Treasury.

## 2. Fundamental Architectural Principles

### 2.1 Zero-Loss Atomic Execution
- **Strict Atomicity**: Every trade must be executed within a single on-chain transaction.
- **Zero-Loss Guarantee**: If the final realized return is less than or equal to the initial capital plus gas and protocol fees (`Net Profit <= 0`), the transaction must automatically and deterministically revert.
- **Capital Preservation**: Never risk principal funds. Failed trades must only consume minimal gas, with zero capital attrition.

### 2.2 Non-Custodial Security & Key Management
- No centralized exchange (CEX) APIs, keys, or custody.
- All execution paths support client-side signing (MetaMask / EIP-1193) or dedicated hardware/isolated signer enclaves.
- No private keys are ever stored in version control, logs, client browsers, or unencrypted persistent storage.

### 2.3 Comprehensive Profit Calculation (No Quoted Spreads as Profit)
- Gross Profit does not equal Net Profit.
- Every opportunity must account for:
  $$\text{Net Profit} = \text{Estimated Return} - \text{Input Notional} - \text{DEX Swap Fees (e.g. 0.30\% per leg)} - \text{Price Impact} - \text{Gas Costs (L1 + L2 execution)}$$
- Execution is strictly gated on:
  $$\text{Net Profit} > \text{Min Net Profit Threshold} \quad \text{AND} \quad \text{ROI (\%)} \ge \text{Min ROI Threshold}$$

### 2.4 Multi-Tier Automated Treasury & Compounding
- 100% of realized profits forwarded atomically to `Treasury.sol`.
- Configurable basis points (BPS) distribution:
  - **60% (6000 bps) — Trading Capital**: Auto-compounded into the trading inventory.
  - **20% (2000 bps) — Reserve / Gas Pool**: Volatility buffer and gas subsidy reserve.
  - **20% (2000 bps) — Revenue / Staking**: Protocol yield and founder distribution.

## 3. High-Level Modular Architecture

```mermaid
flowchart TD
    subgraph MarketData ["Module 1: Market Data Engine"]
        M1["WebSocket / RPC Polling"] --> M2["Reserve Liquidity Tracker"]
        M2 --> M3["Decimal Normalization"]
    end

    subgraph Discovery ["Module 2: Route Discovery & Optimization"]
        M3 --> D1["Cross-DEX Pair Scanner"]
        D1 --> D2["Optimal Trade Sizing (xy=k calculus)"]
    end

    subgraph Profitability ["Module 3: Profit Calculation Engine"]
        D2 --> P1["Gross Profit Calculation"]
        P1 --> P2["DEX Fees & Price Impact Modeling"]
        P2 --> P3["Gas Cost Estimation (L1/L2)"]
        P3 --> P4["Net Profit & ROI Evaluation"]
    end

    subgraph RiskManagement ["Module 4 & 5: Risk Gates & Recalculation"]
        P4 --> R1["Token & Router Whitelist Check"]
        R1 --> R2["Slippage & Impact Ceiling Check"]
        R2 --> R3["Circuit Breaker & Emergency Stop"]
        R3 --> R4["Fresh Pre-Execution Quote Recheck"]
    end

    subgraph Simulation ["Module 6: Simulation Engine"]
        R4 --> S1["eth_call / simulateArbitrage() RPC Pre-Flight"]
    end

    subgraph Execution ["Module 7: Atomic Execution Smart Contract"]
        S1 --> E1["ArbitrageExecutor.sol"]
        E1 --> E2["Atomic DEX Swap Leg 1"]
        E2 --> E3["Atomic DEX Swap Leg 2"]
        E3 --> E4["require(finalBalance > initialBalance, 'UNPROFITABLE')"]
    end

    subgraph TreasurySystem ["Module 8 & 9: Treasury & Profit Allocation"]
        E4 --> T1["Treasury.sol depositProfit()"]
        T1 --> T2["60% Trading Capital (Compounding)"]
        T1 --> T3["20% Gas & Emergency Reserve"]
        T1 --> T4["20% Revenue / Staking Distribution"]
    end

    subgraph Monitoring ["Module 11 & 12: Ledger & Dashboard"]
        E4 -.-> L1["Database Audit Log"]
        T1 -.-> L1
        L1 --> DSH["Live Web3 Monitoring Dashboard"]
    end
```

## 4. Multi-Chain Target Matrix

| Network | Chain ID | DEX Protocols | Gas Profile | Optimization Goal |
| :--- | :---: | :--- | :--- | :--- |
| **Base L2** | `8453` | Uniswap V2/V3, SushiSwap, Aerodrome | Sub-cent gas (< $0.005) | Micro-arbitrage, 95%+ profit retention |
| **Arbitrum One** | `42161` | Uniswap V3, SushiSwap, Camelot | Low gas (~$0.01) | Fast block time (~250ms Nitro) |
| **Polygon PoS** | `137` | QuickSwap, SushiSwap, Uniswap V3 | Low gas (~0.02 POL) | High volume multi-pair scanning |
| **Ethereum Mainnet** | `1` | Uniswap V2/V3, SushiSwap, Curve | High gas ($2.00 - $20.00+) | Large capital triangular trades |
| **Sepolia Testnet** | `11155111` | Uniswap V2, SushiSwap V2 | Free testnet faucet | Safe staging & execution rehearsal |
| **Base Sepolia** | `84532` | Uniswap V2/V3, SushiSwap V2 | Free testnet faucet | L2 staging & simulation rehearsal |

## 5. Phase 0 Deliverable Sign-Off
- Architecture fully documented.
- Security and risk boundaries codified.
- Ready for Phase 1 project scaffolding and tooling configuration.
