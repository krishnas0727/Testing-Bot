"""LIVE / TESTNET on-chain executor for DexArbitrage.sol.

What this module does (the original repo never signed or sent a transaction):

    1. Pre-flight  : chain-id, contract code, contract owner == signer, balances, allowance
    2. On-chain quote + simulation IN PARALLEL (one network round-trip, not five)
         - simulateArbitrage()  -> router getAmountsOut (real router maths, not our estimate)
         - eth_estimateGas      -> executes the real tx against current state; reverts => we never send
         - nonce + fee data
    3. Sign locally (private key never leaves the process)
    4. Broadcast (eth_sendRawTransaction)
    5. Poll the receipt every 50 ms (use a Flashblocks RPC on Base for ~200 ms pre-confirmation)
    6. Parse the ArbitrageExecuted event -> *actual* profit, compute *actual* gas cost
    7. Write a per-stage timing line to the console and to data/trade_timing.jsonl

The contract itself enforces:   balanceAfter >= balanceBefore + minProfit
and we set minProfit = gas cost (in stable units) + LIVE_MIN_NET_PROFIT_USDT,
so a trade that would not be net-positive after gas REVERTS on-chain instead of losing money.
"""
import json
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any, Dict, Optional

import config

try:
    from web3 import Web3
    from web3.logs import DISCARD
    from eth_account import Account
    _HAS_WEB3 = True
except ImportError:  # pragma: no cover
    _HAS_WEB3 = False


# ----------------------------------------------------------------------------
# Minimal ABIs
# ----------------------------------------------------------------------------
_PARAMS_TUPLE = {
    "components": [
        {"name": "routerBuy", "type": "address"},
        {"name": "routerSell", "type": "address"},
        {"name": "tokenIn", "type": "address"},
        {"name": "tokenOut", "type": "address"},
        {"name": "amountIn", "type": "uint256"},
        {"name": "minProfit", "type": "uint256"},
        {"name": "deadline", "type": "uint256"},
    ],
    "name": "params",
    "type": "tuple",
}

ARB_ABI = [
    {"type": "function", "name": "executeArbitrage", "stateMutability": "nonpayable",
     "inputs": [_PARAMS_TUPLE], "outputs": [{"name": "netProfit", "type": "uint256"}]},
    {"type": "function", "name": "simulateArbitrage", "stateMutability": "view",
     "inputs": [_PARAMS_TUPLE],
     "outputs": [{"name": "profitable", "type": "bool"}, {"name": "expectedProfit", "type": "uint256"},
                 {"name": "leg1Output", "type": "uint256"}, {"name": "leg2Output", "type": "uint256"}]},
    {"type": "function", "name": "owner", "stateMutability": "view", "inputs": [],
     "outputs": [{"name": "", "type": "address"}]},
    {"type": "function", "name": "paused", "stateMutability": "view", "inputs": [],
     "outputs": [{"name": "", "type": "bool"}]},
    {"type": "event", "name": "ArbitrageExecuted", "anonymous": False, "inputs": [
        {"indexed": True, "name": "caller", "type": "address"},
        {"indexed": True, "name": "routerBuy", "type": "address"},
        {"indexed": True, "name": "routerSell", "type": "address"},
        {"indexed": False, "name": "tokenIn", "type": "address"},
        {"indexed": False, "name": "tokenOut", "type": "address"},
        {"indexed": False, "name": "amountIn", "type": "uint256"},
        {"indexed": False, "name": "finalBalance", "type": "uint256"},
        {"indexed": False, "name": "netProfit", "type": "uint256"},
        {"indexed": False, "name": "timestamp", "type": "uint256"}]},
]

ERC20_MIN_ABI = [
    {"type": "function", "name": "balanceOf", "stateMutability": "view",
     "inputs": [{"name": "a", "type": "address"}], "outputs": [{"name": "", "type": "uint256"}]},
    {"type": "function", "name": "allowance", "stateMutability": "view",
     "inputs": [{"name": "o", "type": "address"}, {"name": "s", "type": "address"}],
     "outputs": [{"name": "", "type": "uint256"}]},
    {"type": "function", "name": "approve", "stateMutability": "nonpayable",
     "inputs": [{"name": "s", "type": "address"}, {"name": "v", "type": "uint256"}],
     "outputs": [{"name": "", "type": "bool"}]},
    {"type": "function", "name": "decimals", "stateMutability": "view", "inputs": [],
     "outputs": [{"name": "", "type": "uint8"}]},
]

