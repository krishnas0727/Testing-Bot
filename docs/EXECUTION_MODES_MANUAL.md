# Execution Modes Operations Manual: User-Signed vs Automated

## 1. Executive Summary & Philosophy

This manual specifies the implementation and operational architecture of the **Two Strictly Separated Execution Modes** for the DEX Crypto Arbitrage Bot on **Base L2 Mainnet (Chain ID: 8453)**:

1. **USER-SIGNED EXECUTION (DEFAULT / NON-CUSTODIAL)**
   - The user manually inspects and explicitly approves every trade through their connected wallet (MetaMask / WalletConnect).
   - **Zero Custody Invariant**: The backend **never** requests, stores, or accesses user private keys or seed phrases.
   - Pre-flight trade summaries display the expected amount, minimum output received, gas estimate, slippage, and net profit before the user signs.
   - Remains 100% available even when automated execution is disabled or emergency stopped.

2. **AUTOMATED EXECUTION (OPTIONAL / SEPARATELY FUNDED)**
   - Completely optional autonomous execution for opportunities satisfying strict predefined rules.
   - Executed via a **separately funded, explicitly authorized dedicated executor account / contract**.
   - Strict risk limit enforcement (trade size, net profit, slippage, gas ceiling, daily loss, consecutive failures).
   - **Never uses or touches personal user wallet credentials or private keys**.
   - Features independent emergency controls (pause, resume, emergency stop).

---

## 2. Architecture & Separation Matrix

```
                      [DEX Arbitrage Bot Web Application]
                                      │
            ┌─────────────────────────┴─────────────────────────┐
            ▼                                                   ▼
┌─────────────────────────────────┐   ┌─────────────────────────────────┐
│  MODE 1: USER-SIGNED EXECUTION  │   │   MODE 2: AUTOMATED EXECUTION   │
│     (DEFAULT / NON-CUSTODIAL)   │   │      (OPTIONAL / AUTONOMOUS)    │
├─────────────────────────────────┤   ├─────────────────────────────────┤
│ • Status: "Waiting for Wallet   │   │ • Status: "Automated Executor   │
│   Confirmation"                 │   │   Active" / "Paused"            │
│ • Signer: User Personal Wallet  │   │ • Signer: Dedicated Executor    │
│   (MetaMask / EIP-1193)         │   │   Account / Contract            │
│ • Private Keys: Client-Side     │   │ • Private Keys: Dedicated       │
│   Only (Backend Zero Access)    │   │   Server Key (User Key NEVER)   │
│ • Summary: Expected vs Min Out, │   │ • Safety: 12 Pre-Flight Checks, │
│   Gas, Slippage, Net Profit     │   │   Max Size, Max Daily Loss      │
│ • Accounting: Realized Profit   │   │ • Accounting: Realized Profit   │
│   settles to User Balance       │   │   settles to Treasury (60/20/20)│
│ • Emergency: Unaffected by      │   │ • Emergency: Independent Pause, │
│   automated emergency stop      │   │   Resume & Emergency Stop       │
└─────────────────────────────────┘   └─────────────────────────────────┘
```

---

## 3. Mode 1: User-Signed Execution Pipeline

### Operational Step-by-Step Flow:
1. **User selects opportunity**: User identifies an arbitrage opportunity on the dashboard.
2. **Pre-flight recalculation**: Backend fetches fresh live DEX quotes and calculates:
   - Expected input amount ($)
   - Minimum output received taking slippage into account:
     $$\text{MinOutput} = \text{AmountIn} \times \left(1 - \frac{\text{SlippagePct}}{100}\right)$$
   - Base L2 estimated gas cost ($)
   - Dynamic slippage tolerance (%)
   - Expected net profit ($)
3. **Trade Summary Modal**: Dashboard opens the non-custodial confirmation modal.
4. **User Confirmation**: User clicks **"Confirm & Sign in MetaMask"**.
5. **Wallet Prompt**: MetaMask opens via EIP-1193 (`eth_sendTransaction`).
6. **User Signs**: User explicitly approves gas and payload in their browser wallet.
7. **On-Chain Execution**: ArbitrageExecutor executes the atomic two-leg swap.
8. **Mined Receipt Verification**: System awaits block confirmation (`receipt.status === 1`).
9. **User Ledger Update**: Trade is stored with `executionMode: "USER_SIGNED"` and `executorType: "USER_WALLET"`. Realized profit is attributed directly to user accounting.

