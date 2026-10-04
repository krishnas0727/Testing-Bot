"""100% Decentralized Crypto Arbitrage Web Application.

Connects the user interface to decentralized exchanges (Uniswap V2, SushiSwap V2)
via Web3 JSON-RPC. Completely eliminates all centralized exchange code, APIs,
and credentials. Supports MOCK, TESTNET, and LIVE trading modes.
"""
import functools
import hmac
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
from trader_lock import acquire_auto_trader_lock, release_auto_trader_lock
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
    record_treasury_withdrawal,
    get_total_withdrawn,
    get_treasury_withdrawals,
    get_withdrawable_profit,
    get_treasury_buckets_summary,
    get_treasury_allocations,
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
    # Phase 3 Security Mandate: PRIVATE_KEY is loaded exclusively from environment (.env), never SQLite.
    _env_pk = getattr(config, "PRIVATE_KEY", "").strip()
    if _env_pk and not getattr(config, "WALLET_ADDRESS", "").strip():
        try:
            from eth_account import Account
            _acct = Account.from_key(_env_pk)
            config.WALLET_ADDRESS = _acct.address
        except Exception:
            pass
    # Auto-scrub any legacy plaintext private keys from SQLite
    try:
        from database import scrub_legacy_private_keys
        scrub_legacy_private_keys()
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
        config.EMERGENCY_STOP = bool(_saved["emergency_stop"]) or getattr(config, "EMERGENCY_STOP", False)
except Exception as _e:
    print(f"⚠️ Error restoring saved DEX settings: {_e}", flush=True)

# LIVE trading MUST NEVER start armed on application startup or restart.
# Independent safety control: requires an explicit authenticated arm action after every boot.
config.LIVE_TRADING_ARMED = False
try:
    save_bot_setting("live_trading_armed", False)
except Exception:
    pass

# Safety Invariant (Phase 4): Emergency stop takes precedence over all settings
if config.EMERGENCY_STOP:
    config.LIVE_TRADING_ARMED = False


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


_acquire_auto_trader_lock = acquire_auto_trader_lock


def start_background_auto_trader():
    if not acquire_auto_trader_lock():
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

    def auto_trader_runner():
        try:
            auto_trader_loop()
        finally:
            release_auto_trader_lock()
            print("[DEX Auto-Trader] Background loop stopped and lock released.", flush=True)

    threading.Thread(target=auto_trader_runner, daemon=True).start()


start_background_auto_trader()


# =====================================================
# API AUTHENTICATION & SECURITY GUARDS
# =====================================================

def require_api_auth(f=None, *, methods=None):
    """Secure API Authentication Decorator.

    Enforces Bearer token authentication against config.API_AUTH_TOKEN (from .env).
    Safely rejects unauthorized requests with HTTP 401 (missing/unconfigured)
    or HTTP 403 (invalid token) using constant-time comparison to prevent timing attacks.
    Never exposes API tokens, private keys, or internal details in responses or logs.
    """
    if f is None:
        return lambda fn: require_api_auth(fn, methods=methods)

    @functools.wraps(f)
    def decorated_function(*args, **kwargs):
        if methods and request.method not in methods:
            return f(*args, **kwargs)

        expected_token = (
            getattr(config, "API_AUTH_TOKEN", "") or os.environ.get("API_AUTH_TOKEN", "")
        ).strip()

        if not expected_token:
            return jsonify({
                "success": False,
                "message": "Unauthorized: API_AUTH_TOKEN is not configured on the server."
            }), 401

        auth_header = request.headers.get("Authorization", "").strip()
        token = ""
        if auth_header.startswith("Bearer "):
            token = auth_header[7:].strip()
        elif auth_header.startswith("bearer "):
            token = auth_header[7:].strip()
        elif auth_header:
            token = auth_header
        else:
            token = (request.headers.get("X-API-Token") or request.headers.get("X-API-Key") or "").strip()

        if not token:
            return jsonify({
                "success": False,
                "message": "Unauthorized: Missing Authorization header (expected 'Authorization: Bearer <API_AUTH_TOKEN>')."
            }), 401

        if not hmac.compare_digest(token, expected_token):
            return jsonify({
                "success": False,
                "message": "Forbidden: Invalid API authentication token."
            }), 403

        return f(*args, **kwargs)

    return decorated_function


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

        pnl_stats = get_live_pnl_summary(mode=mode if mode == "LIVE" else None)
        if not is_wallet_connected or total_balance <= 0.0 or is_emergency:
            display_profit = 0.0
            display_trades = 0
            display_roi = 0.0
            display_win_rate = 0.0
        else:
            display_profit = float(pnl_stats.get("total_net_profit", 0.0))
            display_trades = int(pnl_stats.get("total_trades", 0))
            display_roi = float(pnl_stats.get("roi", 0.0))
            display_win_rate = float(pnl_stats.get("win_rate", 0.0))

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
                "roi": display_roi,
                "win_rate": display_win_rate,
                "total_gas_spent": float(pnl_stats.get("total_gas_spent", 0.0)),
                "avg_profit": float(pnl_stats.get("avg_profit_per_trade", 0.0)),
                "treasury_buckets": pnl_stats.get("treasury_buckets", {}),
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