_send_lock = threading.Lock()          # one transaction at a time -> no nonce collisions
_w3_cache: Dict[str, Any] = {}
_pool = ThreadPoolExecutor(max_workers=6)


# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------
def _cfg(name: str, default):
    return getattr(config, name, default)


def get_w3():
    """Web3 instance with a persistent HTTP session (keep-alive = lower latency)."""
    if not _HAS_WEB3:
        raise RuntimeError("web3 / eth-account not installed. Run: pip install -r requirements.txt")
    url = _cfg("LIVE_EXEC_RPC_URL", "") or config.RPC_URL
    w3 = _w3_cache.get(url)
    if w3 is None:
        w3 = Web3(Web3.HTTPProvider(url, request_kwargs={"timeout": 6}))
        _w3_cache[url] = w3
    return w3


def _safe_tip(w3) -> int:
    try:
        return int(w3.eth.max_priority_fee)
    except Exception:
        return 1_000_000  # 0.001 gwei fallback


def _now_ms() -> float:
    return time.perf_counter() * 1000.0


def _write_timing_log(entry: Dict[str, Any]) -> None:
    try:
        path = os.path.join(config.DATA_DIR, "trade_timing.jsonl")
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry) + "\n")
    except Exception:
        pass


def _fail(status: str, message: str, timings: Optional[Dict[str, float]] = None, **extra) -> Dict[str, Any]:
    out = {"success": False, "status": status, "message": message}
    if timings:
        out["timings_ms"] = {k: round(v, 1) for k, v in timings.items()}
    out.update(extra)
    print(f"[LIVE EXEC] {status}: {message}", flush=True)
    return out


def _resolve_tokens(plan: Dict[str, Any]):
    pair = plan.get("token_pair") or getattr(config, "SYMBOL", "WETH/USDC")
    base_sym, quote_sym = pair.split("/")
    reg = config.TOKEN_REGISTRY
    return base_sym, quote_sym, reg[base_sym], reg[quote_sym]


# ----------------------------------------------------------------------------
# Setup / pre-flight (call from the CLI helper or the API before the first live trade)
# ----------------------------------------------------------------------------
def preflight(quote_sym: Optional[str] = None) -> Dict[str, Any]:
    """Checks everything that can be checked WITHOUT spending money."""
    problems = []
    info: Dict[str, Any] = {}
    try:
        w3 = get_w3()
        rpc_chain = w3.eth.chain_id
        info["rpc_chain_id"] = rpc_chain
        if rpc_chain != config.CHAIN_ID:
            problems.append(f"RPC is chain {rpc_chain} but CHAIN_ID={config.CHAIN_ID}")
    except Exception as exc:
        return {"ok": False, "problems": [f"RPC unreachable: {exc}"], "info": info}

    pk = _cfg("PRIVATE_KEY", "").strip()
    if not pk:
        problems.append("PRIVATE_KEY is empty (server-side signing needs it).")
        return {"ok": False, "problems": problems, "info": info}
    acct = Account.from_key(pk)
    info["signer"] = acct.address
    configured = _cfg("WALLET_ADDRESS", "").strip()
    if configured and configured.lower() != acct.address.lower():
        problems.append(f"WALLET_ADDRESS {configured} does not match the PRIVATE_KEY address {acct.address}")

    contract_addr = _cfg("ARBITRAGE_CONTRACT_ADDRESS", "").strip()
    if not contract_addr:
        problems.append("ARBITRAGE_CONTRACT_ADDRESS is empty - deploy contracts/DexArbitrage.sol first.")
    else:
        contract_addr = Web3.to_checksum_address(contract_addr)
        if len(w3.eth.get_code(contract_addr)) == 0:
            problems.append(f"No contract code at {contract_addr} on chain {config.CHAIN_ID}.")
        else:
            c = w3.eth.contract(address=contract_addr, abi=ARB_ABI)
            try:
                owner = c.functions.owner().call()
                info["contract_owner"] = owner
                if owner.lower() != acct.address.lower():
                    problems.append(f"Contract owner is {owner}, signer is {acct.address}. Only the owner can call executeArbitrage.")
                if c.functions.paused().call():
                    problems.append("Contract is paused.")
            except Exception as exc:
                problems.append(f"Address is not a DexArbitrage contract (owner() failed): {exc}")

    eth_bal = w3.eth.get_balance(acct.address) / 1e18
    info["native_balance"] = eth_bal
    if eth_bal < 0.0002:
        problems.append(f"Signer has only {eth_bal:.6f} native ETH for gas.")

    if quote_sym:
        tok = config.TOKEN_REGISTRY.get(quote_sym)
        if tok and contract_addr:
            t = w3.eth.contract(address=Web3.to_checksum_address(tok["address"]), abi=ERC20_MIN_ABI)
            wallet_bal = t.functions.balanceOf(acct.address).call() / 10 ** tok["decimals"]
            contract_bal = t.functions.balanceOf(contract_addr).call() / 10 ** tok["decimals"]
            allowance = t.functions.allowance(acct.address, contract_addr).call() / 10 ** tok["decimals"]
            info.update({f"{quote_sym}_wallet": wallet_bal, f"{quote_sym}_in_contract": contract_bal,
                         f"{quote_sym}_allowance_to_contract": allowance})
            if wallet_bal + contract_bal <= 0:
                problems.append(f"No {quote_sym} in wallet or contract.")

    return {"ok": not problems, "problems": problems, "info": info}


