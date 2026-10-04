# What was changed and why
| File | Problem in original | Fix |
|---|---|---|
| dex_engine.py `execute_atomic_trade` | LIVE path never signed/sent anything (returned LIVE_SIGNER_REQUIRED) | dispatches to new `live_executor.py` |
| dex_engine.py `get_dex_reserves` | Injected a fake +1.5 % SushiSwap price and clamped prices to ~$2740 **in every mode**; silently used simulated pools if RPC failed | fake spread / clamp / simulated pools only in MOCK; LIVE raises and skips |
| contracts/DexArbitrage.sol | Did not compile ("Stack too deep") | `executeArbitrage` split into helpers; same logic |
| dex_contract.py | Wrong function selectors for executeArbitrage / simulateArbitrage | corrected |
| arbitrage.py | Gas cost capped at 0.05–0.2 % of trade size in all modes (hides real cost); LIVE sizing used 95 % of wallet; reverted txs not counted in daily-loss limit | real gas (+L1 fee on Base) in LIVE; sizing uses DEFAULT_TRADE_AMOUNT; reverts recorded |
| database.py | Daily-loss breaker counted only CONFIRMED trades | also REVERTED / UNPROFITABLE |
| config.py | `LIVE_TRADING_ARMED` defaulted to **true**; HOST 0.0.0.0; MAX_TRADE_AMOUNT 5000 | false; 127.0.0.1; 20 |
| NEW live_executor.py | — | preflight, parallel on-chain quote + tx simulation, EIP-1559 sign/send, fast receipt polling, event-based real profit, timing log |
| NEW setup_live.py, scripts/local_chain_test.py, build/*.json | — | deploy / approve / check / dry-run, and a no-money end-to-end test |

Known leftovers: `/api/trade/confirm-live` (MetaMask path) still trusts client-supplied profit numbers; the Flask API has no authentication (keep it on 127.0.0.1); tests that expect dust ($0.01–$0.20) trades to be "profitable" now fail on purpose (they relied on the gas cap); 24 tests already failed before (pytest not installed).