---

## 4. Mode 2: Automated Execution Pipeline

### Dedicated Authorized Executor
Automated execution is powered by a dedicated executor address (`0x1111...1111`) that is explicitly whitelisted in `ArbitrageExecutor.sol` via `setExecutor(address, true)`. 

### 12 Pre-Flight Safety Validations
Before every automated trade, all 12 checks must pass:
1. **Fresh Quotes**: Fresh price quotes retrieved within 3 seconds.
2. **Liquidity Depth**: Pool reserve depth verified $\ge \$1,000$ USD.
3. **Price Impact**: Price impact $\le 1.0\%$.
4. **Slippage**: Slippage tolerance $\le 0.5\%$.
5. **Gas Estimate**: Gas price $\le 5.0$ Gwei.
6. **Net Profit**: Expected net profit $\ge \$0.20$ USD.
7. **Transaction Simulation**: Call simulation succeeds on Base RPC.
8. **Trade Size Limit**: Trade size $\le \$100.00$ USD.
9. **Daily Loss Ceiling**: Accumulated session loss $< \$20.00$ USD.
10. **Dedicated Executor Balance**: Dedicated executor hot wallet ETH gas $\ge 0.005$ ETH.
11. **Executor Status**: Automated executor is enabled, NOT paused, and emergency stop is NOT active.
12. **On-Chain Mining**: Mined block receipt confirms `status === 1`.

---

## 5. Independent Emergency Controls

The automated executor can be paused or stopped without freezing user-signed execution:

| Action | API Endpoint | Effect on Automated | Effect on User-Signed |
|---|---|---|---|
| **Pause Automated** | `POST /api/execution/automated/pause` | Halts new automated opportunities | User-Signed remains **ACTIVE** |
| **Resume Automated** | `POST /api/execution/automated/resume` | Resumes automated scanning | User-Signed remains **ACTIVE** |
| **Emergency Stop** | `POST /api/execution/automated/emergency-stop` | Freezes automated executor | User-Signed remains **ACTIVE** |

### Automatic Circuit Breakers:
- **Consecutive Failures**: If 2 consecutive automated trades revert on-chain, the system automatically trips the automated emergency stop.
- **Daily Loss**: If cumulative loss reaches `$20.00 USD`, automated trading is automatically disabled.

---

## 6. Treasury Accounting Separation

Accounting and profit settlement are strictly segregated:

```
[User-Signed Trade]  ──► [ArbitrageExecutor] ──► [Realized Profit] ──► [User Wallet Balance]

[Automated Trade]    ──► [ArbitrageExecutor] ──► [Realized Profit] ──► [Treasury Vault]
                                                                             ├── 60% Compounding Trading Capital
                                                                             ├── 20% Gas & Downside Reserve
                                                                             └── 20% Protocol Revenue
```

> [!IMPORTANT]
> The automated executor is strictly prohibited by smart contract access control from withdrawing arbitrary user funds. User-signed funds settle to the user's personal wallet.

---

## 7. Dashboard Telemetry Endpoints

- `GET /api/execution/mode`: Returns the status snapshot for both execution modes.
- `POST /api/execution/mode`: Operator endpoint to switch active execution mode (`USER_SIGNED` | `AUTOMATED`).
- `GET /api/execution/automated/config`: Returns automated executor risk limits.
- `PATCH /api/execution/automated/config`: Admin endpoint to update limits.
- `POST /api/trades/prepare-user-signed`: Returns pre-flight summary and calldata for wallet signing.
- `POST /api/trades/confirm-user-signed`: Confirms user-signed trade after wallet broadcast.
- `POST /api/trades/execute-automated`: Executes trade via dedicated authorized executor.

---

## 8. Verification Test Suites

```bash
# TypeScript Master Test Suite
npx hardhat test test/execution/ExecutionModes.test.ts

# Python Master Verification Suite
pytest tests/test_execution_modes.py -v
```