def approve_quote_token(quote_sym: str, amount: Optional[float] = None) -> Dict[str, Any]:
    """One-time: let DexArbitrage pull `quote_sym` from the signer wallet (or just transfer tokens to the contract)."""
    w3 = get_w3()
    acct = Account.from_key(config.PRIVATE_KEY)
    tok = config.TOKEN_REGISTRY[quote_sym]
    spender = Web3.to_checksum_address(config.ARBITRAGE_CONTRACT_ADDRESS)
    raw = int((amount if amount is not None else float(_cfg("MAX_TRADE_AMOUNT", 5.0)) * 2) * 10 ** tok["decimals"])
    t = w3.eth.contract(address=Web3.to_checksum_address(tok["address"]), abi=ERC20_MIN_ABI)
    tx = t.functions.approve(spender, raw).build_transaction({
        "from": acct.address, "nonce": w3.eth.get_transaction_count(acct.address, "pending"),
        "chainId": config.CHAIN_ID,
        "maxFeePerGas": int(w3.eth.gas_price * 2), "maxPriorityFeePerGas": int(min(w3.eth.max_priority_fee, w3.eth.gas_price)),
    })
    signed = acct.sign_transaction(tx)
    h = w3.eth.send_raw_transaction(signed.raw_transaction)
    rc = w3.eth.wait_for_transaction_receipt(h, timeout=60, poll_latency=0.2)
    return {"tx_hash": h.hex(), "status": rc["status"], "approved_raw": raw}


