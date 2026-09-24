# DEX Arbitrage Terminal

This project is a 100% decentralized, on-chain crypto arbitrage trading terminal. It completely operates without centralized exchanges, CEX APIs, or custodial accounts. All pricing, liquidity depth checks, and trade executions route directly through Web3 blockchain JSON-RPC and atomic smart contracts (Uniswap V2 ↔ SushiSwap V2).

---

## Key Features

1. **100% Decentralized & Non-Custodial**:
   - Operates entirely on decentralized liquidity pools with zero custodial risk.
   - Direct Web3 JSON-RPC integration with Ethereum Mainnet, Arbitrum, Polygon, and Sepolia Testnet.


2. **DEX-to-DEX Arbitrage Engine**:
   - Continuous scanning of on-chain liquidity pools between Uniswap V2 and SushiSwap V2.
   - Exact constant-product formula modeling ($x \cdot y = k$) with 0.30% protocol swap fees.

3. **Atomic Smart Contract Execution**:
   - Includes production Solidity contract (`contracts/DexArbitrage.sol`).
   - Executes multi-hop swaps across DEX routers atomically within a single transaction.
   - Reverts atomically with zero fund loss if net return is below input amount + minimum profit threshold.

4. **Dynamic On-Chain Gas & Slippage Gates**:
   - Real-time gas price fetching via `eth_gasPrice` (Gwei).
   - Dynamic transaction fee conversion to USD/USDT deducted from gross spread.
   - Strict price impact limits (default 1.00%) and slippage tolerance controls (default 0.50%).

5. **Safe Modes (MOCK / TESTNET / LIVE)**:
   - **MOCK Mode (Default)**: Fetches real live on-chain pool prices via RPC, performs full mathematical validation and simulation, without risking real funds.
   - **TESTNET Mode**: Executes transactions on Sepolia testnet.
   - **LIVE Mode**: Mainnet execution (requires explicit arming and private key configuration).

---

## Local Setup

Python 3.11+ is recommended.

```bash
# Clone or extract repository
cd decenter

# Setup virtual environment
python -m venv .venv

# Windows
.venv\Scripts\activate

# macOS / Linux
# source .venv/bin/activate

# Install dependencies
python -m pip install -r requirements.txt

# Run test suite
python -m unittest discover tests -v

# Start Flask server
python app.py
```

Open `http://127.0.0.1:5000` in your web browser.

---

## Configuration (`.env`)

Copy `.env.example` to `.env` to configure your node and wallet:

```ini
RPC_URL=https://cloudflare-eth.com
CHAIN_ID=1
DEFAULT_CHAIN=ethereum
TRADING_SYMBOL=WETH/USDT

# Safe defaults
TRADING_MODE=MOCK
AUTO_TRADE_ENABLED=false
LIVE_TRADING_ARMED=false
EMERGENCY_STOP=true

# Wallet (optional in MOCK mode)
WALLET_ADDRESS=
PRIVATE_KEY=
ARBITRAGE_CONTRACT_ADDRESS=
```

---

## Smart Contract Deployment

1. The smart contract source is located at `contracts/DexArbitrage.sol`.
2. Deploy to Ethereum or Sepolia using Foundry, Hardhat, or Remix.
3. Paste the deployed contract address into `ARBITRAGE_CONTRACT_ADDRESS`.
