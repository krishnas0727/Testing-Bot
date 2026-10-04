# LIVE RUNBOOK — first real trade (Base mainnet)

## 0. Reality check (read once)
* A trade only makes money if Uniswap V2 and SushiSwap V2 on Base are **more than ~0.6 % apart** (2 × 0.3 % fees) **plus gas**. Most of the time they are not. The bot will correctly say "SKIPPED". That is the bot working, not broken.
* If you send when there is no spread, the contract **reverts** (you lose only gas). The new executor simulates first, so it does not even send in that case.
* Use a **fresh wallet**, ~$10–20 USDC + ~0.002 ETH on Base. Never your main wallet.
* Not financial advice; you are responsible for the funds.

## 1. Install
```bash
python -m venv .venv && source .venv/bin/activate     # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
```

## 2. `.env` (safe first values)
```ini
TRADING_MODE=LIVE
CHAIN_ID=8453
DEFAULT_CHAIN=base
RPC_URL=https://mainnet.base.org
LIVE_EXEC_RPC_URL=https://mainnet-preconf.base.org
TRADING_SYMBOL=WETH/USDC
PRIVATE_KEY=0xYOUR_FRESH_WALLET_KEY
DEFAULT_TRADE_AMOUNT=5
MAX_TRADE_AMOUNT=10
MAX_GAS_PRICE_GWEI=1
LIVE_MIN_NET_PROFIT_USDT=0.02
LIVE_TRADING_ARMED=false
EMERGENCY_STOP=false
AUTO_TRADE_ENABLED=false
```
Put the key ONLY in `.env`. Do not use the Settings page to store it (it goes to SQLite in plain text).

## 3. Deploy the contract (once)
```bash
python setup_live.py deploy          # uses build/DexArbitrage.json (compiled from contracts/DexArbitrage.sol)
# copy the printed address into .env -> ARBITRAGE_CONTRACT_ADDRESS=0x...
```
Deploy **DexArbitrage.sol** (not ArbitrageExecutor.sol — the Python bot only talks to DexArbitrage).
Optional: recompile yourself (solc 0.8.26, evm `paris`, optimizer 200) and compare bytecode.

## 4. Fund + approve
Send USDC + a little ETH to the wallet, then:
```bash
python setup_live.py approve 20      # lets the contract pull up to 20 USDC from your wallet
python setup_live.py check           # must print PRE-FLIGHT OK
```

## 5. Dry-run against the REAL pools (sends nothing)
```bash
python setup_live.py dry-run 5
```
Look at: `source=on-chain-rpc` for both DEXes, sane reserves, and the line
`ON-CHAIN router quote: ... profit-before-gas=`. If it is negative → no trade is possible right now. Re-run later.

## 6. First live trade (manual, not auto)
```bash
# .env -> LIVE_TRADING_ARMED=true
python app.py
curl -X POST http://127.0.0.1:5000/api/trade -H "Content-Type: application/json" -d '{"trade_amount": 5}'
```
Console shows, per stage:
```
[LIVE TIMING] prep=3ms | quote_sim=70ms | gas_sim=290ms | sign=5ms | decision_to_ready=300ms | broadcast=35ms | inclusion_wait=200ms | total_execute=540ms | detect->broadcast=370ms
```
and every trade appends a JSON line to `data/trade_timing.jsonl`.

Speed: Base blocks are 2 s; with the Flashblocks RPC (`LIVE_EXEC_RPC_URL`) the receipt is a ~200 ms *pre-confirmation*. Without it, expect ~2 s. Public RPCs are rate-limited — use a paid Base endpoint for anything serious.

## 7. Withdraw profit
Profit stays inside the contract. Owner-only `withdrawToken(token, amount)` on the contract (Basescan → Write Contract).

## Test without money
```bash
pip install "web3[tester]"
python scripts/local_chain_test.py
```
Runs the real executor + real contract on an in-process chain (profitable trade, thin spread, spread gone, router failure).
