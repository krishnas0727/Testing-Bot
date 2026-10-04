"""100% Decentralized Database Module.

Stores DEX trade history, on-chain execution details (tx hash, gas, price impact),
non-custodial portfolio balances, and engine configuration settings.
Completely free of centralized exchange dependencies.
"""
import os
import sqlite3
import json
from datetime import datetime
from typing import Dict, Any, List, Optional

import config
from config import DATABASE_NAME, BACKUP_JSON_PATH

os.makedirs(os.path.dirname(DATABASE_NAME), exist_ok=True)


def get_connection():
    target_db = getattr(config, "DATABASE_NAME", DATABASE_NAME)
    conn = sqlite3.connect(target_db, timeout=30.0)
    conn.row_factory = sqlite3.Row
    return conn


def create_database():
    conn = get_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("PRAGMA journal_mode=WAL")
    except Exception:
        pass

    # DEX Trades Table
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS trades (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tx_hash TEXT NOT NULL,
            chain_id INTEGER DEFAULT 11155111,
            buy_dex TEXT NOT NULL,
            sell_dex TEXT NOT NULL,
            token_pair TEXT DEFAULT 'WETH/USDT',
            amount_in REAL NOT NULL,
            amount_out REAL NOT NULL,
            gross_profit REAL NOT NULL,
            net_profit REAL NOT NULL,
            gas_used INTEGER DEFAULT 0,
            gas_price_gwei REAL DEFAULT 0.0,
            gas_cost_usdt REAL DEFAULT 0.0,
            price_impact REAL DEFAULT 0.0,
            slippage REAL DEFAULT 0.0,
            status TEXT DEFAULT 'CONFIRMED',
            mode TEXT DEFAULT 'MOCK',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)

    # Non-Custodial DEX Portfolio Table
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS portfolio (
            id INTEGER PRIMARY KEY DEFAULT 1,
            wallet_address TEXT DEFAULT '',
            chain_id INTEGER DEFAULT 11155111,
            eth_balance REAL DEFAULT 0.0,
            weth_balance REAL DEFAULT 0.0,
            usdt_balance REAL DEFAULT 0.0,
            usdc_balance REAL DEFAULT 0.0,
            total_equity_usdt REAL DEFAULT 0.0,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)

    # Initialize portfolio table (zero balances until real on-chain balance is verified)
    cursor.execute("SELECT COUNT(*) FROM portfolio")
    if cursor.fetchone()[0] == 0:
        cursor.execute("""
            INSERT INTO portfolio (id, wallet_address, chain_id, eth_balance, weth_balance, usdt_balance, usdc_balance, total_equity_usdt)
            VALUES (1, '', 11155111, 0.0, 0.0, 0.0, 0.0, 0.0)
        """)

    # DEX Settings Table
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS bot_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)

    # Arbitrage Opportunity Scan Log
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS opportunity_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            buy_dex TEXT,
            sell_dex TEXT,
            symbol TEXT,
            spread REAL DEFAULT 0.0,
            net_profit REAL DEFAULT 0.0,
            gas_cost_usdt REAL DEFAULT 0.0,
            price_impact_pct REAL DEFAULT 0.0,
            profitable INTEGER DEFAULT 0,
            decision TEXT DEFAULT '',
            scanned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)

    # Treasury & Profit Withdrawals Ledger
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS treasury_withdrawals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tx_hash TEXT DEFAULT '',
            chain_id INTEGER DEFAULT 11155111,
            token TEXT DEFAULT 'USDT',
            amount REAL NOT NULL,
            recipient_address TEXT NOT NULL,
            status TEXT DEFAULT 'CONFIRMED',
            mode TEXT DEFAULT 'LIVE',
            notes TEXT DEFAULT '',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)

    # Module 9: Treasury Revenue Allocations Ledger (60% Capital / 20% Reserve / 20% Revenue)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS treasury_allocations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            trade_id INTEGER,
            tx_hash TEXT DEFAULT '',
            chain_id INTEGER DEFAULT 11155111,
            token TEXT DEFAULT 'USDT',
            gross_profit REAL DEFAULT 0.0,
            net_profit REAL DEFAULT 0.0,
            trading_capital REAL DEFAULT 0.0,
            reserve REAL DEFAULT 0.0,
            revenue REAL DEFAULT 0.0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)

    # Schema migration: Add ROI, initial_capital, and dex_fees to trades table if not present
    try:
        cursor.execute("PRAGMA table_info(trades)")
        cols = [r["name"] for r in cursor.fetchall()]
        if "roi" not in cols:
            cursor.execute("ALTER TABLE trades ADD COLUMN roi REAL DEFAULT 0.0")
        if "initial_capital" not in cols:
            cursor.execute("ALTER TABLE trades ADD COLUMN initial_capital REAL DEFAULT 0.0")
        if "dex_fees" not in cols:
            cursor.execute("ALTER TABLE trades ADD COLUMN dex_fees REAL DEFAULT 0.0")
    except Exception:
        pass

    # Risk-control ledger table (Phase 4): Dedicated immutable ledger for risk calculations.
    # Independent of UI trades table; never wiped by /api/trades/clear.
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS risk_ledger (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            trade_id INTEGER,
            tx_hash TEXT NOT NULL,
            chain_id INTEGER DEFAULT 11155111,
            amount_in REAL NOT NULL,
            net_profit REAL NOT NULL,
            mode TEXT NOT NULL DEFAULT 'LIVE',
            status TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)

    # Backfill legacy LIVE trades if not yet present in risk_ledger
    try:
        cursor.execute("""
            INSERT INTO risk_ledger (trade_id, tx_hash, chain_id, amount_in, net_profit, mode, status, created_at)
            SELECT id, tx_hash, chain_id, amount_in, net_profit, mode, status, created_at
            FROM trades
            WHERE mode = 'LIVE' AND id NOT IN (SELECT trade_id FROM risk_ledger WHERE trade_id IS NOT NULL)
        """)
    except Exception:
        pass

    # Security mandate (Phase 3): Scrub any legacy plaintext private keys or API tokens
    try:
        cursor.execute("DELETE FROM bot_settings WHERE LOWER(key) IN ('private_key', 'priv_key', 'pk', 'secret_key', 'api_auth_token', 'api_token', 'auth_token')")
    except Exception:
        pass

    conn.commit()
    conn.close()


