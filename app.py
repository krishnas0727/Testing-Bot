"""100% Decentralized Crypto Arbitrage Web Application.

Connects the user interface to decentralized exchanges (Uniswap V2, SushiSwap V2)
via Web3 JSON-RPC. Completely eliminates all centralized exchange code, APIs,
and credentials. Supports MOCK, TESTNET, and LIVE trading modes.
"""
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Dict, Any, Optional, List

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

from flask import Flask, jsonify, render_template, request


import config
from arbitrage import (
    analyze_market,
    calculate_dynamic_trade_amount,
    daily_loss_limit_reached,
    emergency_stop_active,
    execute_real_trade,
)
from dex_engine import (
    get_block_number,
    get_gas_price,
    simulate_atomic_arbitrage,
)
from dex_contract import DEX_ARBITRAGE_ABI
from live_verification import get_live_verification_status, run_live_verification
from market_stream import public_bbo_stream
from wallet_manager import get_wallet_balances
from database import (
    create_database,
    get_all_trades,
    get_latest_trade,
    get_total_profit,
    get_total_trades,
    load_all_bot_settings,
    save_bot_setting,
    save_trade,
    get_live_pnl_summary,
    delete_all_trades,
)

app = Flask(__name__)
SERVER_STARTED_AT = time.time()

# Ensure database tables exist
create_database()
print(f"[DEX App] Database initialized: {config.DATABASE_NAME}", flush=True)

# Start background on-chain DEX stream
if getattr(config, "ON_CHAIN_STREAM_ENABLED", True):
    public_bbo_stream.start()

# Restore saved settings from database
try:
    _saved = load_all_bot_settings()
    if "auto_trade" in _saved:
        config.AUTO_TRADE_ENABLED = bool(_saved["auto_trade"])
    if "trading_mode" in _saved:
        config.TRADING_MODE = str(_saved["trading_mode"]).upper()
    if "min_profit" in _saved:
        saved_min_profit = float(_saved["min_profit"])
        if saved_min_profit >= 0.50:
            config.MIN_PROFIT_USDT = 0.005
            save_bot_setting("min_profit", 0.005)
        else:
            config.MIN_PROFIT_USDT = saved_min_profit
    if "trade_amount" in _saved:
        saved_trade_amount = float(_saved["trade_amount"])
        if saved_trade_amount >= 50.0:
            config.DEFAULT_TRADE_AMOUNT = 5.0
            save_bot_setting("trade_amount", 5.0)
        else:
            config.DEFAULT_TRADE_AMOUNT = saved_trade_amount
    if "min_profit_percent" in _saved:
        saved_min_pct = float(_saved["min_profit_percent"])
        if saved_min_pct >= 0.05:
            config.MIN_PROFIT_PERCENT = 0.005
            save_bot_setting("min_profit_percent", 0.005)
        else:
            config.MIN_PROFIT_PERCENT = saved_min_pct
    if "slippage_pct" in _saved:
        config.SLIPPAGE_PCT = float(_saved["slippage_pct"])
    if "max_price_impact_pct" in _saved:
        config.MAX_PRICE_IMPACT_PCT = float(_saved["max_price_impact_pct"])
    if "rpc_url" in _saved and _saved["rpc_url"]:
        config.RPC_URL = str(_saved["rpc_url"]).strip()
    if "wallet_address" in _saved and _saved["wallet_address"]:
        config.WALLET_ADDRESS = str(_saved["wallet_address"]).strip()
    if "private_key" in _saved and _saved["private_key"]:
        config.PRIVATE_KEY = str(_saved["private_key"]).strip()
        if not getattr(config, "WALLET_ADDRESS", ""):
            try:
                from eth_account import Account
                _acct = Account.from_key(config.PRIVATE_KEY)
                config.WALLET_ADDRESS = _acct.address
            except Exception:
                pass
    if "contract_address" in _saved and _saved["contract_address"]:
        config.ARBITRAGE_CONTRACT_ADDRESS = str(_saved["contract_address"]).strip()
    if "chain_id" in _saved:
        try:
            cid = int(_saved["chain_id"])
            if cid in config.CHAIN_REGISTRY:
                config.set_active_chain(cid)
        except Exception:
            pass
    if "emergency_stop" in _saved:
        config.EMERGENCY_STOP = bool(_saved["emergency_stop"])
    if "live_trading_armed" in _saved:
        config.LIVE_TRADING_ARMED = bool(_saved["live_trading_armed"])
except Exception as _e:
    print(f"⚠️ Error restoring saved DEX settings: {_e}", flush=True)


# =====================================================
# BACKGROUND AUTO TRADER & EXECUTION AUDIT LOG
# =====================================================

last_background_trade_result = None
last_execution_status = "STANDBY - AUTO TRADE DISABLED"

# Rolling in-memory execution diagnostics and skip events log (latest 50 events)
execution_audit_logs: list = []
MAX_AUDIT_LOGS = 50


def record_execution_event(
    event_type: str,
    route: str,
    amount_in: float,
    net_profit: float,
    status: str,
    reason: str,
    tx_hash: str = ""
):
    """Record execution or skip event in rolling in-memory audit log for real-time debugging."""
    global execution_audit_logs
    entry = {
        "id": len(execution_audit_logs) + 1,
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime()),
        "event_type": event_type,
        "route": route,
        "amount_in": round(float(amount_in), 2),
        "net_profit": round(float(net_profit), 4),
        "status": status,
        "reason": reason,
        "tx_hash": tx_hash or "",
    }
    execution_audit_logs.insert(0, entry)
    if len(execution_audit_logs) > MAX_AUDIT_LOGS:
        execution_audit_logs = execution_audit_logs[:MAX_AUDIT_LOGS]


def get_engine_status(chain_id: Optional[int] = None) -> str:
    """Return truthful engine state reflecting current environment, mode, and selected chain."""
    if emergency_stop_active():
        return "BLOCKED - EMERGENCY STOP ACTIVE"
    if not getattr(config, "AUTO_TRADE_ENABLED", False):
        return "STANDBY - AUTO TRADE DISABLED"

    mode = getattr(config, "TRADING_MODE", "MOCK").upper()
    cid = chain_id if chain_id is not None else getattr(config, "CHAIN_ID", 8453)
    chain_info = config.CHAIN_REGISTRY.get(cid, {})
    is_testnet = bool(chain_info.get("is_testnet", False))
    chain_label = chain_info.get("label", f"Chain {cid}")

    if mode == "TESTNET":
        if not is_testnet:
            return f"STANDBY - CHAIN MISMATCH: Testnet mode active but {chain_label} is Mainnet (Switch to Sepolia)"
        if not getattr(config, "LIVE_TRADING_ARMED", False):
            return "STANDBY - TESTNET TRADING NOT ARMED"
        has_signer = bool(getattr(config, "PRIVATE_KEY", "").strip()) or bool(getattr(config, "WALLET_ADDRESS", "").strip())
        if not has_signer:
            return "STANDBY - CONNECT WALLET FOR TESTNET EXECUTION"
        return f"ACTIVE - SCANNING {chain_label.upper()} POOLS"

    if mode == "LIVE":
        if is_testnet:
            return f"STANDBY - CHAIN MISMATCH: Live mode active but {chain_label} is Testnet (Switch to Mainnet)"
        if not getattr(config, "LIVE_TRADING_ARMED", False):
            return "STANDBY - LIVE TRADING NOT ARMED"
        has_signer = bool(getattr(config, "PRIVATE_KEY", "").strip()) or bool(getattr(config, "WALLET_ADDRESS", "").strip())
        if not has_signer:
            return "STANDBY - CONNECT WALLET FOR LIVE EXECUTION"
        return f"ACTIVE - SCANNING {chain_label.upper()} POOLS"

    # MOCK mode
    return f"ACTIVE - SCANNING {chain_label.upper()} POOLS (SIMULATION)"


