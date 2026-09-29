# DEX Arbitrage Bot — Security Policy & Operational Standards

## 1. Core Security Mandate
Security is the primary invariant of this DEX Arbitrage system. Under no circumstances should convenience or speed compromise capital preservation or key safety.

## 2. Mandatory Rules

### Rule 1: No Hardcoded Secrets or Private Keys
- **Strict Prohibition**: No private keys, mnemonics, API tokens, or secrets may ever be committed to git or printed to console logs.
- Environment variables (`.env`) must always be excluded via `.gitignore`.
- `.env.example` must contain only empty strings or public dummy addresses (`0x0000...0000`).

### Rule 2: Non-Custodial Architecture by Default
- The primary mode of live transaction execution is client-side signing via connected Web3 wallet (MetaMask, WalletConnect) using EIP-1193 standard.
- The server backend does not require private keys to calculate, simulate, or coordinate trades.
- If autonomous server execution is optionally enabled in isolated environments, keys must be loaded from secure hardware/KMS or encrypted environment stores with minimal funded balance.

### Rule 3: Zero-Loss Atomic Transaction Invariant
- All arbitrage trades must be executed through an atomic smart contract (`ArbitrageExecutor.sol`).
- The contract must calculate the post-execution balance and verify:
  ```solidity
  require(endingBalance >= startingBalance + minProfitRequired, "ARBITRAGE_NET_PROFIT_BELOW_THRESHOLD");
  ```
- If this condition fails, the EVM automatically rolls back all state changes, preserving 100% of trading capital (only gas is spent).

### Rule 4: Simulation Before Broadcast
- Every candidate trade must undergo an `eth_call` RPC pre-flight simulation before a real transaction is broadcast to the network.
- Transactions that fail pre-flight simulation are immediately discarded.

### Rule 5: Dynamic Slippage & Price Impact Ceilings
- Trades exceeding maximum slippage (default: 0.50%) or price impact ceiling (Mainnet: 1.00%, Testnet: 3.00%) are rejected by the risk engine.

### Rule 6: Circuit Breaker & Emergency Stop
- If total cumulative daily loss exceeds `MAX_DAILY_LOSS_USDT` (due to network gas costs from market movement), the system enters immediate `EMERGENCY_STOP`.
- An active `EMERGENCY_STOP` halts all background workers, manual execution requests, and auto-trades instantly.

### Rule 7: Smart Contract Whitelisting & Access Control
- `ArbitrageExecutor.sol` and `Treasury.sol` strictly enforce:
  - OpenZeppelin `Ownable` or multi-sig access control for administrative actions.
  - OpenZeppelin `ReentrancyGuard` on all external state-modifying swap and withdrawal functions.
  - Router Whitelisting (`whitelistedRouters[router] == true`).
  - Token Whitelisting (`whitelistedTokens[token] == true`).
  - SafeERC20 library for all token transfers to protect against non-standard ERC20 implementations (such as USDT returning void).
