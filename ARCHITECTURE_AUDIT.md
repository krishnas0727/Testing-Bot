# Architecture Audit - 100% Decentralized DEX System

## Decentralized Architectural Overview

The architecture transitioned from centralized exchange REST/WebSocket polling to direct EVM blockchain JSON-RPC communication and smart-contract execution.

### Architectural Pillars

1. **RPC Layer (`dex_engine.py`)**:
   - Direct HTTP JSON-RPC client querying EVM nodes with automatic multi-endpoint fallback.
   - Decodes Uniswap V2 / SushiSwap V2 `getReserves()` and router `getAmountsOut`.
   - Simulates execution using `eth_call`.

2. **Decentralized Strategy Engine (`arbitrage.py`)**:
   - Calculates constant-product return:
     $$\Delta y = \frac{\Delta x \times 997 \times y}{x \times 1000 + \Delta x \times 997}$$
   - Deducts dynamic on-chain gas costs converted to USDT:
     $$\text{Net Profit} = \text{Gross Output} - \text{Input} - \text{Gas Cost (USD)}$$
   - Enforces price impact bounds to guard against thin pool liquidity.

3. **Atomic Smart Contract (`contracts/DexArbitrage.sol`)**:
   - Executes multi-hop swaps across DEX routers in a single transaction.
   - Enforces post-execution balance checks; reverts atomically if net return is below threshold.

4. **Non-Custodial Wallet Manager (`wallet_manager.py`)**:
   - Tracks live balances of native ETH, WETH, USDT, and USDC directly on-chain.
   - Provides safe mock wallet in MOCK mode.