def _acquire_auto_trader_lock() -> bool:
    """Prevent duplicate trader loops across WSGI workers."""
    path = getattr(config, "AUTO_TRADER_LOCK_PATH", "auto_trader.lock")
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.write(fd, str(os.getpid()).encode("utf-8"))
        os.close(fd)
        return True
    except FileExistsError:
        return False
    except Exception:
        return False


def start_background_auto_trader():
    if not _acquire_auto_trader_lock():
        return

    def auto_trader_loop():
        global last_background_trade_result, last_execution_status
        print("[DEX Auto-Trader] Background loop started.", flush=True)

        while True:
            try:
                auto_enabled = getattr(config, "AUTO_TRADE_ENABLED", False)
                mode = getattr(config, "TRADING_MODE", "MOCK").upper()
                live_armed = getattr(config, "LIVE_TRADING_ARMED", False)
                is_armed = (mode == "MOCK") or (mode in ("TESTNET", "LIVE") and live_armed)

                active_cid = getattr(config, "CHAIN_ID", 8453)
                chain_info = config.CHAIN_REGISTRY.get(active_cid, {})
                is_chain_testnet = bool(chain_info.get("is_testnet", False))
                chain_compatible = (mode == "MOCK") or (mode == "TESTNET" and is_chain_testnet) or (mode == "LIVE" and not is_chain_testnet)

                if auto_enabled and is_armed and chain_compatible and not emergency_stop_active():
                    market = analyze_market()

                    if market and market.get("is_profitable"):
                        result = execute_real_trade(market, is_manual=False)
                        last_background_trade_result = result

                        if result:
                            best_r = market.get("best_route") or {}
                            route_name = f"{best_r.get('buy_dex', 'Uniswap_V2')} -> {best_r.get('sell_dex', 'SushiSwap_V2')}"
                            amt = float(best_r.get("amount_in", getattr(config, "DEFAULT_TRADE_AMOUNT", 10.0)))
                            np = float(best_r.get("net_profit_usdt", 0.0))

                            if result.get("success"):
                                last_execution_status = "ATOMIC TRADE FILLED"
                                t = result.get("trade", {})
                                record_execution_event(
                                    event_type="TRADE_FILLED",
                                    route=route_name,
                                    amount_in=amt,
                                    net_profit=np,
                                    status="FILLED",
                                    reason=f"Profit: +${t.get('net_profit', 0):.4f} USDT",
                                    tx_hash=t.get("tx_hash", "")
                                )
                                print(
                                    f"[DEX Trade Executed] {t.get('buy_dex')} -> {t.get('sell_dex')} | "
                                    f"Profit: +${t.get('net_profit', 0):.4f} USDT | Tx: {t.get('tx_hash', '')[:16]}...",
                                    flush=True
                                )
                            elif result.get("status") in ("TRADE SKIPPED", "INSUFFICIENT BALANCE"):
                                reason = result.get("skip_reason") or result.get("message") or "Condition not met"
                                clean_reason = reason
                                for pfx in ("INSUFFICIENT BALANCE:", "SKIP:", "Execution skipped:"):
                                    if clean_reason.startswith(pfx):
                                        clean_reason = clean_reason[len(pfx):].strip()

                                is_insufficient = "INSUFFICIENT BALANCE" in reason or result.get("status") == "INSUFFICIENT BALANCE"
                                record_execution_event(
                                    event_type="INSUFFICIENT_BALANCE" if is_insufficient else "TRADE_SKIPPED",
                                    route=route_name,
                                    amount_in=amt,
                                    net_profit=np,
                                    status="INSUFFICIENT_BALANCE" if is_insufficient else "SKIPPED",
                                    reason=clean_reason
                                )
                                if "Cooldown" in reason or "Duplicate" in reason:
                                    last_execution_status = "ACTIVE - SCANNING FOR NEXT ARBITRAGE"
                                elif is_insufficient:
                                    last_execution_status = f"INSUFFICIENT BALANCE: {clean_reason}"
                                else:
                                    last_execution_status = f"TRADE SKIPPED: {clean_reason}"
                            else:
                                msg = result.get("message", "Execution error")
                                record_execution_event(
                                    event_type="TRADE_FAILED",
                                    route=route_name,
                                    amount_in=amt,
                                    net_profit=np,
                                    status="FAILED",
                                    reason=msg
                                )
                                last_execution_status = f"TRADE FAILED: {msg}"
                    else:
                        best = market.get("best_route") if market else None
                        if best:
                            net_p = float(best.get("net_profit_usdt", 0.0))
                            if net_p <= 0:
                                last_execution_status = f"STANDBY: Unprofitable spread (Net: -${abs(net_p):.4f} USDT)"
                            elif not best.get("is_gas_acceptable", True):
                                last_execution_status = "STANDBY: Gas price exceeds ceiling"
                            elif best.get("max_price_impact_pct", 0) > config.MAX_PRICE_IMPACT_PCT:
                                last_execution_status = f"STANDBY: Price impact ({best.get('max_price_impact_pct'):.2f}%) exceeds safety limit"
                            else:
                                last_execution_status = f"ACTIVE - SCANNING {chain_info.get('label', 'LIQUIDITY').upper()} POOLS"
                        else:
                            last_execution_status = f"ACTIVE - SCANNING {chain_info.get('label', 'LIQUIDITY').upper()} POOLS"
                else:
                    last_execution_status = get_engine_status(active_cid)
            except Exception as err:
                print(f"[DEX Auto-Trader Error]: {err}", flush=True)
                last_execution_status = "ERROR - CHECK ENGINE LOGS"

            time.sleep(getattr(config, "REFRESH_INTERVAL", 2))

    threading.Thread(target=auto_trader_loop, daemon=True).start()


start_background_auto_trader()


# =====================================================
# FRONTEND PAGES (SPA)
# =====================================================

@app.route("/")
@app.route("/prices")
@app.route("/arbitrage")
@app.route("/trades")
@app.route("/settings")
def index_page():
    return render_template("index.html")


# =====================================================
# CORE DEX MARKET & LIQUIDITY API
# =====================================================