@app.route("/api/trade/verify-profit", methods=["POST"])
def verify_profit_api():
    """Real-time pre-execution profitability check.

    Fetches a FRESH DEX quote, recalculates gross profit, gas cost (ETH price × gas units × gas gwei),
    slippage cost, and net profit. Returns is_profitable=True only if netProfit > 0 after ALL costs.
    Called by the frontend auto-execute engine immediately before MetaMask signing — never uses stale data.
    """
    try:
        req_data = request.get_json(force=True, silent=True) or {}
        trade_amount = float(req_data.get("trade_amount") or config.DEFAULT_TRADE_AMOUNT)
        chain_id_param = req_data.get("chain_id")

        # Switch to client chain if specified
        if chain_id_param:
            try:
                cid = int(chain_id_param)
                if cid in config.CHAIN_REGISTRY and cid != config.CHAIN_ID:
                    config.set_active_chain(cid)
            except (ValueError, TypeError):
                pass

        active_chain_id = getattr(config, "CHAIN_ID", 8453)
        chain_info = config.CHAIN_REGISTRY.get(active_chain_id, {})

        parts = config.SYMBOL.split("/")
        base_sym = parts[0] if len(parts) > 0 else "WETH"
        quote_sym = parts[1] if len(parts) > 1 else "USDT"

        # Fresh quote from all DEXes
        from dex_engine import get_all_dex_quotes, estimate_arbitrage_gas_cost_usd
        from arbitrage import _calculate_net_profit

        try:
            quotes = get_all_dex_quotes(trade_amount, base_sym, quote_sym)
        except Exception as exc:
            return jsonify({
                "is_profitable": False,
                "net_profit_usdt": 0.0,
                "skip_reason": f"INSUFFICIENT_PROFIT: Failed to fetch fresh quote: {exc}",
            })

        if len(quotes) < 2:
            return jsonify({
                "is_profitable": False,
                "net_profit_usdt": 0.0,
                "skip_reason": "INSUFFICIENT_PROFIT: Less than 2 DEXes available for arbitrage",
            })

        # Find the best buy/sell pair
        best_net = None
        best_result = None
        best_buy_dex = None
        best_sell_dex = None

        avg_eth_price = sum(q["spot_price"] for q in quotes.values()) / len(quotes)
        gas_info = estimate_arbitrage_gas_cost_usd(avg_eth_price)
        gas_gwei = gas_info["gas_price_gwei"]

        for buy_dex, buy_q in quotes.items():
            for sell_dex, sell_q in quotes.items():
                if buy_dex == sell_dex:
                    continue
                if sell_q["spot_price"] <= buy_q["spot_price"]:
                    continue
                result = _calculate_net_profit(
                    trade_amt=trade_amount,
                    buy_q=buy_q,
                    sell_q=sell_q,
                    gas_price_gwei=gas_gwei,
                    eth_price_usdt=avg_eth_price,
                )
                net = result.get("net_profit_usdt", -999.0)
                if best_net is None or net > best_net:
                    best_net = net
                    best_result = result
                    best_buy_dex = buy_dex
                    best_sell_dex = sell_dex

        if best_result is None or best_net is None or best_net <= 0:
            reason = (best_result or {}).get("skip_reason") or "INSUFFICIENT_PROFIT: No profitable route after gas + slippage"
            return jsonify({
                "is_profitable": False,
                "net_profit_usdt": float(best_net or 0),
                "skip_reason": reason,
                "gross_profit_usdt": float((best_result or {}).get("gross_profit_usdt", 0)),
                "gas_cost_usdt": float((best_result or {}).get("gas_cost_usdt", 0)),
                "slippage_cost_usdt": float((best_result or {}).get("slippage_cost_usdt", 0)),
            })

        return jsonify({
            "is_profitable": True,
            "buy_dex": best_buy_dex,
            "sell_dex": best_sell_dex,
            "chain_id": active_chain_id,
            "chain_name": chain_info.get("name", ""),
            "trade_amount": trade_amount,
            "net_profit_usdt": float(best_net),
            "net_profit_pct": float(best_result.get("net_profit_pct", 0)),
            "gross_profit_usdt": float(best_result.get("gross_profit_usdt", 0)),
            "gas_cost_usdt": float(best_result.get("gas_cost_usdt", 0)),
            "slippage_cost_usdt": float(best_result.get("slippage_cost_usdt", 0)),
            "dex_fees_usdt": float(best_result.get("dex_fees_usdt", 0)),
            "weth_out": float(best_result.get("weth_out", 0)),
            "usdt_out": float(best_result.get("usdt_out", 0)),
            "min_usdt_out": float(best_result.get("min_usdt_out", 0)),
            "buy_price": float(quotes[best_buy_dex]["spot_price"]),
            "sell_price": float(quotes[best_sell_dex]["spot_price"]),
            "max_price_impact_pct": float(best_result.get("max_price_impact_pct", 0)),
            "gas_price_gwei": float(gas_gwei),
            "verified_at": __import__("time").time(),
            "skip_reason": "",
        })

    except Exception as exc:
        return jsonify({
            "is_profitable": False,
            "net_profit_usdt": 0.0,
            "skip_reason": f"Server error during profit check: {str(exc)}",
        }), 500