# ----------------------------------------------------------------------------
# THE TRADE
# ----------------------------------------------------------------------------
def execute_live(plan: Dict[str, Any]) -> Dict[str, Any]:
    """Sign and broadcast one atomic arbitrage. Returns the same shape as the MOCK path."""
    # Phase 4 Mandate: Emergency stop must block any live execution path / transaction submission
    if getattr(config, "EMERGENCY_STOP", True):
        return _fail("BLOCKED_EMERGENCY_STOP", "Emergency stop is active; live transaction submission blocked.")

    t: Dict[str, float] = {}
    t0 = _now_ms()
    detect_ts = float(plan.get("detected_at_ms") or 0.0)   # wall-clock ms when the opportunity was found

    if not _HAS_WEB3:
        return _fail("LIVE_SIGNER_REQUIRED", "web3 / eth-account not installed.")
    pk = _cfg("PRIVATE_KEY", "").strip()
    contract_addr = _cfg("ARBITRAGE_CONTRACT_ADDRESS", "").strip()
    if not pk:
        return _fail("LIVE_SIGNER_REQUIRED", "PRIVATE_KEY not configured for server-side signing.")
    if not contract_addr:
        return _fail("REQUIRES_DEPLOYED_CONTRACT", "Set ARBITRAGE_CONTRACT_ADDRESS to your deployed DexArbitrage.sol.")

    try:
        w3 = get_w3()
        acct = Account.from_key(pk)
        contract_addr = Web3.to_checksum_address(contract_addr)
        base_sym, quote_sym, base_tok, quote_tok = _resolve_tokens(plan)
        dec = int(quote_tok["decimals"])

        buy_dex, sell_dex = plan["buy_dex"], plan["sell_dex"]
        cid = int(plan.get("chain_id", getattr(config, "CHAIN_ID", 8453)))
        is_valid_routers, router_reason, _ = config.validate_chain_dex_routers(cid)
        if not is_valid_routers:
            return _fail("TRADE SKIPPED", router_reason)

        if buy_dex == sell_dex or config.DEX_ROUTERS.get(buy_dex, "").lower() == config.DEX_ROUTERS.get(sell_dex, "").lower():
            return _fail("TRADE SKIPPED", "Arbitrage unavailable: fewer than two valid DEX routers configured.")

        router_buy = Web3.to_checksum_address(config.DEX_ROUTERS[buy_dex])
        router_sell = Web3.to_checksum_address(config.DEX_ROUTERS[sell_dex])
        token_in = Web3.to_checksum_address(quote_tok["address"])
        token_out = Web3.to_checksum_address(base_tok["address"])

        amount_in_f = float(plan["amount_in"])
        amount_in_raw = int(amount_in_f * 10 ** dec)
        if amount_in_raw <= 0:
            return _fail("TRADE SKIPPED", "amount_in rounds to zero.")

        # minProfit (in stable units) = gas + required net margin -> contract reverts if not net-positive
        gas_cost_est_usd = float(plan.get("gas_cost_usdt", 0.0))
        margin_usd = float(_cfg("LIVE_MIN_NET_PROFIT_USDT", 0.01))
        min_profit_raw = int((gas_cost_est_usd * float(_cfg("LIVE_GAS_SAFETY_MULT", 1.5)) + margin_usd) * 10 ** dec)

        deadline = int(time.time()) + int(_cfg("LIVE_DEADLINE_SEC", 20))
        params = (router_buy, router_sell, token_in, token_out, amount_in_raw, min_profit_raw, deadline)

        arb = w3.eth.contract(address=contract_addr, abi=ARB_ABI)
        erc = w3.eth.contract(address=token_in, abi=ERC20_MIN_ABI)

        with _send_lock:
            t["prep"] = _now_ms() - t0

            # ---- parallel: on-chain quote, real-tx simulation/gas, nonce, fees, balances -------
            t1 = _now_ms()
            f_quote = _pool.submit(lambda: arb.functions.simulateArbitrage(params).call({"from": acct.address}))
            f_gas = _pool.submit(lambda: arb.functions.executeArbitrage(params).estimate_gas({"from": acct.address}))
            f_nonce = _pool.submit(lambda: w3.eth.get_transaction_count(acct.address, "pending"))
            f_block = _pool.submit(lambda: w3.eth.get_block("latest"))
            f_tip = _pool.submit(_safe_tip, w3)
            f_wbal = _pool.submit(lambda: erc.functions.balanceOf(acct.address).call())
            f_cbal = _pool.submit(lambda: erc.functions.balanceOf(contract_addr).call())
            f_alw = _pool.submit(lambda: erc.functions.allowance(acct.address, contract_addr).call())
            f_eth_bal = _pool.submit(lambda: w3.eth.get_balance(acct.address))

            # balances first (cheap, decides whether the trade is even fundable)
            wallet_bal, contract_bal, allowance = f_wbal.result(), f_cbal.result(), f_alw.result()
            shortfall = max(0, amount_in_raw - contract_bal)
            if shortfall > wallet_bal:
                return _fail("INSUFFICIENT_TOKEN_BALANCE",
                             f"Need {amount_in_f} {quote_sym}; wallet has {wallet_bal / 10 ** dec:.4f} and contract holds {contract_bal / 10 ** dec:.4f}.")
            if shortfall > 0 and allowance < shortfall:
                return _fail("TOKEN_ALLOWANCE_REQUIRED",
                             f"Approve the contract to spend {quote_sym} (python setup_live.py approve), or transfer {quote_sym} to the contract.")

            try:
                profitable, exp_profit_raw, leg1_raw, leg2_raw = f_quote.result()
            except Exception as exc:
                return _fail("SIMULATION_FAILED", f"On-chain quote failed (pool/router missing?): {exc}")
            t["quote_sim"] = _now_ms() - t1
            quoted_profit = (leg2_raw - amount_in_raw) / 10 ** dec      # before gas; can be negative
            exp_profit = max(0.0, exp_profit_raw / 10 ** dec)
            if not profitable or exp_profit_raw < min_profit_raw:
                return _fail("SIMULATION_FAILED",
                             f"On-chain router quote: {quoted_profit:+.4f} {quote_sym} before gas, need >= "
                             f"{min_profit_raw / 10 ** dec:.4f} (gas + margin). Spread gone / too thin. Nothing sent, no gas spent.", t)

            try:
                gas_est = f_gas.result()
            except Exception as exc:
                return _fail("GAS_ESTIMATION_FAILED", f"eth_estimateGas reverted -> tx would fail. Nothing sent. Detail: {exc}", t)
            t["gas_sim"] = _now_ms() - t1

            # ---- fees -----------------------------------------------------------------------
            block = f_block.result()
            base_fee = int(block.get("baseFeePerGas", 0))
            tip = int(f_tip.result())
            max_tip = int(float(_cfg("LIVE_MAX_PRIORITY_GWEI", 0.05)) * 1e9)
            tip = max(1, min(tip, max_tip))
            max_fee = int(base_fee * 2 + tip)
            gwei = max_fee / 1e9
            if gwei > float(_cfg("MAX_GAS_PRICE_GWEI", 50.0)):
                return _fail("TRADE_SKIPPED", f"Gas {gwei:.4f} Gwei exceeds MAX_GAS_PRICE_GWEI.", t)

            gas_limit = int(gas_est * float(_cfg("LIVE_GAS_LIMIT_BUFFER", 1.3)))

            # Gas balance check (Requirement 5)
            required_gas_wei = int(gas_limit * max_fee)
            signer_eth_bal = f_eth_bal.result()
            if signer_eth_bal < required_gas_wei:
                return _fail("INSUFFICIENT_GAS_BALANCE",
                             f"Signer has {signer_eth_bal / 1e18:.6f} ETH for gas; need at least {required_gas_wei / 1e18:.6f} ETH.", t)

            tx = arb.functions.executeArbitrage(params).build_transaction({
                "from": acct.address, "nonce": f_nonce.result(), "chainId": config.CHAIN_ID,
                "gas": gas_limit, "maxFeePerGas": max_fee, "maxPriorityFeePerGas": tip, "type": 2,
            })

            # ---- sign ------------------------------------------------------------------------
            t2 = _now_ms()
            signed = acct.sign_transaction(tx)
            t["sign"] = _now_ms() - t2
            t["decision_to_ready"] = _now_ms() - t0

            # ---- broadcast -------------------------------------------------------------------
            t3 = _now_ms()
            tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
            t["broadcast"] = _now_ms() - t3
            t_sent_total = _now_ms() - t0
            sent_wall = time.time() * 1000.0
            print(f"[LIVE EXEC] broadcast {tx_hash.hex()} {t_sent_total:.0f} ms after execute() started", flush=True)

            # ---- receipt (poll fast; on Base preconf RPC this returns in ~200 ms) --------------
            t4 = _now_ms()
            receipt = None
            timeout = float(_cfg("LIVE_RECEIPT_TIMEOUT_SEC", 30))
            poll = float(_cfg("LIVE_RECEIPT_POLL_SEC", 0.05))
            while (_now_ms() - t4) / 1000.0 < timeout:
                try:
                    receipt = w3.eth.get_transaction_receipt(tx_hash)
                    if receipt is not None:
                        break
                except Exception:
                    pass
                time.sleep(poll)
            t["inclusion_wait"] = _now_ms() - t4
            t["total_execute"] = _now_ms() - t0

        if receipt is None:
            return _fail("PENDING_TIMEOUT", f"Tx {tx_hash.hex()} not seen in {timeout}s; check the explorer before retrying.",
                         t, tx_hash=tx_hash.hex())

        gas_used = int(receipt["gasUsed"])
        eff_price = int(receipt.get("effectiveGasPrice", max_fee))
        gas_eth = gas_used * eff_price / 1e18
        eth_price = float(plan.get("eth_price_usdt") or plan.get("buy_price") or 0.0)
        gas_usd = gas_eth * eth_price if eth_price > 0 else gas_cost_est_usd
        # L1 data fee on OP-stack chains is not in gasUsed*effectiveGasPrice -> add it if the receipt exposes it
        l1_fee = receipt.get("l1Fee")
        if l1_fee is not None and eth_price > 0:
            try:
                l1_fee_int = int(l1_fee, 16) if isinstance(l1_fee, str) else int(l1_fee)
                gas_usd += (l1_fee_int / 1e18) * eth_price
            except Exception:
                pass

        timing_line = {
            "ts": datetime.now(timezone.utc).isoformat(), "tx_hash": tx_hash.hex(), "chain_id": config.CHAIN_ID,
            "route": f"{buy_dex}->{sell_dex}", "amount_in": amount_in_f,
            "detect_to_broadcast_ms": round(sent_wall - detect_ts, 1) if detect_ts else None,
            "stages_ms": {k: round(v, 1) for k, v in t.items()},
            "block_number": int(receipt["blockNumber"]), "status": int(receipt["status"]),
        }
        _write_timing_log(timing_line)
        print(
            "[LIVE TIMING] "
            + " | ".join(f"{k}={v:.0f}ms" for k, v in t.items())
            + (f" | detect->broadcast={timing_line['detect_to_broadcast_ms']:.0f}ms" if detect_ts else ""),
            flush=True,
        )

        if int(receipt["status"]) != 1:
            return _fail("REVERTED",
                         f"Tx {tx_hash.hex()} reverted on-chain (capital safe, gas ${gas_usd:.4f} spent).", t,
                         tx_hash=tx_hash.hex(), gas_used=gas_used, gas_cost_usdt=round(gas_usd, 6))

        # actual profit from the event
        actual_profit = None
        try:
            evs = arb.events.ArbitrageExecuted().process_receipt(receipt, errors=DISCARD)
            if evs:
                actual_profit = evs[0]["args"]["netProfit"] / 10 ** dec
        except Exception:
            pass
        if actual_profit is None:
            actual_profit = exp_profit
        net_profit = actual_profit - gas_usd
        amount_out = amount_in_f + actual_profit

        trade_record = {
            "tx_hash": tx_hash.hex() if tx_hash.hex().startswith("0x") else "0x" + tx_hash.hex(),
            "chain_id": int(config.CHAIN_ID), "buy_dex": buy_dex, "sell_dex": sell_dex,
            "token_pair": f"{base_sym}/{quote_sym}", "amount_in": amount_in_f, "amount_out": amount_out,
            "gross_profit": actual_profit, "net_profit": net_profit, "gas_used": gas_used,
            "gas_price_gwei": round(eff_price / 1e9, 6), "gas_cost_usdt": round(gas_usd, 6),
            "price_impact": float(plan.get("max_price_impact_pct", 0.0)), "slippage": float(_cfg("SLIPPAGE_PCT", 0.5)),
            "status": "CONFIRMED" if net_profit > 0 else "FAILED",
            "mode": _cfg("TRADING_MODE", "LIVE"), "created_at": datetime.now().astimezone().isoformat(),
            "timings_ms": {k: round(v, 1) for k, v in t.items()},
        }
        return {
            "success": net_profit > 0, "status": trade_record["status"],
            "message": f"LIVE atomic arbitrage mined in block {receipt['blockNumber']}: gross +{actual_profit:.4f}, "
                       f"gas -{gas_usd:.4f}, net {net_profit:+.4f} {quote_sym}.",
            "trade": trade_record, "tx_hash": trade_record["tx_hash"], "net_profit": net_profit,
            "gross_return": amount_out, "timings_ms": trade_record["timings_ms"],
        }
    except Exception as exc:
        return _fail("LIVE_EXECUTION_ERROR", f"{type(exc).__name__}: {exc}", t)