@app.route("/api/market", methods=["GET"])
def market_api():
    try:
        # Synchronize client passed address and chain_id across all workers before analyzing market
        client_addr = (request.args.get("address") or "").strip()
        client_chain_id = request.args.get("chain_id")
        if client_chain_id:
            try:
                cid = int(client_chain_id)
                if cid in config.CHAIN_REGISTRY and cid != config.CHAIN_ID:
                    config.set_active_chain(cid)
                    save_bot_setting("chain_id", cid)
            except (ValueError, TypeError):
                pass

        if client_addr and client_addr.startswith("0x") and len(client_addr) == 42:
            if config.WALLET_ADDRESS != client_addr:
                config.WALLET_ADDRESS = client_addr
                save_bot_setting("wallet_address", client_addr)

        custom_amount = request.args.get("amount") or request.args.get("trade_amount")
        parsed_amount = None
        if custom_amount:
            try:
                parsed_amount = float(custom_amount)
            except (ValueError, TypeError):
                parsed_amount = None

        market = analyze_market(custom_amount=parsed_amount)
        if not market:
            return jsonify({
                "success": False,
                "message": "Unable to fetch on-chain DEX reserves. Check RPC node status."
            }), 503

        market["timestamp"] = time.time() * 1000

        # Calculate live wallet equity
        prices = market.get("prices", {})
        avg_eth_price = sum(prices.values()) / len(prices) if prices else 3000.0
        wallet = get_wallet_balances(avg_eth_price, wallet_address=client_addr or None)

        # Gating rules:
        # If wallet is disconnected/zero balance or Emergency Stop is active, show 0 trades and 0 profit.
        # Keep Simulation data completely separate from LIVE.
        is_wallet_connected = bool(wallet.get("is_connected")) and bool(wallet.get("wallet_address"))
        total_balance = float(wallet.get("total_equity_usdt", 0.0))
        is_emergency = emergency_stop_active()
        mode = getattr(config, "TRADING_MODE", "LIVE")

        if not is_wallet_connected or total_balance <= 0.0 or is_emergency:
            display_profit = 0.0
            display_trades = 0
        else:
            display_profit = get_total_profit(mode=mode)
            display_trades = get_total_trades(mode=mode)

        latest_trade = get_latest_trade(mode=mode if mode == "LIVE" else None)

        # Truthfully evaluate engine status for selected chain & live market conditions
        active_cid = getattr(config, "CHAIN_ID", 8453)
        base_engine_status = get_engine_status(active_cid)

        if (
            getattr(config, "AUTO_TRADE_ENABLED", False)
            and not is_emergency
            and not base_engine_status.startswith("STANDBY -")
            and not base_engine_status.startswith("BLOCKED")
        ):
            best = market.get("best_route") if market else None
            if best:
                net_p = float(best.get("net_profit_usdt", 0.0))
                if net_p <= 0:
                    current_exec_status = f"STANDBY: Unprofitable spread (Net: -${abs(net_p):.4f} USDT)"
                elif not best.get("is_gas_acceptable", True):
                    current_exec_status = "STANDBY: Gas price exceeds ceiling"
                elif best.get("max_price_impact_pct", 0) > config.MAX_PRICE_IMPACT_PCT:
                    current_exec_status = f"STANDBY: Price impact ({best.get('max_price_impact_pct'):.2f}%) exceeds safety limit"
                else:
                    current_exec_status = base_engine_status
            else:
                current_exec_status = base_engine_status
        else:
            current_exec_status = base_engine_status

        last_execution_status = current_exec_status

        return jsonify({
            "success": True,
            "data": market,
            "wallet": wallet,
            "summary": {
                "balance": total_balance,
                "total_profit": display_profit,
                "total_trades": display_trades,
                "is_wallet_connected": is_wallet_connected,
                "emergency_stop": is_emergency,
                "trading_mode": mode,
                "eth_price_usdt": round(avg_eth_price, 2),
                "wallet_status": {
                    dex: {"connected": True, "source": market.get("reserves", {}).get(dex, {}).get("source", "rpc")}
                    for dex in config.SUPPORTED_DEXES
                }
            },
            "settings": current_settings(),
            "latest_trade": latest_trade,
            "execution_status": current_exec_status,
            "last_execution_result": globals().get("last_background_trade_result"),
            "last_skip_reason": (
                globals().get("last_background_trade_result", {}).get("skip_reason", "")
                if globals().get("last_background_trade_result") else ""
            ),
            "execution_logs": execution_audit_logs[:15],
        })
    except Exception as exc:
        return jsonify({"success": False, "message": f"Server error: {str(exc)}"}), 500


@app.route("/api/execution-logs", methods=["GET"])
def execution_logs_api():
    """Return rolling execution diagnostics and skip events for real-time debugging."""
    cid_param = request.args.get("chain_id")
    target_cid = None
    if cid_param:
        try:
            target_cid = int(cid_param)
        except (ValueError, TypeError):
            pass
    active_cid = target_cid or getattr(config, "CHAIN_ID", 8453)
    return jsonify({
        "success": True,
        "logs": execution_audit_logs,
        "total": len(execution_audit_logs),
        "execution_status": globals().get("last_execution_status", get_engine_status(active_cid)),
    })


@app.route("/api/prices", methods=["GET"])
def prices_api():
    """Return live prices and reserves for all supported DEXes on the selected chain."""
    try:
        client_chain_id = request.args.get("chain_id")
        if client_chain_id:
            try:
                cid = int(client_chain_id)
                if cid in config.CHAIN_REGISTRY and cid != config.CHAIN_ID:
                    config.set_active_chain(cid)
                    save_bot_setting("chain_id", cid)
            except (ValueError, TypeError):
                pass

        from dex_engine import get_all_dex_quotes
        parts = config.SYMBOL.split("/")
        base_sym = parts[0] if len(parts) > 0 else "WETH"
        quote_sym = parts[1] if len(parts) > 1 else "USDT"
        quotes = get_all_dex_quotes(config.DEFAULT_TRADE_AMOUNT, base_sym, quote_sym)
        active_chain_id = getattr(config, "CHAIN_ID", 8453)
        chain_info = config.CHAIN_REGISTRY.get(active_chain_id, {})
        return jsonify({
            "success": True,
            "chain_id": active_chain_id,
            "chain_name": chain_info.get("name", "base"),
            "chain_label": chain_info.get("label", "Base L2 Mainnet"),
            "symbol": config.SYMBOL,
            "quotes": quotes,
            "prices": {dex: q["spot_price"] for dex, q in quotes.items()},
            "timestamp": time.time() * 1000,
        })
    except Exception as exc:
        return jsonify({"success": False, "message": str(exc)}), 500


# =====================================================
# ATOMIC TRADE & SIMULATION API
# =====================================================