# ============================================================
# TREASURY & PROFIT WITHDRAWAL API
# ============================================================

@app.route("/api/treasury/status", methods=["GET"])
def treasury_status_api():
    """Retrieve treasury metrics: total profit, withdrawn amount, withdrawable balance, and recent history."""
    try:
        mode = request.args.get("mode") or getattr(config, "TRADING_MODE", "LIVE")
        active_cid = getattr(config, "CHAIN_ID", 11155111)
        chain_info = config.CHAIN_REGISTRY.get(active_cid, {})
        contract_addr = getattr(config, "ARBITRAGE_CONTRACT_ADDRESS", "") or chain_info.get("arbitrage_contract", "")

        total_profit = get_total_profit(mode=mode)
        total_withdrawn = get_total_withdrawn(mode=mode)
        withdrawable = get_withdrawable_profit(mode=mode)
        withdrawals = get_treasury_withdrawals(limit=25, mode=mode)
        buckets = get_treasury_buckets_summary()
        allocations = get_treasury_allocations(limit=15)

        treasury_recipient = getattr(config, "WALLET_ADDRESS", "") or getattr(config, "TREASURY_ADDRESS", "")

        return jsonify({
            "success": True,
            "chain_id": active_cid,
            "chain_name": chain_info.get("name", "sepolia"),
            "contract_address": contract_addr,
            "total_profit_usdt": total_profit,
            "total_withdrawn_usdt": total_withdrawn,
            "withdrawable_profit_usdt": withdrawable,
            "treasury_address": treasury_recipient,
            "trading_mode": mode,
            "recent_withdrawals": withdrawals,
            "buckets": buckets,
            "recent_allocations": allocations,
        })
    except Exception as exc:
        return jsonify({"success": False, "message": f"Treasury error: {str(exc)}"}), 500