def scrub_legacy_private_keys() -> int:
    """Permanently delete any legacy plaintext private keys or API tokens from SQLite without reading or logging them."""
    try:
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute("DELETE FROM bot_settings WHERE LOWER(key) IN ('private_key', 'priv_key', 'pk', 'secret_key', 'api_auth_token', 'api_token', 'auth_token')")
        affected = cursor.rowcount
        conn.commit()
        conn.close()
        return max(0, affected)
    except Exception:
        return 0


# ============================================================
# BOT SETTINGS
# ============================================================

def save_bot_setting(key: str, value: Any):
    # Security invariant: Never persist raw private keys or API tokens to SQLite database
    k_lower = str(key).lower()
    if k_lower in ("private_key", "priv_key", "secret_key", "pk", "api_auth_token", "api_token", "auth_token"):
        return
    try:
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO bot_settings (key, value, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = CURRENT_TIMESTAMP
        """, (str(key), json.dumps(value)))
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"⚠️ Error saving setting: {e}", flush=True)


def load_all_bot_settings() -> Dict[str, Any]:
    try:
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT key, value FROM bot_settings")
        rows = cursor.fetchall()
        conn.close()
        settings = {}
        for row in rows:
            k = row["key"]
            if str(k).lower() in ("private_key", "priv_key", "secret_key", "pk", "api_auth_token", "api_token", "auth_token"):
                continue
            try:
                settings[k] = json.loads(row["value"])
            except Exception:
                settings[k] = row["value"]
        return settings
    except Exception as e:
        print(f"⚠️ Error loading bot settings: {e}", flush=True)
        return {}


# ============================================================
# TRADES MANAGEMENT
# ============================================================

def save_trade(trade_data: Dict[str, Any]) -> int:
    create_database()
    conn = get_connection()
    cursor = conn.cursor()

    amount_in = float(trade_data.get("amount_in", 0.0))
    net_profit = float(trade_data.get("net_profit", trade_data.get("profit", 0.0)))
    roi = round((net_profit / amount_in * 100.0), 2) if amount_in > 0 else 0.0
    dex_fees = float(trade_data.get("dex_fees", amount_in * 0.006))
    initial_cap = float(trade_data.get("initial_capital", amount_in))
    tx_hash = trade_data.get("tx_hash", "")
    mode = trade_data.get("mode", "MOCK")
    chain_id = int(trade_data.get("chain_id", 1))

    cursor.execute("""
        INSERT INTO trades (
            tx_hash, chain_id, buy_dex, sell_dex, token_pair,
            amount_in, amount_out, gross_profit, net_profit,
            gas_used, gas_price_gwei, gas_cost_usdt, price_impact, slippage,
            status, mode, created_at, roi, initial_capital, dex_fees
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        tx_hash,
        chain_id,
        trade_data.get("buy_dex") or trade_data.get("buy", "Uniswap_V2"),
        trade_data.get("sell_dex") or trade_data.get("sell", "SushiSwap_V2"),
        trade_data.get("token_pair") or trade_data.get("symbol", "WETH/USDT"),
        amount_in,
        float(trade_data.get("amount_out", 0.0)),
        float(trade_data.get("gross_profit", 0.0)),
        net_profit,
        int(trade_data.get("gas_used", 0)),
        float(trade_data.get("gas_price_gwei", 0.0)),
        float(trade_data.get("gas_cost_usdt", trade_data.get("fees", 0.0))),
        float(trade_data.get("price_impact", 0.0)),
        float(trade_data.get("slippage", 0.0)),
        trade_data.get("status", "CONFIRMED"),
        mode,
        trade_data.get("created_at") or datetime.now().astimezone().isoformat(),
        roi,
        initial_cap,
        dex_fees
    ))

    trade_id = cursor.lastrowid

    # Phase 4 Risk Mandate: Record all LIVE trades to the immutable risk_ledger
    if mode == "LIVE":
        try:
            cursor.execute("""
                INSERT INTO risk_ledger (
                    trade_id, tx_hash, chain_id, amount_in, net_profit, mode, status, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                trade_id,
                tx_hash,
                chain_id,
                amount_in,
                net_profit,
                "LIVE",
                trade_data.get("status", "CONFIRMED"),
                trade_data.get("created_at") or datetime.now().astimezone().isoformat(),
            ))
        except Exception as e:
            print(f"⚠️ Error recording to risk ledger: {e}", flush=True)

    conn.commit()
    conn.close()

    # Module 9: Automatically record revenue allocation if trade confirmed with net profit > 0
    if trade_data.get("status") == "CONFIRMED" and net_profit > 0:
        token_sym = "USDT" if "USDT" in str(trade_data.get("token_pair", "")) else "USDC"
        record_treasury_allocation({
            "trade_id": trade_id,
            "tx_hash": tx_hash,
            "chain_id": chain_id,
            "token": token_sym,
            "gross_profit": float(trade_data.get("gross_profit", 0.0)),
            "net_profit": net_profit,
            "trading_capital": round(net_profit * 0.60, 4),
            "reserve": round(net_profit * 0.20, 4),
            "revenue": round(net_profit * 0.20, 4)
        })

    sync_trades_to_json_backup()
    return trade_id


def get_all_trades(limit: int = 100, mode: Optional[str] = None) -> List[Dict[str, Any]]:
    create_database()
    conn = get_connection()
    cursor = conn.cursor()
    if mode and mode != "ALL":
        cursor.execute("SELECT * FROM trades WHERE mode = ? ORDER BY id DESC LIMIT ?", (mode, limit))
    else:
        cursor.execute("SELECT * FROM trades ORDER BY id DESC LIMIT ?", (limit,))
    rows = cursor.fetchall()
    conn.close()
    return [dict(row) for row in rows]


get_trades = get_all_trades


def get_latest_trade(mode: Optional[str] = None) -> Optional[Dict[str, Any]]:
    create_database()
    conn = get_connection()
    cursor = conn.cursor()
    if mode and mode != "ALL":
        cursor.execute("SELECT * FROM trades WHERE mode = ? ORDER BY id DESC LIMIT 1", (mode,))
    else:
        cursor.execute("SELECT * FROM trades ORDER BY id DESC LIMIT 1")
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None


def get_total_trades(mode: Optional[str] = None) -> int:
    create_database()
    conn = get_connection()
    cursor = conn.cursor()
    if mode and mode != "ALL":
        cursor.execute("SELECT COUNT(*) FROM trades WHERE mode = ? AND status = 'CONFIRMED'", (mode,))
    else:
        cursor.execute("SELECT COUNT(*) FROM trades WHERE status = 'CONFIRMED'")
    count = cursor.fetchone()[0]
    conn.close()
    return count


def get_total_profit(mode: Optional[str] = None) -> float:
    create_database()
    conn = get_connection()
    cursor = conn.cursor()
    if mode and mode != "ALL":
        cursor.execute("SELECT COALESCE(SUM(net_profit), 0.0) FROM trades WHERE mode = ? AND status = 'CONFIRMED'", (mode,))
    else:
        cursor.execute("SELECT COALESCE(SUM(net_profit), 0.0) FROM trades WHERE status = 'CONFIRMED'")
    total = cursor.fetchone()[0]
    conn.close()
    return round(float(total), 4)


def get_today_live_profit(mode: Optional[str] = "LIVE") -> float:
    """Return cumulative net profit/loss for today used by risk controls and daily loss breaker.
    
    Phase 4 Invariants:
    1. Daily loss calculations use LIVE trades only (sourced from immutable risk_ledger).
    2. MOCK / PAPER trades NEVER affect live daily loss calculations.
    3. Clearing UI trade history (/api/trades/clear) does NOT reset the risk-control state.
    4. Survives application restarts.
    """
    create_database()
    conn = get_connection()
    cursor = conn.cursor()
    if mode == "MOCK":
        cursor.execute("""
            SELECT COALESCE(SUM(net_profit), 0.0)
            FROM trades
            WHERE DATE(created_at) = DATE('now') AND mode = 'MOCK' AND status IN ('CONFIRMED','REVERTED','UNPROFITABLE','FAILED')
        """)
    else:
        cursor.execute("""
            SELECT COALESCE(SUM(net_profit), 0.0)
            FROM risk_ledger
            WHERE DATE(created_at) = DATE('now') AND mode = 'LIVE' AND status IN ('CONFIRMED','REVERTED','UNPROFITABLE','FAILED')
        """)
    today_profit = cursor.fetchone()[0]
    conn.close()
    return round(float(today_profit), 4)


def delete_all_trades():
    create_database()
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM trades")
    cursor.execute("DELETE FROM opportunity_log")
    conn.commit()
    conn.close()

    if os.path.exists(BACKUP_JSON_PATH):
        try:
            with open(BACKUP_JSON_PATH, "w", encoding="utf-8") as f:
                json.dump([], f)
        except Exception:
            pass


def get_live_pnl_summary(mode: Optional[str] = None) -> Dict[str, Any]:
    create_database()
    conn = get_connection()
    cursor = conn.cursor()

    where_clause = "WHERE mode = ? AND status = 'CONFIRMED'" if (mode and mode != "ALL") else "WHERE status = 'CONFIRMED'"
    params = (mode,) if (mode and mode != "ALL") else ()

    cursor.execute(f"""
        SELECT
            COUNT(*) as total_trades,
            COALESCE(SUM(net_profit), 0.0) as total_net_profit,
            COALESCE(SUM(gross_profit), 0.0) as total_gross_profit,
            COALESCE(SUM(gas_cost_usdt), 0.0) as total_gas_spent,
            COALESCE(AVG(net_profit), 0.0) as avg_profit_per_trade,
            COALESCE(MAX(net_profit), 0.0) as max_profit_trade,
            COALESCE(SUM(CASE WHEN amount_in > 0 THEN amount_in ELSE initial_capital END), 0.0) as total_capital,
            COALESCE(SUM(CASE WHEN net_profit > 0 THEN 1 ELSE 0 END), 0) as winning_trades
        FROM trades
        {where_clause}
    """, params)
    row = dict(cursor.fetchone())

    recent_query = f"SELECT * FROM trades {where_clause} ORDER BY id DESC LIMIT 5"
    cursor.execute(recent_query, params)
    recent = [dict(r) for r in cursor.fetchall()]
    conn.close()

    total_tr = int(row.get("total_trades", 0))
    win_tr = int(row.get("winning_trades", 0))
    tot_net = float(row.get("total_net_profit", 0.0))
    tot_cap = float(row.get("total_capital", 0.0))

    win_rate = round((win_tr / total_tr * 100.0), 2) if total_tr > 0 else 0.0
    roi = round((tot_net / tot_cap * 100.0), 2) if tot_cap > 0 else 0.0

    row["recent_trades"] = recent
    row["total_net_profit"] = round(tot_net, 4)
    row["total_gross_profit"] = round(float(row.get("total_gross_profit", 0.0)), 4)
    row["total_gas_spent"] = round(float(row.get("total_gas_spent", 0.0)), 4)
    row["avg_profit_per_trade"] = round(float(row.get("avg_profit_per_trade", 0.0)), 4)
    row["win_rate"] = win_rate
    row["roi"] = roi
    row["winning_trades"] = win_tr
    row["treasury_buckets"] = get_treasury_buckets_summary()
    return row


# ============================================================
# BACKUP & RESTORE
# ============================================================

def sync_trades_to_json_backup():
    try:
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM trades ORDER BY id ASC")
        rows = cursor.fetchall()
        conn.close()

        trades_list = [dict(row) for row in rows]
        with open(BACKUP_JSON_PATH, "w", encoding="utf-8") as f:
            json.dump(trades_list, f, indent=2)
    except Exception as e:
        print(f"⚠️ JSON backup sync error: {e}", flush=True)


def restore_trades_from_json_backup():
    if not os.path.exists(BACKUP_JSON_PATH):
        return
    try:
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) FROM trades")
        count = cursor.fetchone()[0]

        if count == 0:
            with open(BACKUP_JSON_PATH, "r", encoding="utf-8") as f:
                backup = json.load(f)
            if backup and isinstance(backup, list):
                for t in backup:
                    cursor.execute("""
                        INSERT INTO trades (
                            tx_hash, chain_id, buy_dex, sell_dex, token_pair,
                            amount_in, amount_out, gross_profit, net_profit,
                            gas_used, gas_price_gwei, gas_cost_usdt, price_impact, slippage,
                            status, mode, created_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """, (
                        t.get("tx_hash", "0xbackup"),
                        int(t.get("chain_id", 1)),
                        t.get("buy_dex", "Uniswap_V2"),
                        t.get("sell_dex", "SushiSwap_V2"),
                        t.get("token_pair", "WETH/USDT"),
                        float(t.get("amount_in", 0.0)),
                        float(t.get("amount_out", 0.0)),
                        float(t.get("gross_profit", 0.0)),
                        float(t.get("net_profit", 0.0)),
                        int(t.get("gas_used", 0)),
                        float(t.get("gas_price_gwei", 0.0)),
                        float(t.get("gas_cost_usdt", 0.0)),
                        float(t.get("price_impact", 0.0)),
                        float(t.get("slippage", 0.0)),
                        t.get("status", "CONFIRMED"),
                        t.get("mode", "MOCK"),
                        t.get("created_at") or datetime.now().astimezone().isoformat()
                    ))
                conn.commit()
        conn.close()
    except Exception as e:
        print(f"⚠️ Restore trades backup error: {e}", flush=True)


# ============================================================
# TREASURY & PROFIT WITHDRAWALS
# ============================================================

def record_treasury_withdrawal(data: Dict[str, Any]) -> int:
    """Record a profit withdrawal to user's wallet or treasury recipient.
    
    Phase 5 Safety Requirement:
    - Never mark as CONFIRMED without a verified 66-character EVM transaction hash.
    - Explicitly rejects fake/invented hashes (such as 0xtreasury_...).
    """
    status = str(data.get("status", "CONFIRMED")).upper().strip()
    tx_hash = str(data.get("tx_hash", "")).strip()

    if status == "CONFIRMED":
        if not tx_hash or tx_hash.startswith("0xtreasury_") or len(tx_hash) != 66 or not tx_hash.startswith("0x"):
            raise ValueError(
                f"Cannot record withdrawal as CONFIRMED without a verified 66-character EVM transaction hash (got: '{tx_hash}')"
            )

    create_database()
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO treasury_withdrawals (
            tx_hash, chain_id, token, amount, recipient_address, status, mode, notes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        tx_hash,
        int(data.get("chain_id", 11155111)),
        data.get("token", "USDT"),
        float(data.get("amount", 0.0)),
        data.get("recipient_address", ""),
        status,
        data.get("mode", "LIVE"),
        data.get("notes", ""),
        data.get("created_at") or datetime.now().astimezone().isoformat()
    ))
    wid = cursor.lastrowid
    conn.commit()
    conn.close()
    return wid


def get_total_withdrawn(mode: Optional[str] = None, token: Optional[str] = None) -> float:
    """Calculate total profit withdrawn to date."""
    create_database()
    conn = get_connection()
    cursor = conn.cursor()
    query = "SELECT COALESCE(SUM(amount), 0.0) FROM treasury_withdrawals WHERE status = 'CONFIRMED'"
    params = []
    if mode and mode != "ALL":
        query += " AND mode = ?"
        params.append(mode)
    if token:
        query += " AND token = ?"
        params.append(token)
    cursor.execute(query, tuple(params))
    total = cursor.fetchone()[0]
    conn.close()
    return round(float(total), 4)


def get_treasury_withdrawals(limit: int = 50, mode: Optional[str] = None) -> List[Dict[str, Any]]:
    """Retrieve history of profit withdrawals."""
    create_database()
    conn = get_connection()
    cursor = conn.cursor()
    if mode and mode != "ALL":
        cursor.execute("SELECT * FROM treasury_withdrawals WHERE mode = ? ORDER BY id DESC LIMIT ?", (mode, limit))
    else:
        cursor.execute("SELECT * FROM treasury_withdrawals ORDER BY id DESC LIMIT ?", (limit,))
    rows = cursor.fetchall()
    conn.close()
    return [dict(row) for row in rows]


def get_withdrawable_profit(mode: Optional[str] = None) -> float:
    """Calculate available realized profit ready for withdrawal."""
    total_profit = get_total_profit(mode=mode)
    total_withdrawn = get_total_withdrawn(mode=mode)
    return round(max(0.0, total_profit - total_withdrawn), 4)


def record_treasury_allocation(data: Dict[str, Any]) -> int:
    """Record a multi-bucket revenue distribution event (Module 9)."""
    create_database()
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO treasury_allocations (
            trade_id, tx_hash, chain_id, token, gross_profit, net_profit,
            trading_capital, reserve, revenue, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        data.get("trade_id", 0),
        data.get("tx_hash", ""),
        int(data.get("chain_id", 11155111)),
        data.get("token", "USDT"),
        float(data.get("gross_profit", 0.0)),
        float(data.get("net_profit", 0.0)),
        float(data.get("trading_capital", 0.0)),
        float(data.get("reserve", 0.0)),
        float(data.get("revenue", 0.0)),
        data.get("created_at") or datetime.now().astimezone().isoformat()
    ))
    alloc_id = cursor.lastrowid
    conn.commit()
    conn.close()
    return alloc_id


def get_treasury_allocations(limit: int = 50) -> List[Dict[str, Any]]:
    """Retrieve history of revenue distributions across capital, reserve, and revenue."""
    create_database()
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM treasury_allocations ORDER BY id DESC LIMIT ?", (limit,))
    rows = cursor.fetchall()
    conn.close()
    return [dict(row) for row in rows]


def get_treasury_buckets_summary(token: Optional[str] = None) -> Dict[str, Any]:
    """Retrieve cumulative breakdown across Trading Capital (60%), Reserve (20%), and Revenue (20%)."""
    create_database()
    conn = get_connection()
    cursor = conn.cursor()
    query = """
        SELECT
            COALESCE(SUM(trading_capital), 0.0) as total_trading_capital,
            COALESCE(SUM(reserve), 0.0) as total_reserve,
            COALESCE(SUM(revenue), 0.0) as total_revenue,
            COALESCE(SUM(net_profit), 0.0) as total_allocated
        FROM treasury_allocations
    """
    params = []
    if token:
        query += " WHERE token = ?"
        params.append(token)
    cursor.execute(query, tuple(params))
    row = dict(cursor.fetchone())
    conn.close()
    return {
        "trading_capital": round(float(row["total_trading_capital"]), 4),
        "reserve": round(float(row["total_reserve"]), 4),
        "revenue": round(float(row["total_revenue"]), 4),
        "total_allocated": round(float(row["total_allocated"]), 4),
    }