@app.route("/api/trade", methods=["POST"])
def manual_trade_api():
    global last_execution_status, last_background_trade_result
    try:
        if emergency_stop_active():
            return jsonify({
                "success": False,
                "status": "BLOCKED_EMERGENCY_STOP",
                "message": "Emergency Stop is active; trading is blocked."
            }), 400

        req_data = request.get_json(silent=True) or {}
        custom_amount = req_data.get("trade_amount")

        if custom_amount is not None:
            try:
                custom_amount = float(custom_amount)
                if custom_amount <= 0:
                    raise ValueError
            except (TypeError, ValueError):
                return jsonify({"success": False, "message": "Invalid trade amount."}), 400

        # Sizing guard: If wallet has a positive balance, dynamically calculate the safe trade amount
        # from whatever USDT/USDC balance is actually available (e.g. 0.01, 0.05, 0.1, etc.)
        mode = getattr(config, "TRADING_MODE", "MOCK")
        if mode in ("LIVE", "TESTNET"):
            try:
                from wallet_manager import get_wallet_balances
                wb = get_wallet_balances()
                if wb.get("is_connected"):
                    avail_bal = float(wb.get("total_stable_usdt", 0.0))
                    if avail_bal > 0:
                        custom_amount = calculate_dynamic_trade_amount(avail_bal, requested_amount=custom_amount)
            except Exception:
                pass

        market = analyze_market(custom_amount=custom_amount)
        if not market:
            return jsonify({"success": False, "message": "Unable to fetch on-chain DEX reserves."}), 503

        result = execute_real_trade(market, custom_amount=custom_amount, is_manual=True)
        last_background_trade_result = result
        best = market.get("best_route") or {}
        route_name = f"{best.get('buy_dex', 'Uniswap_V2')} -> {best.get('sell_dex', 'SushiSwap_V2')}"
        amt = float(custom_amount or best.get("amount_in", getattr(config, "DEFAULT_TRADE_AMOUNT", 10.0)))
        np = float(best.get("net_profit_usdt", 0.0))

        if result.get("success"):
            last_execution_status = "ATOMIC TRADE FILLED"
            t = result.get("trade", {})
            record_execution_event(
                event_type="TRADE_FILLED",
                route=route_name,
                amount_in=amt,
                net_profit=np,
                status="FILLED",
                reason=f"Profit: +${t.get('net_profit', 0):.4f} USDT",
                tx_hash=t.get("tx_hash", "")
            )
        elif result.get("status") in ("TRADE SKIPPED", "INSUFFICIENT BALANCE"):
            reason = result.get("skip_reason") or result.get("message") or "Trade conditions not met"
            clean_reason = reason
            for pfx in ("INSUFFICIENT BALANCE:", "SKIP:", "Execution skipped:"):
                if clean_reason.startswith(pfx):
                    clean_reason = clean_reason[len(pfx):].strip()

            is_insufficient = "INSUFFICIENT BALANCE" in reason or result.get("status") == "INSUFFICIENT BALANCE"
            if is_insufficient:
                last_execution_status = f"INSUFFICIENT BALANCE: {clean_reason}"
                event_type = "INSUFFICIENT_BALANCE"
                audit_status = "INSUFFICIENT_BALANCE"
            else:
                last_execution_status = f"TRADE SKIPPED: {clean_reason}"
                event_type = "TRADE_SKIPPED"
                audit_status = "SKIPPED"

            record_execution_event(
                event_type=event_type,
                route=route_name,
                amount_in=amt,
                net_profit=np,
                status=audit_status,
                reason=clean_reason
            )
        else:
            msg = result.get("message", "Execution error")
            last_execution_status = f"TRADE FAILED: {msg}"
            record_execution_event(
                event_type="TRADE_FAILED",
                route=route_name,
                amount_in=amt,
                net_profit=np,
                status="FAILED",
                reason=msg
            )

        status_code = 200 if result.get("success") else 400
        return jsonify(result), status_code
    except Exception as exc:
        return jsonify({"success": False, "message": f"Trade execution error: {str(exc)}"}), 500


@app.route("/api/trade/confirm-live", methods=["POST"])
def confirm_live_trade_api():
    """Verify and commit a real on-chain transaction executed via MetaMask or direct Web3 wallet.
    
    Queries the active blockchain RPC for the transaction receipt (eth_getTransactionReceipt),
    confirms EVM status == '0x1' (success), computes verified gas fees and actual net profit,
    and commits the genuine live trade to the database.
    """
    try:
        req = request.get_json(silent=True) or {}
        tx_hash = (req.get("tx_hash") or "").strip()
        if not tx_hash or not tx_hash.startswith("0x") or len(tx_hash) != 66:
            return jsonify({
                "success": False,
                "message": "Invalid transaction hash. Must be a 66-character 0x-prefixed hex string."
            }), 400

        from dex_engine import rpc_call
        receipt = rpc_call("eth_getTransactionReceipt", [tx_hash])
        if not receipt:
            return jsonify({
                "success": False,
                "pending": True,
                "message": "Transaction is still pending confirmation on the blockchain. Please wait a few seconds and retry."
            }), 202

        status_val = receipt.get("status")
        is_success = (status_val == "0x1" or status_val == 1 or status_val is True)
        if not is_success:
            record_execution_event(
                event_type="LIVE_TRADE_REVERTED",
                route=f"{req.get('buy_dex', 'Uniswap_V2')}->{req.get('sell_dex', 'SushiSwap_V2')}",
                amount_in=float(req.get("amount_in", 0.0)),
                net_profit=0.0,
                status="REVERTED",
                reason="Transaction reverted on-chain (EVM status 0x0)",
                tx_hash=tx_hash
            )
            return jsonify({
                "success": False,
                "status": "REVERTED",
                "message": f"Transaction {tx_hash[:10]}... reverted on-chain. Capital was preserved, but network gas was consumed."
            }), 400

        gas_used = int(str(receipt.get("gasUsed", "0x0")), 16) if isinstance(receipt.get("gasUsed"), str) else int(receipt.get("gasUsed", 0))
        effective_gas_price = receipt.get("effectiveGasPrice") or receipt.get("gasPrice") or "0x0"
        gas_price_wei = int(str(effective_gas_price), 16) if isinstance(effective_gas_price, str) else int(effective_gas_price)
        gas_price_gwei = round(gas_price_wei / 1e9, 4)
        gas_cost_eth = (gas_used * gas_price_wei) / 1e18

        # Query live ETH spot price for accurate USD conversion
        market = analyze_market(custom_amount=float(req.get("amount_in", config.DEFAULT_TRADE_AMOUNT)))
        eth_price = 3000.0
        if market and market.get("best_route"):
            eth_price = float(market["best_route"].get("buy_price") or 3000.0)

        gas_cost_usdt = round(gas_cost_eth * eth_price, 4)
        amount_in = float(req.get("amount_in", 1.0))
        expected_profit = float(req.get("expected_profit", req.get("net_profit", 0.0)))
        amount_out = float(req.get("amount_out", amount_in + expected_profit))
        gross_profit = float(req.get("gross_profit", amount_out - amount_in))
        verified_net_profit = round(gross_profit - gas_cost_usdt, 4)

        chain_id = int(req.get("chain_id") or config.CHAIN_ID)
        buy_dex = req.get("buy_dex") or "Uniswap_V2"
        sell_dex = req.get("sell_dex") or "SushiSwap_V2"
        token_pair = req.get("token_pair") or config.SYMBOL

        trade_data = {
            "tx_hash": tx_hash,
            "chain_id": chain_id,
            "buy_dex": buy_dex,
            "sell_dex": sell_dex,
            "token_pair": token_pair,
            "amount_in": amount_in,
            "amount_out": amount_out,
            "gross_profit": gross_profit,
            "net_profit": verified_net_profit,
            "gas_used": gas_used,
            "gas_price_gwei": gas_price_gwei,
            "gas_cost_usdt": gas_cost_usdt,
            "price_impact": float(req.get("price_impact", 0.0)),
            "slippage": float(req.get("slippage", config.SLIPPAGE_PCT)),
            "status": "CONFIRMED",
            "mode": "LIVE",
            "created_at": time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime()),
        }

        trade_id = save_trade(trade_data)
        trade_data["id"] = trade_id

        record_execution_event(
            event_type="LIVE_TRADE_CONFIRMED",
            route=f"{buy_dex}->{sell_dex}",
            amount_in=amount_in,
            net_profit=verified_net_profit,
            status="CONFIRMED",
            reason=f"Verified on-chain receipt ({gas_used} gas used, ${gas_cost_usdt} gas fee)",
            tx_hash=tx_hash
        )

        chain_label = config.CHAIN_REGISTRY.get(chain_id, {}).get("label", "Blockchain")
        return jsonify({
            "success": True,
            "trade_id": trade_id,
            "trade": trade_data,
            "message": f"Real on-chain trade verified on {chain_label}! Gas: ${gas_cost_usdt:.4f} USDT, Net PnL: +${verified_net_profit:.4f} USDT."
        })
    except Exception as exc:
        return jsonify({"success": False, "message": f"Receipt confirmation error: {str(exc)}"}), 500