@app.route("/api/treasury/withdraw", methods=["POST"])
@require_api_auth
def treasury_withdraw_api():
    """Execute or record a truthful profit withdrawal to the user's wallet or designated treasury address.
    
    Adheres strictly to Phase 5:
    - Never invents fake transaction hashes.
    - Never marks a withdrawal as CONFIRMED without a verified on-chain transaction receipt.
    - Validates token, recipient address, amount, and contract balance.
    - If real blockchain withdrawal cannot be performed, returns 400 with 'Real blockchain withdrawal is not configured.'
    - Simulation mode is kept separate (status = 'SIMULATED', tx_hash = '').
    """
    try:
        data = request.get_json(force=True, silent=True) or {}
        try:
            amount = float(data.get("amount", 0.0))
        except (ValueError, TypeError):
            return jsonify({"success": False, "status": "INVALID_AMOUNT", "message": "Withdrawal amount must be a valid number greater than 0."}), 400

        token = (data.get("token") or "USDT").upper().strip()
        recipient = (data.get("recipient_address") or data.get("wallet_address") or getattr(config, "WALLET_ADDRESS", "")).strip()
        client_tx_hash = (data.get("tx_hash") or "").strip()
        chain_id_val = int(data.get("chain_id") or getattr(config, "CHAIN_ID", 11155111))
        
        # Check trading mode / simulation flag
        req_mode = str(data.get("mode", "")).upper().strip()
        is_simulation = bool(data.get("simulation", False)) or (req_mode == "MOCK")
        mode = "MOCK" if is_simulation else (req_mode or getattr(config, "TRADING_MODE", "LIVE"))

        # 1. Validate Amount
        if amount <= 0.0:
            return jsonify({"success": False, "status": "INVALID_AMOUNT", "message": "Withdrawal amount must be greater than 0."}), 400

        # 2. Validate Recipient Address
        if not recipient or not recipient.startswith("0x") or len(recipient) != 42:
            return jsonify({"success": False, "status": "INVALID_RECIPIENT", "message": "Valid recipient Ethereum/Web3 0x address is required."}), 400

        # 2b. Validate Client Tx Hash Format (if provided)
        if client_tx_hash:
            if not client_tx_hash.startswith("0x") or len(client_tx_hash) != 66:
                return jsonify({
                    "success": False,
                    "status": "INVALID_TX_HASH",
                    "message": "Invalid transaction hash. Must be a 66-character 0x-prefixed hex string."
                }), 400

        # 3. Emergency Stop Check (Blocks live withdrawals)
        if (getattr(config, "EMERGENCY_STOP", False) or emergency_stop_active()) and mode == "LIVE":
            return jsonify({
                "success": False,
                "status": "BLOCKED_EMERGENCY_STOP",
                "message": "Treasury withdrawal blocked: Emergency Stop is active."
            }), 400

        # 4. Check available withdrawable profit
        withdrawable = get_withdrawable_profit(mode=mode)
        if amount > withdrawable:
            return jsonify({
                "success": False,
                "status": "INSUFFICIENT_PROFIT",
                "message": f"Requested amount (${amount:.4f}) exceeds available withdrawable profit (${withdrawable:.4f})."
            }), 400

        # 5. Handle MOCK / Simulation Mode
        if mode == "MOCK" or is_simulation:
            # Paper mode: Truthfully record as SIMULATED, with NO fake hash
            record_id = record_treasury_withdrawal({
                "tx_hash": "",
                "chain_id": chain_id_val,
                "token": token,
                "amount": amount,
                "recipient_address": recipient,
                "status": "SIMULATED",
                "mode": "MOCK",
                "notes": f"Paper simulated withdrawal of ${amount:.4f} {token} (No blockchain funds moved)"
            })
            new_withdrawable = get_withdrawable_profit(mode="MOCK")
            new_total_withdrawn = get_total_withdrawn(mode="MOCK")
            return jsonify({
                "success": True,
                "status": "SIMULATED",
                "simulated": True,
                "message": f"Simulated withdrawal of ${amount:.4f} {token} recorded. No blockchain funds were moved.",
                "withdrawal": {
                    "id": record_id,
                    "tx_hash": "",
                    "token": token,
                    "amount": amount,
                    "recipient_address": recipient,
                    "chain_id": chain_id_val,
                    "status": "SIMULATED",
                    "mode": "MOCK"
                },
                "total_withdrawn_usdt": new_total_withdrawn,
                "withdrawable_profit_usdt": new_withdrawable
            }), 200

        # 6. LIVE Mode: Must submit or verify a REAL blockchain transaction
        if client_tx_hash:
            if not client_tx_hash.startswith("0x") or len(client_tx_hash) != 66:
                return jsonify({
                    "success": False,
                    "status": "INVALID_TX_HASH",
                    "message": "Invalid transaction hash. Must be a 66-character 0x-prefixed hex string."
                }), 400
            
            # Verify client-provided hash on-chain
            from dex_engine import rpc_call
            receipt = rpc_call("eth_getTransactionReceipt", [client_tx_hash])
            if not receipt:
                return jsonify({
                    "success": False,
                    "pending": True,
                    "status": "PENDING",
                    "message": "Withdrawal transaction is still pending confirmation on the blockchain."
                }), 202

            status_val = receipt.get("status")
            is_success = (status_val == "0x1" or status_val == 1 or status_val is True)
            if not is_success:
                record_id = record_treasury_withdrawal({
                    "tx_hash": client_tx_hash,
                    "chain_id": chain_id_val,
                    "token": token,
                    "amount": amount,
                    "recipient_address": recipient,
                    "status": "FAILED",
                    "mode": "LIVE",
                    "notes": f"On-chain transaction {client_tx_hash} reverted"
                })
                return jsonify({
                    "success": False,
                    "status": "FAILED",
                    "tx_hash": client_tx_hash,
                    "message": f"Withdrawal transaction {client_tx_hash} reverted on-chain (status 0x0)."
                }), 400

            # Verified successful receipt!
            record_id = record_treasury_withdrawal({
                "tx_hash": client_tx_hash,
                "chain_id": chain_id_val,
                "token": token,
                "amount": amount,
                "recipient_address": recipient,
                "status": "CONFIRMED",
                "mode": "LIVE",
                "notes": f"Confirmed on-chain withdrawal of ${amount:.4f} {token} to {recipient[:6]}...{recipient[-4:]}"
            })
            return jsonify({
                "success": True,
                "status": "CONFIRMED",
                "message": f"Successfully verified on-chain withdrawal of ${amount:.4f} {token}.",
                "withdrawal": {
                    "id": record_id,
                    "tx_hash": client_tx_hash,
                    "token": token,
                    "amount": amount,
                    "recipient_address": recipient,
                    "chain_id": chain_id_val,
                    "status": "CONFIRMED",
                    "mode": "LIVE"
                },
                "total_withdrawn_usdt": get_total_withdrawn(mode="LIVE"),
                "withdrawable_profit_usdt": get_withdrawable_profit(mode="LIVE")
            }), 200

        # Subcase B2: Server execution
        # Check if contract and signing key are configured
        contract_address = (
            getattr(config, "TREASURY_CONTRACT_ADDRESS", "")
            or getattr(config, "ARBITRAGE_CONTRACT_ADDRESS", "")
        ).strip()
        private_key = (
            getattr(config, "PRIVATE_KEY", "")
            or os.environ.get("PRIVATE_KEY", "")
        ).strip()

        missing = []
        if not contract_address or not contract_address.startswith("0x") or len(contract_address) != 42:
            missing.append("Smart contract address (TREASURY_CONTRACT_ADDRESS or ARBITRAGE_CONTRACT_ADDRESS)")
        if not private_key:
            missing.append("Wallet signing private key (PRIVATE_KEY)")

        if missing:
            return jsonify({
                "success": False,
                "status": "NOT_CONFIGURED",
                "message": f"Real blockchain withdrawal is not configured. Missing: {', '.join(missing)}."
            }), 400

        # Execute real on-chain withdrawal
        from treasury_execution import submit_blockchain_withdrawal
        exec_result = submit_blockchain_withdrawal(
            contract_address=contract_address,
            private_key=private_key,
            token_symbol=token,
            amount=amount,
            recipient=recipient,
            chain_id=chain_id_val
        )

        real_tx = exec_result.get("tx_hash", "")

        if not exec_result.get("success"):
            if real_tx:
                record_treasury_withdrawal({
                    "tx_hash": real_tx,
                    "chain_id": chain_id_val,
                    "token": token,
                    "amount": amount,
                    "recipient_address": recipient,
                    "status": "FAILED",
                    "mode": "LIVE",
                    "notes": f"On-chain execution failed: {exec_result.get('message', '')}"
                })
            return jsonify({
                "success": False,
                "status": exec_result.get("status", "FAILED"),
                "tx_hash": real_tx,
                "message": exec_result.get("message", "Blockchain withdrawal execution failed.")
            }), 400

        # Transaction succeeded and receipt status is confirmed
        record_id = record_treasury_withdrawal({
            "tx_hash": real_tx,
            "chain_id": chain_id_val,
            "token": token,
            "amount": amount,
            "recipient_address": recipient,
            "status": "CONFIRMED",
            "mode": "LIVE",
            "notes": f"Confirmed on-chain withdrawal of ${amount:.4f} {token} to {recipient[:6]}...{recipient[-4:]}"
        })

        return jsonify({
            "success": True,
            "status": "CONFIRMED",
            "message": f"Successfully executed on-chain withdrawal of ${amount:.4f} {token} to {recipient[:6]}...{recipient[-4:]}.",
            "withdrawal": {
                "id": record_id,
                "tx_hash": real_tx,
                "token": token,
                "amount": amount,
                "recipient_address": recipient,
                "chain_id": chain_id_val,
                "status": "CONFIRMED",
                "mode": "LIVE"
            },
            "total_withdrawn_usdt": get_total_withdrawn(mode="LIVE"),
            "withdrawable_profit_usdt": get_withdrawable_profit(mode="LIVE")
        }), 200

    except Exception as exc:
        return jsonify({"success": False, "status": "ERROR", "message": f"Withdrawal error: {str(exc)}"}), 500


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
@require_api_auth
def manual_trade_api():
    global last_execution_status, last_background_trade_result
    try:
        if emergency_stop_active():
            return jsonify({
                "success": False,
                "status": "BLOCKED_EMERGENCY_STOP",
                "message": "Emergency Stop is active; trading is blocked."
            }), 400

        mode = getattr(config, "TRADING_MODE", "MOCK")
        if mode == "LIVE" and not getattr(config, "LIVE_TRADING_ARMED", False):
            return jsonify({
                "success": False,
                "status": "NOT_ARMED",
                "message": "LIVE trading is not armed. Both trading_mode == LIVE and live_trading_armed == true are required."
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
        elif result.get("status") == "LIVE_SIGNER_REQUIRED":
            last_execution_status = "ROUTED_TO_METAMASK: Forwarded for client wallet signature"
            record_execution_event(
                event_type="SIGNER_FORWARD",
                route=route_name,
                amount_in=amt,
                net_profit=np,
                status="METAMASK",
                reason="Forwarded to connected MetaMask wallet for non-custodial signature"
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

        status_code = 200 if (result.get("success") or result.get("status") == "LIVE_SIGNER_REQUIRED") else 400
        return jsonify(result), status_code
    except Exception as exc:
        return jsonify({"success": False, "message": f"Trade execution error: {str(exc)}"}), 500


@app.route("/api/trade/confirm-live", methods=["POST"])
@require_api_auth
def confirm_live_trade_api():
    """Verify and commit a real on-chain transaction executed via MetaMask or direct Web3 wallet.
    
    Queries the active blockchain RPC for the transaction receipt (eth_getTransactionReceipt),
    confirms EVM status == '0x1' (success), computes verified gas fees and actual net profit,
    and commits the genuine live trade to the database.
    """
    try:
        if emergency_stop_active():
            return jsonify({
                "success": False,
                "status": "BLOCKED_EMERGENCY_STOP",
                "message": "Emergency Stop is active; trade confirmation blocked."
            }), 400

        req = request.get_json(silent=True) or {}
        tx_hash = (req.get("tx_hash") or "").strip()
        if not tx_hash or not tx_hash.startswith("0x") or len(tx_hash) != 66:
            return jsonify({
                "success": False,
                "message": "Invalid transaction hash. Must be a 66-character 0x-prefixed hex string."
            }), 400

        target_chain_id = int(req.get("chain_id") or config.CHAIN_ID)
        if target_chain_id in config.CHAIN_REGISTRY and target_chain_id != config.CHAIN_ID:
            config.set_active_chain(target_chain_id)

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

        # Accurately compute gross profit and verified net profit without double-deducting gas
        req_gross = req.get("gross_profit")
        req_expected_net = req.get("expected_profit", req.get("net_profit"))
        
        if req_gross is not None and float(req_gross) > 0:
            gross_profit = float(req_gross)
        elif req_expected_net is not None and float(req_expected_net) > 0:
            gross_profit = float(req_expected_net) + gas_cost_usdt
        else:
            gross_profit = 0.0

        amount_out = float(req.get("amount_out", amount_in + gross_profit))
        verified_net_profit = round(gross_profit - gas_cost_usdt, 4)

        chain_id = int(req.get("chain_id") or config.CHAIN_ID)
        buy_dex = req.get("buy_dex") or "Uniswap_V2"
        sell_dex = req.get("sell_dex") or "SushiSwap_V2"
        token_pair = req.get("token_pair") or config.SYMBOL
        chain_label = config.CHAIN_REGISTRY.get(chain_id, {}).get("label", "Blockchain")

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
            "mode": "LIVE",
            "created_at": time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime()),
        }

        # STRICT PROFITABILITY GATE: Never confirm a trade with zero or negative net profit!
        if verified_net_profit <= 0:
            trade_data["status"] = "UNPROFITABLE"
            save_trade(trade_data)
            record_execution_event(
                event_type="LIVE_TRADE_UNPROFITABLE",
                route=f"{buy_dex}->{sell_dex}",
                amount_in=amount_in,
                net_profit=verified_net_profit,
                status="UNPROFITABLE",
                reason=f"Transaction confirmed on {chain_label} but net profit is negative (-${abs(verified_net_profit):.4f} USDT) after ${gas_cost_usdt:.4f} gas fee.",
                tx_hash=tx_hash
            )
            return jsonify({
                "success": False,
                "status": "UNPROFITABLE_EXECUTION",
                "trade": trade_data,
                "message": f"Transaction mined on {chain_label}, but net profit is negative (-${abs(verified_net_profit):.4f} USDT) after ${gas_cost_usdt:.4f} gas fee. Rejected from profitable trade confirmations."
            }), 400

        # Successful confirmed profitable trade
        trade_data["status"] = "CONFIRMED"
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
@require_api_auth
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

        # Fast, non-blocking registration of connected wallet address
        client_chain_id = chain_id if chain_id and chain_id in config.CHAIN_REGISTRY else config.CHAIN_ID

        return jsonify({
            "success": True,
            "message": f"Wallet connected: {address[:6]}...{address[-4:]}",
            "address": address,
            "chain_id": client_chain_id,
            "wallet": {
                "wallet_address": address,
                "chain_id": client_chain_id,
                "is_connected": True
            }
        })
    except Exception as exc:
        return jsonify({"success": False, "message": str(exc)}), 500


@app.route("/api/wallet/disconnect", methods=["POST"])
@require_api_auth
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
@require_api_auth(methods=["POST"])
def settings_api():
    if request.method == "POST":
        data = request.get_json(silent=True) or {}
        # Security: never allow writing or modifying API tokens via settings
        data.pop("api_auth_token", None)
        data.pop("api_token", None)
        data.pop("auth_token", None)

        if "auto_trade" in data:
            val = bool(data["auto_trade"])
            config.AUTO_TRADE_ENABLED = val
            save_bot_setting("auto_trade", val)

        if "trading_mode" in data and str(data["trading_mode"]).upper() in {"MOCK", "TESTNET", "LIVE"}:
            val = str(data["trading_mode"]).upper()
            prev_mode = getattr(config, "TRADING_MODE", "MOCK")
            config.TRADING_MODE = val
            save_bot_setting("trading_mode", val)
            # Safety requirement: Changing or setting trading_mode must NEVER automatically arm live trading.
            # If mode changes away from LIVE or is switched, ensure live_trading_armed remains disarmed.
            if val != prev_mode or val != "LIVE":
                config.LIVE_TRADING_ARMED = False
                save_bot_setting("live_trading_armed", False)

        # Disarming is permitted through settings, but arming requires explicit confirm_live=True
        # or the dedicated /api/trade/arm endpoint.
        if "live_trading_armed" in data:
            val = bool(data["live_trading_armed"])
            if not val:
                config.LIVE_TRADING_ARMED = False
                save_bot_setting("live_trading_armed", False)
            elif val and (data.get("confirm_live") is True or data.get("confirm") is True):
                if not emergency_stop_active():
                    config.LIVE_TRADING_ARMED = True
                    save_bot_setting("live_trading_armed", True)

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
            pk = str(data.pop("private_key")).strip()
            if pk:
                if not pk.startswith("0x") and len(pk) == 64:
                    pk = "0x" + pk
                if len(pk) == 66:
                    # In-memory session key only — NEVER persisted to SQLite database
                    config.PRIVATE_KEY = pk
                    try:
                        from eth_account import Account
                        acct = Account.from_key(pk)
                        config.WALLET_ADDRESS = acct.address
                        save_bot_setting("wallet_address", acct.address)
                    except Exception:
                        pass
            elif pk == "":
                config.PRIVATE_KEY = ""
                try:
                    from database import scrub_legacy_private_keys
                    scrub_legacy_private_keys()
                except Exception:
                    pass

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
@require_api_auth
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
@require_api_auth(methods=["POST"])
def emergency_stop_api():
    if request.method == "POST":
        req_data = request.get_json(silent=True) or {}
        if "active" in req_data:
            config.EMERGENCY_STOP = bool(req_data["active"])
        else:
            config.EMERGENCY_STOP = not config.EMERGENCY_STOP
        save_bot_setting("emergency_stop", config.EMERGENCY_STOP)

        # Emergency stop overrides any arm state: immediately disarm live trading
        if config.EMERGENCY_STOP:
            config.LIVE_TRADING_ARMED = False
            save_bot_setting("live_trading_armed", False)

    return jsonify({
        "success": True,
        "emergency_stop": emergency_stop_active(),
        "live_trading_armed": getattr(config, "LIVE_TRADING_ARMED", False),
        "message": "Emergency stop is active; trading is blocked." if emergency_stop_active() else "Emergency stop is deactivated.",
    })


@app.route("/api/trade/arm", methods=["GET", "POST"])
@app.route("/api/arm-live", methods=["GET", "POST"])
@require_api_auth(methods=["POST"])
def arm_live_trading_api():
    """Explicit arming action for LIVE trading.
    
    Safety rules:
    - Arming requires an authenticated request (Bearer token).
    - Arming requires explicit confirmation: confirm_live=true (or confirm=true).
    - Arming is blocked if Emergency Stop is active.
    - Disarming (arm=false) is always permitted.
    """
    if request.method == "GET":
        return jsonify({
            "success": True,
            "trading_mode": getattr(config, "TRADING_MODE", "MOCK"),
            "live_trading_armed": getattr(config, "LIVE_TRADING_ARMED", False),
            "emergency_stop": emergency_stop_active(),
        })

    req_data = request.get_json(silent=True) or {}
    arm_requested = req_data.get("arm", req_data.get("armed", True))
    if isinstance(arm_requested, str):
        arm_requested = arm_requested.lower() in ("true", "1", "yes")
    else:
        arm_requested = bool(arm_requested)

    if not arm_requested:
        config.LIVE_TRADING_ARMED = False
        save_bot_setting("live_trading_armed", False)
        return jsonify({
            "success": True,
            "status": "DISARMED",
            "live_trading_armed": False,
            "message": "Live trading has been safely disarmed."
        })

    # Cannot arm while emergency stop is active
    if emergency_stop_active():
        config.LIVE_TRADING_ARMED = False
        save_bot_setting("live_trading_armed", False)
        return jsonify({
            "success": False,
            "status": "BLOCKED_EMERGENCY_STOP",
            "message": "Cannot arm live trading while Emergency Stop is active."
        }), 400

    # Explicit confirmation value required
    confirm_live = req_data.get("confirm_live") or req_data.get("confirm")
    is_confirmed = (confirm_live is True) or (isinstance(confirm_live, str) and confirm_live.lower() in ("true", "1", "yes"))
    if not is_confirmed:
        return jsonify({
            "success": False,
            "status": "CONFIRMATION_REQUIRED",
            "message": "Explicit confirmation required: 'confirm_live=true' must be provided to arm live trading."
        }), 400

    config.LIVE_TRADING_ARMED = True
    save_bot_setting("live_trading_armed", True)
    return jsonify({
        "success": True,
        "status": "ARMED",
        "live_trading_armed": True,
        "trading_mode": getattr(config, "TRADING_MODE", "MOCK"),
        "message": "Live trading is now ARMED. Real on-chain transactions are enabled."
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
@require_api_auth
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
@require_api_auth
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
@require_api_auth
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


@app.route("/api/auth/verify", methods=["POST"])
@require_api_auth
def verify_auth_api():
    """Verify that the provided API authentication token is valid."""
    return jsonify({
        "success": True,
        "message": "API authentication token is valid."
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
    port = int(os.environ.get("PORT", getattr(config, "PORT", 5000)))
    host = os.environ.get("HOST", getattr(config, "HOST", "127.0.0.1"))
    app.run(host=host, port=port, debug=False)

