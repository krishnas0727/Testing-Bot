#!/usr/bin/env python3
"""One-time setup + safety checks for live trading.

    python setup_live.py check              # read-only pre-flight (RPC, chain, key, contract, balances)
    python setup_live.py deploy             # deploy contracts/DexArbitrage.sol (uses build/DexArbitrage.json)
    python setup_live.py approve 10         # allow the contract to pull 10 units of the quote token from your wallet
    python setup_live.py dry-run 2          # scan the REAL pools, run the full on-chain simulation, send NOTHING
"""
import json
import os
import sys
import time

import config
import live_executor


def _quote_sym() -> str:
    return config.SYMBOL.split("/")[1]


def cmd_check():
    r = live_executor.preflight(_quote_sym())
    print(json.dumps(r["info"], indent=2, default=str))
    if r["ok"]:
        print("\nPRE-FLIGHT OK")
    else:
        print("\nPROBLEMS:")
        for p in r["problems"]:
            print("  -", p)
    return 0 if r["ok"] else 1


def cmd_deploy():
    from web3 import Web3
    from eth_account import Account
    art = json.load(open(os.path.join(os.path.dirname(__file__), "build", "DexArbitrage.json")))
    w3 = live_executor.get_w3()
    acct = Account.from_key(config.PRIVATE_KEY)
    print(f"Deploying from {acct.address} on chain {w3.eth.chain_id} (config CHAIN_ID={config.CHAIN_ID})")
    if w3.eth.chain_id != config.CHAIN_ID:
        print("Chain mismatch - aborting.")
        return 1
    c = w3.eth.contract(abi=art["abi"], bytecode=art["bytecode"])
    tx = c.constructor().build_transaction({
        "from": acct.address, "nonce": w3.eth.get_transaction_count(acct.address, "pending"),
        "chainId": config.CHAIN_ID,
    })
    tx["maxFeePerGas"] = int(w3.eth.get_block("latest")["baseFeePerGas"] * 2 + max(1, w3.eth.max_priority_fee))
    tx["maxPriorityFeePerGas"] = max(1, int(w3.eth.max_priority_fee))
    signed = acct.sign_transaction(tx)
    h = w3.eth.send_raw_transaction(signed.raw_transaction)
    rc = w3.eth.wait_for_transaction_receipt(h, timeout=120)
    print("Deployed at:", rc["contractAddress"])
    print("Put this in .env ->  ARBITRAGE_CONTRACT_ADDRESS=" + rc["contractAddress"])
    return 0


def cmd_approve(amount: float):
    print(live_executor.approve_quote_token(_quote_sym(), amount))
    return 0


def cmd_dry_run(amount: float):
    """Full pipeline against REAL pools. Never broadcasts."""
    import arbitrage
    from dex_engine import get_dex_reserves
    if config.TRADING_MODE == "MOCK":
        print("Set TRADING_MODE=LIVE (or TESTNET) in .env - MOCK uses fake pools.")
        return 1
    base, quote = config.SYMBOL.split("/")
    for dex in config.SUPPORTED_DEXES:
        r = get_dex_reserves(dex, base, quote)
        print(f"{dex:14s} source={r['source']:12s} pair={r['pair_address']} spot={r['spot_price']:.2f} "
              f"reserves={r['base_reserve']:.2f} {base} / {r['quote_reserve']:.2f} {quote}")
    m = arbitrage.analyze_market(custom_amount=amount)
    if not m:
        print("No market data.")
        return 1
    best = m["best_route"]
    print(json.dumps({k: best[k] for k in ("buy_dex", "sell_dex", "buy_price", "sell_price", "spread_pct", "gross_profit_usdt",
                                            "gas_cost_usdt", "net_profit_usdt", "buy_price_impact_pct", "sell_price_impact_pct",
                                            "is_profitable")}, indent=2))
    # ask the CONTRACT (real router maths) even if the estimate says unprofitable
    from web3 import Web3
    w3 = live_executor.get_w3()
    tok_in = config.TOKEN_REGISTRY[quote]
    tok_out = config.TOKEN_REGISTRY[base]
    dec = tok_in["decimals"]
    params = (Web3.to_checksum_address(config.DEX_ROUTERS[best["buy_dex"]]), Web3.to_checksum_address(config.DEX_ROUTERS[best["sell_dex"]]),
              Web3.to_checksum_address(tok_in["address"]), Web3.to_checksum_address(tok_out["address"]),
              int(amount * 10 ** dec), 0, int(time.time()) + 60)
    if config.ARBITRAGE_CONTRACT_ADDRESS:
        arb = w3.eth.contract(address=Web3.to_checksum_address(config.ARBITRAGE_CONTRACT_ADDRESS), abi=live_executor.ARB_ABI)
        prof, exp, l1, l2 = arb.functions.simulateArbitrage(params).call()
        print(f"\nON-CHAIN router quote: leg1={l1 / 1e18:.8f} {base}, leg2={l2 / 10 ** dec:.6f} {quote}, "
              f"profit-before-gas={(l2 - params[4]) / 10 ** dec:+.6f} {quote}")
    print("\n(dry-run: nothing was sent)")
    return 0


if __name__ == "__main__":
    a = sys.argv[1:]
    if not a:
        print(__doc__); sys.exit(0)
    if a[0] == "check": sys.exit(cmd_check())
    if a[0] == "deploy": sys.exit(cmd_deploy())
    if a[0] == "approve": sys.exit(cmd_approve(float(a[1]) if len(a) > 1 else 10.0))
    if a[0] == "dry-run": sys.exit(cmd_dry_run(float(a[1]) if len(a) > 1 else 2.0))
    print(__doc__)