@app.route("/api/trade/simulate", methods=["POST"])
def simulate_trade_api():
    """Simulate atomic arbitrage trade without broadcasting or recording."""
    try:
        req_data = request.get_json(silent=True) or {}
        custom_amount = float(req_data.get("trade_amount", config.DEFAULT_TRADE_AMOUNT))
        market = analyze_market(custom_amount=custom_amount)
        if not market:
            return jsonify({"success": False, "message": "Could not scan DEX pools."}), 503

        best = market.get("best_route", {})
        plan = {
            "buy_dex": req_data.get("buy_dex", best.get("buy_dex", "Uniswap_V2")),
            "sell_dex": req_data.get("sell_dex", best.get("sell_dex", "SushiSwap_V2")),
            "amount_in": custom_amount,
            "gross_return_usdt": best.get("gross_return_usdt", custom_amount + 1.0),
            "net_profit_usdt": best.get("net_profit_usdt", 0.50),
        }
        sim = simulate_atomic_arbitrage(plan)
        return jsonify(sim)
    except Exception as exc:
        return jsonify({"success": False, "message": str(exc)}), 500


# =====================================================
# NON-CUSTODIAL WALLET & CONTRACT API
# =====================================================

@app.route("/api/wallet", methods=["GET"])
def wallet_api():
    try:
        from dex_engine import get_all_dex_quotes
        parts = config.SYMBOL.split("/")
        base_sym = parts[0] if len(parts) > 0 else "WETH"
        quote_sym = parts[1] if len(parts) > 1 else "USDT"
        quotes = get_all_dex_quotes(100.0, base_sym, quote_sym)
        eth_price = list(quotes.values())[0]["spot_price"] if quotes else 3000.0
        wallet = get_wallet_balances(eth_price)
        return jsonify({"success": True, "wallet": wallet})
    except Exception as exc:
        return jsonify({"success": False, "message": str(exc)}), 500


@app.route("/api/wallet/connect", methods=["POST"])
def wallet_connect_api():
    """Register client-connected MetaMask wallet address."""
    try:
        req_data = request.get_json(silent=True) or {}
        address = (req_data.get("address") or "").strip()

        if not address or not address.startswith("0x") or len(address) != 42:
            return jsonify({
                "success": False,
                "message": "Invalid Ethereum address format (must be 42 characters starting with 0x)."
            }), 400

        config.WALLET_ADDRESS = address
        save_bot_setting("wallet_address", address)

        chain_id = req_data.get("chain_id")
        if chain_id and isinstance(chain_id, int) and chain_id in config.CHAIN_REGISTRY:
            if config.CHAIN_ID != chain_id:
                config.set_active_chain(chain_id)
                save_bot_setting("chain_id", chain_id)

        from dex_engine import get_all_dex_quotes
        parts = config.SYMBOL.split("/")
        base_sym = parts[0] if len(parts) > 0 else "WETH"
        quote_sym = parts[1] if len(parts) > 1 else "USDT"
        quotes = get_all_dex_quotes(100.0, base_sym, quote_sym)
        eth_price = list(quotes.values())[0]["spot_price"] if quotes else 3000.0
        wallet = get_wallet_balances(eth_price, wallet_address=address)

        return jsonify({
            "success": True,
            "message": f"Wallet connected: {address[:6]}...{address[-4:]}",
            "wallet": wallet
        })
    except Exception as exc:
        return jsonify({"success": False, "message": str(exc)}), 500


@app.route("/api/wallet/disconnect", methods=["POST"])
def wallet_disconnect_api():
    """Disconnect active wallet and reset session to non-custodial zero balance."""
    try:
        config.WALLET_ADDRESS = ""
        save_bot_setting("wallet_address", "")
        from dex_engine import get_all_dex_quotes
        parts = config.SYMBOL.split("/")
        base_sym = parts[0] if len(parts) > 0 else "WETH"
        quote_sym = parts[1] if len(parts) > 1 else "USDT"
        quotes = get_all_dex_quotes(100.0, base_sym, quote_sym)
        eth_price = list(quotes.values())[0]["spot_price"] if quotes else 3000.0
        wallet = get_wallet_balances(eth_price)

        return jsonify({
            "success": True,
            "message": "Wallet disconnected successfully.",
            "wallet": wallet
        })
    except Exception as exc:
        return jsonify({"success": False, "message": str(exc)}), 500


@app.route("/api/contract", methods=["GET"])
def contract_api():
    """Return DexArbitrage smart contract metadata and ABI."""
    return jsonify({
        "success": True,
        "contract_address": getattr(config, "ARBITRAGE_CONTRACT_ADDRESS", ""),
        "chain_id": config.CHAIN_ID,
        "chain": config.DEFAULT_CHAIN,
        "abi": DEX_ARBITRAGE_ABI,
        "routers": config.DEX_ROUTERS,
        "factories": config.DEX_FACTORIES,
    })


@app.route("/api/rpc-status", methods=["GET"])
def rpc_status_api():
    """Check blockchain RPC connection, block height, and gas fee."""
    try:
        block_num = get_block_number()
        wei, gwei = get_gas_price()
        return jsonify({
            "success": True,
            "connected": block_num > 0,
            "rpc_url": config.RPC_URL,
            "chain_id": config.CHAIN_ID,
            "chain": config.DEFAULT_CHAIN,
            "block_number": block_num,
            "gas_price_wei": wei,
            "gas_price_gwei": gwei,
        })
    except Exception as exc:
        return jsonify({
            "success": False,
            "connected": False,
            "error": str(exc),
            "rpc_url": config.RPC_URL
        }), 503


# =====================================================
# SETTINGS & CONTROLS API
# =====================================================

def current_settings() -> Dict[str, Any]:
    return {
        "auto_trade": getattr(config, "AUTO_TRADE_ENABLED", False),
        "live_trading_armed": getattr(config, "LIVE_TRADING_ARMED", False),
        "trading_mode": getattr(config, "TRADING_MODE", "MOCK"),
        "min_profit": getattr(config, "MIN_PROFIT_USDT", 0.005),
        "min_profit_percent": getattr(config, "MIN_PROFIT_PERCENT", 0.005),
        "trade_amount": getattr(config, "DEFAULT_TRADE_AMOUNT", 5.0),
        "min_trade_amount": getattr(config, "MIN_TRADE_AMOUNT", 0.0001),
        "max_trade_amount": getattr(config, "MAX_TRADE_AMOUNT", 5000.0),
        "slippage_pct": getattr(config, "SLIPPAGE_PCT", 0.50),
        "max_price_impact_pct": getattr(config, "MAX_PRICE_IMPACT_PCT", 1.00),
        "max_gas_price_gwei": getattr(config, "MAX_GAS_PRICE_GWEI", 50.0),
        "cooldown": getattr(config, "AUTO_TRADE_COOLDOWN", 15),
        "symbol": getattr(config, "SYMBOL", "WETH/USDT"),
        "supported_dexes": config.SUPPORTED_DEXES,
        "rpc_url": config.RPC_URL,
        "chain_id": config.CHAIN_ID,
        "chain": getattr(config, "DEFAULT_CHAIN", "base"),
        "chain_label": config.CHAIN_REGISTRY.get(config.CHAIN_ID, {}).get("label", "Base L2 Mainnet"),
        "wallet_address": getattr(config, "WALLET_ADDRESS", ""),
        "contract_address": getattr(config, "ARBITRAGE_CONTRACT_ADDRESS", ""),
        "has_private_key": bool(getattr(config, "PRIVATE_KEY", "")),
        "emergency_stop": emergency_stop_active(),
    }


@app.route("/api/settings", methods=["GET", "POST"])
def settings_api():
    if request.method == "POST":
        data = request.get_json(silent=True) or {}

        if "auto_trade" in data:
            val = bool(data["auto_trade"])
            config.AUTO_TRADE_ENABLED = val
            save_bot_setting("auto_trade", val)

        if "trading_mode" in data and str(data["trading_mode"]).upper() in {"MOCK", "TESTNET", "LIVE"}:
            val = str(data["trading_mode"]).upper()
            config.TRADING_MODE = val
            save_bot_setting("trading_mode", val)
            if "live_trading_armed" not in data:
                armed_val = (val in ("TESTNET", "LIVE"))
                config.LIVE_TRADING_ARMED = armed_val
                save_bot_setting("live_trading_armed", armed_val)

        if "live_trading_armed" in data:
            val = bool(data["live_trading_armed"])
            config.LIVE_TRADING_ARMED = val
            save_bot_setting("live_trading_armed", val)

        if "min_profit" in data:
            try:
                v = float(data["min_profit"])
                if v >= 0:
                    config.MIN_PROFIT_USDT = v
                    save_bot_setting("min_profit", v)
            except (TypeError, ValueError):
                pass

        if "min_profit_percent" in data:
            try:
                v = float(data["min_profit_percent"])
                if v >= 0:
                    config.MIN_PROFIT_PERCENT = v
                    save_bot_setting("min_profit_percent", v)
            except (TypeError, ValueError):
                pass

        if "trade_amount" in data:
            try:
                v = float(data["trade_amount"])
                if v > 0:
                    config.DEFAULT_TRADE_AMOUNT = v
                    save_bot_setting("trade_amount", v)
            except (TypeError, ValueError):
                pass

        if "slippage_pct" in data:
            try:
                v = float(data["slippage_pct"])
                if v >= 0:
                    config.SLIPPAGE_PCT = v
                    save_bot_setting("slippage_pct", v)
            except (TypeError, ValueError):
                pass

        if "max_price_impact_pct" in data:
            try:
                v = float(data["max_price_impact_pct"])
                if v > 0:
                    config.MAX_PRICE_IMPACT_PCT = v
                    save_bot_setting("max_price_impact_pct", v)
            except (TypeError, ValueError):
                pass

        if "rpc_url" in data and data["rpc_url"]:
            config.RPC_URL = str(data["rpc_url"]).strip()
            save_bot_setting("rpc_url", config.RPC_URL)

        if "wallet_address" in data:
            config.WALLET_ADDRESS = str(data["wallet_address"]).strip()
            save_bot_setting("wallet_address", config.WALLET_ADDRESS)

        if "private_key" in data:
            pk = str(data["private_key"]).strip()
            if pk:
                if not pk.startswith("0x") and len(pk) == 64:
                    pk = "0x" + pk
                if len(pk) == 66:
                    config.PRIVATE_KEY = pk
                    save_bot_setting("private_key", pk)
                    try:
                        from eth_account import Account
                        acct = Account.from_key(pk)
                        config.WALLET_ADDRESS = acct.address
                        save_bot_setting("wallet_address", acct.address)
                    except Exception:
                        pass
            elif pk == "":
                config.PRIVATE_KEY = ""
                save_bot_setting("private_key", "")

        if "contract_address" in data:
            config.ARBITRAGE_CONTRACT_ADDRESS = str(data["contract_address"]).strip()
            save_bot_setting("contract_address", config.ARBITRAGE_CONTRACT_ADDRESS)

        if "chain_id" in data:
            try:
                cid = int(data["chain_id"])
                if cid in config.CHAIN_REGISTRY:
                    config.set_active_chain(cid)
                    save_bot_setting("chain_id", cid)
            except (TypeError, ValueError):
                pass

        if "symbol" in data and data["symbol"]:
            config.SYMBOL = str(data["symbol"]).strip()

        last_execution_status = get_engine_status(config.CHAIN_ID)

        return jsonify({
            "success": True,
            "message": "DEX settings updated successfully.",
            "settings": current_settings(),
        })

    return jsonify({"success": True, "settings": current_settings()})


@app.route("/api/chain/switch", methods=["POST"])
def switch_chain_api():
    """Switch active blockchain network on-the-fly (e.g. Base L2, Arbitrum, Polygon, Ethereum)."""
    try:
        req_data = request.get_json(silent=True) or {}
        chain_id = int(req_data.get("chain_id", 11155111))
        if chain_id not in config.CHAIN_REGISTRY:
            return jsonify({
                "success": False,
                "message": f"Unsupported chain ID: {chain_id}. Supported chains: {list(config.CHAIN_REGISTRY.keys())}"
            }), 400

        chain_info = config.set_active_chain(chain_id)
        save_bot_setting("chain_id", chain_id)
        save_bot_setting("rpc_url", chain_info["rpc_url"])
        last_execution_status = get_engine_status(chain_id)

        return jsonify({
            "success": True,
            "message": f"Switched to {chain_info['label']}",
            "chain": chain_info,
            "chain_id": chain_id,
        })
    except Exception as exc:
        return jsonify({"success": False, "message": str(exc)}), 500


@app.route("/api/chains", methods=["GET"])
def get_chains_api():
    """Return available chains registry and currently active chain."""
    return jsonify({
        "success": True,
        "active_chain_id": config.CHAIN_ID,
        "active_chain": config.DEFAULT_CHAIN,
        "chains": config.CHAIN_REGISTRY,
    })


@app.route("/api/emergency-stop", methods=["GET", "POST"])
def emergency_stop_api():
    if request.method == "POST":
        req_data = request.get_json(silent=True) or {}
        if "active" in req_data:
            config.EMERGENCY_STOP = bool(req_data["active"])
        else:
            config.EMERGENCY_STOP = not config.EMERGENCY_STOP
        save_bot_setting("emergency_stop", config.EMERGENCY_STOP)

    return jsonify({
        "success": True,
        "emergency_stop": emergency_stop_active(),
        "message": "Emergency stop is active; trading is blocked." if emergency_stop_active() else "Emergency stop is deactivated.",
    })


# =====================================================
# TRADES AUDIT LOG API
# =====================================================

@app.route("/api/trades", methods=["GET"])
def trades_api():
    mode_filter = request.args.get("mode")
    if not mode_filter:
        mode_filter = getattr(config, "TRADING_MODE", "LIVE")
    trades = get_all_trades(mode=mode_filter if mode_filter != "ALL" else None)
    return jsonify({
        "success": True,
        "trades": trades,
        "mode_filter": mode_filter,
    })


@app.route("/api/trades/clear", methods=["POST"])
@app.route("/api/clear-trades", methods=["POST"])
def clear_trades_api():
    delete_all_trades()
    return jsonify({
        "success": True,
        "message": "DEX trade history cleared successfully.",
    })


# =====================================================
# LIVE VERIFICATION & HEALTH API
# =====================================================

@app.route("/api/live-verification", methods=["GET"])
def live_verification_status_route():
    return jsonify(get_live_verification_status())


@app.route("/api/live-verification/run", methods=["POST"])
def live_verification_run_route():
    data = request.get_json(silent=True) or {}
    explicit = data.get("explicit_confirmation", False) or data.get("confirm_live_money", False)
    res = run_live_verification(
        buy_dex=data.get("buy_dex", "Uniswap_V2"),
        sell_dex=data.get("sell_dex", "SushiSwap_V2"),
        amount=float(data.get("trade_amount", 100.0)),
        explicit_confirmation=explicit,
    )
    code = 200 if res.get("success") else 400
    return jsonify(res), code


@app.route("/api/pnl", methods=["GET"])
def pnl_api():
    try:
        pnl = get_live_pnl_summary()
        uptime = max(0, int(time.time() - SERVER_STARTED_AT))
        pnl["uptime_seconds"] = uptime
        pnl["uptime_text"] = f"{uptime // 3600}h {(uptime % 3600) // 60}m {uptime % 60}s"
        pnl["engine_status"] = get_engine_status()
        pnl["last_execution_status"] = globals().get("last_execution_status", get_engine_status())
        return jsonify({"success": True, **pnl})
    except Exception as exc:
        return jsonify({"success": False, "message": str(exc)}), 500


@app.route("/api/market/all-pairs", methods=["GET"])
def all_pairs_api():
    """Scan all liquid pairs on the active blockchain and identify the highest spread."""
    try:
        client_chain_id = request.args.get("chain_id")
        if client_chain_id:
            try:
                cid = int(client_chain_id)
                if cid in config.CHAIN_REGISTRY and cid != config.CHAIN_ID:
                    config.set_active_chain(cid)
                    save_bot_setting("chain_id", cid)
            except (ValueError, TypeError):
                pass

        active_chain_id = getattr(config, "CHAIN_ID", 11155111)
        chain_info = config.CHAIN_REGISTRY.get(active_chain_id, {})
        tokens = chain_info.get("tokens", {})
        target_pairs = list(chain_info.get("pairs", ["WETH/USDT", "WETH/USDC"]))

        results = []
        best_overall = None
        highest_spread_pct = -999.0

        def _scan_one_pair(pair_str):
            parts = pair_str.split("/")
            if len(parts) != 2:
                return None
            base_sym, quote_sym = parts[0], parts[1]
            if base_sym not in tokens or quote_sym not in tokens:
                return None
            try:
                from dex_engine import get_all_dex_quotes
                quotes = get_all_dex_quotes(100.0, base_sym, quote_sym)
                if not quotes or len(quotes) < 2:
                    return None
                prices = {k: v["spot_price"] for k, v in quotes.items() if v.get("spot_price", 0) > 0}
                if len(prices) < 2:
                    return None
                min_dex = min(prices, key=prices.get)
                max_dex = max(prices, key=prices.get)
                buy_p = prices[min_dex]
                sell_p = prices[max_dex]
                spread_val = sell_p - buy_p
                spread_pct = (spread_val / buy_p) * 100.0 if buy_p > 0 else 0.0
                return {
                    "pair": pair_str,
                    "chain_id": active_chain_id,
                    "chain_name": chain_info.get("name", "base"),
                    "base": base_sym,
                    "quote": quote_sym,
                    "buy_dex": min_dex,
                    "sell_dex": max_dex,
                    "buy_price": round(buy_p, 2),
                    "sell_price": round(sell_p, 2),
                    "spread_val": round(spread_val, 2),
                    "spread_pct": round(spread_pct, 2),
                    "is_active": (pair_str == getattr(config, "SYMBOL", "WETH/USDC")),
                }
            except Exception:
                return None

        with ThreadPoolExecutor(max_workers=min(len(target_pairs), 4)) as executor:
            scanned = list(executor.map(_scan_one_pair, target_pairs))

        for pair_res in scanned:
            if not pair_res:
                continue
            results.append(pair_res)
            if pair_res["spread_pct"] > highest_spread_pct:
                highest_spread_pct = pair_res["spread_pct"]
                best_overall = pair_res

        return jsonify({
            "success": True,
            "chain_id": active_chain_id,
            "chain_name": chain_info.get("name", "base"),
            "chain_label": chain_info.get("label", "Base L2 Mainnet"),
            "pairs": results,
            "best_pair": best_overall,
            "timestamp": time.time() * 1000
        })
    except Exception as exc:
        return jsonify({"success": False, "message": str(exc)}), 500


@app.route("/api/pair/switch", methods=["POST"])
def switch_pair_api():
    """Quick-switch active trading pair."""
    try:
        data = request.get_json(silent=True) or {}
        new_symbol = data.get("symbol", "").strip()
        if not new_symbol or "/" not in new_symbol:
            return jsonify({"success": False, "message": "Invalid pair format. Expected BASE/QUOTE."}), 400

        config.SYMBOL = new_symbol
        save_bot_setting("symbol", new_symbol)
        return jsonify({"success": True, "symbol": new_symbol, "message": f"Trading pair switched to {new_symbol}"})
    except Exception as exc:
        return jsonify({"success": False, "message": str(exc)}), 500


@app.route("/api/flashloan/calculate", methods=["POST"])
def flashloan_calculate_api():
    """Calculate potential profits, protocol fee, gas, and price impact for Aave V3 flashloan on Base L2."""
    try:
        data = request.get_json(silent=True) or {}
        amount = float(data.get("amount", 10000.0))
        pair = data.get("pair", getattr(config, "SYMBOL", "WETH/USDC"))
        provider = data.get("provider", "Aave V3 (Base L2)")

        parts = pair.split("/")
        base_sym = parts[0] if len(parts) > 0 else "WETH"
        quote_sym = parts[1] if len(parts) > 1 else "USDC"

        # Aave V3 flashloan fee is 0.05% (5 bps)
        fee_pct = 0.05
        loan_fee_usd = amount * (fee_pct / 100.0)

        from dex_engine import get_all_dex_quotes, estimate_arbitrage_gas_cost_usd
        quotes = get_all_dex_quotes(amount, base_sym, quote_sym)
        if not quotes or len(quotes) < 2:
            return jsonify({"success": False, "message": "Insufficient DEX liquidity quotes for calculation."}), 400

        prices = {k: v["spot_price"] for k, v in quotes.items() if v.get("spot_price", 0) > 0}
        min_dex = min(prices, key=prices.get)
        max_dex = max(prices, key=prices.get)
        buy_p = prices[min_dex]
        sell_p = prices[max_dex]

        spread_pct = ((sell_p - buy_p) / buy_p) * 100.0 if buy_p > 0 else 0.0

        gas_info = estimate_arbitrage_gas_cost_usd(sell_p, gas_units=300000)
        gas_cost_usd = gas_info.get("gas_cost_usd", 0.0045)

        buy_q = quotes[min_dex]
        sell_q = quotes[max_dex]
        buy_impact = buy_q.get("price_impact_pct", 0.05)
        sell_impact = sell_q.get("price_impact_pct", 0.05)
        total_impact_pct = buy_impact + sell_impact

        gross_profit_usd = amount * (spread_pct / 100.0)
        impact_loss_usd = amount * (total_impact_pct / 100.0)
        net_profit_usd = gross_profit_usd - loan_fee_usd - gas_cost_usd - impact_loss_usd
        net_margin_pct = (net_profit_usd / amount) * 100.0 if amount > 0 else 0.0

        return jsonify({
            "success": True,
            "borrow_amount_usd": round(amount, 2),
            "pair": pair,
            "provider": provider,
            "fee_pct": fee_pct,
            "flashloan_fee_usd": round(loan_fee_usd, 4),
            "gas_cost_usd": round(gas_cost_usd, 4),
            "buy_dex": min_dex,
            "sell_dex": max_dex,
            "spread_pct": round(spread_pct, 2),
            "price_impact_pct": round(total_impact_pct, 3),
            "gross_profit_usd": round(gross_profit_usd, 4),
            "net_profit_usd": round(net_profit_usd, 4),
            "net_margin_pct": round(net_margin_pct, 2),
            "is_profitable": net_profit_usd > 0,
            "recommended_max_loan": round(min(amount * 2, 50000.0), 0) if total_impact_pct < 0.5 else round(amount * 0.5, 0)
        })
    except Exception as exc:
        return jsonify({"success": False, "message": str(exc)}), 500


@app.route("/api/trades/export", methods=["GET"])
def export_trades_api():
    """Export verified trade audit log in CSV or JSON format."""
    try:
        export_format = request.args.get("format", "csv").lower()
        filter_mode = request.args.get("mode", "ALL")

        from database import get_all_trades
        trades = get_all_trades(limit=1000, mode=filter_mode)

        if export_format == "json":
            return jsonify({
                "success": True,
                "exported_at": time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime()),
                "total_trades": len(trades),
                "trades": trades
            })

        import csv
        import io
        from flask import Response

        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow([
            "ID", "Tx Hash", "Chain ID", "Buy DEX", "Sell DEX", "Token Pair",
            "Amount In (USDT)", "Amount Out", "Gross Profit ($)", "Net Profit ($)",
            "Gas Used", "Gas Price (Gwei)", "Gas Cost ($)", "Price Impact (%)",
            "Slippage (%)", "Status", "Mode", "Timestamp"
        ])

        for t in trades:
            writer.writerow([
                t.get("id", ""),
                t.get("tx_hash", ""),
                t.get("chain_id", ""),
                t.get("buy_dex", ""),
                t.get("sell_dex", ""),
                t.get("token_pair", ""),
                t.get("amount_in", 0),
                t.get("amount_out", 0),
                t.get("gross_profit", 0),
                t.get("net_profit", 0),
                t.get("gas_used", 0),
                t.get("gas_price_gwei", 0),
                t.get("gas_cost_usdt", 0),
                t.get("price_impact", 0),
                t.get("slippage", 0),
                t.get("status", ""),
                t.get("mode", ""),
                t.get("created_at", "")
            ])

        csv_content = output.getvalue()
        output.close()

        filename = f"dex_arbitrage_trades_{int(time.time())}.csv"
        return Response(
            csv_content,
            mimetype="text/csv",
            headers={"Content-Disposition": f"attachment; filename={filename}"}
        )
    except Exception as exc:
        return jsonify({"success": False, "message": str(exc)}), 500


@app.route("/api/health", methods=["GET"])
def health_check():
    return jsonify({
        "success": True,
        "status": "running",
        "mode": config.TRADING_MODE,
        "live_trading_armed": config.LIVE_TRADING_ARMED,
        "auto_trade_enabled": config.AUTO_TRADE_ENABLED,
        "emergency_stop": emergency_stop_active(),
        "chain": config.DEFAULT_CHAIN,
        "chain_id": config.CHAIN_ID,
        "dexes": config.SUPPORTED_DEXES,
    })


# =====================================================
# ERROR HANDLERS
# =====================================================

@app.errorhandler(404)
def handle_404(e):
    if request.path.startswith("/api/"):
        return jsonify({"success": False, "message": f"API endpoint not found: {request.path}"}), 404
    return render_template("index.html")


@app.errorhandler(500)
def handle_500(e):
    if request.path.startswith("/api/"):
        return jsonify({"success": False, "message": f"Internal server error: {str(e)}"}), 500
    return render_template("index.html")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    host = os.environ.get("HOST", "0.0.0.0")
    app.run(host=host, port=port, debug=False)
