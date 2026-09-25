"""100% Decentralized Database Module.

Stores DEX trade history, on-chain execution details (tx hash, gas, price impact),
non-custodial portfolio balances, and engine configuration settings.
Completely free of centralized exchange dependencies.
"""
import os
import sqlite3
import json
from datetime import datetime
from typing import Dict, Any, List, Optional, Tuple

from config import DATABASE_NAME, BACKUP_JSON_PATH

os.makedirs(os.path.dirname(DATABASE_NAME), exist_ok=True)


def get_connection():
    conn = sqlite3.connect(DATABASE_NAME, timeout=30.0)
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

    # 24/7 Execution & Diagnostic Audit Logs Table
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS execution_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            event_type TEXT NOT NULL,
            route TEXT NOT NULL,
            amount_in REAL DEFAULT 0.0,
            net_profit REAL DEFAULT 0.0,
            status TEXT NOT NULL,
            reason TEXT DEFAULT '',
            tx_hash TEXT DEFAULT '',
            telemetry TEXT DEFAULT '',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)

    # Trade Latency Telemetry Audit Table (6 timestamps, 4 intervals, quote staleness, benchmarks)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS latency_audits (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tx_hash TEXT DEFAULT '',
            token_pair TEXT DEFAULT 'WETH/USDC',
            mode TEXT DEFAULT 'MOCK',
            opportunity_detected_at REAL DEFAULT 0.0,
            quote_received_at REAL DEFAULT 0.0,
            validation_started_at REAL DEFAULT 0.0,
            prep_started_at REAL DEFAULT 0.0,
            submitted_at REAL DEFAULT 0.0,
            confirmed_at REAL DEFAULT 0.0,
            quote_age_ms REAL DEFAULT 0.0,
            detection_to_prep_ms REAL DEFAULT 0.0,
            prep_to_submit_ms REAL DEFAULT 0.0,
            submit_to_confirm_ms REAL DEFAULT 0.0,
            total_elapsed_ms REAL DEFAULT 0.0,
            bottleneck_stage TEXT DEFAULT '',
            benchmark_status TEXT DEFAULT '',
            final_result TEXT DEFAULT 'CONFIRMED',
            skip_reason TEXT DEFAULT '',
            telemetry_json TEXT DEFAULT '{}',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)

    # Dynamic migrations for telemetry columns
    try:
        cursor.execute("ALTER TABLE trades ADD COLUMN telemetry TEXT DEFAULT ''")
    except Exception:
        pass
    try:
        cursor.execute("ALTER TABLE execution_logs ADD COLUMN telemetry TEXT DEFAULT ''")
    except Exception:
        pass

    conn.commit()
    conn.close()


# ============================================================
# BOT SETTINGS
# ============================================================

def save_bot_setting(key: str, value: Any):
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
        print(f"⚠️ Error saving setting {key}: {e}", flush=True)


def load_all_bot_settings() -> Dict[str, Any]:
    try:
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT key, value FROM bot_settings")
        rows = cursor.fetchall()
        conn.close()
        settings = {}
        for row in rows:
            try:
                settings[row["key"]] = json.loads(row["value"])
            except Exception:
                settings[row["key"]] = row["value"]
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

    telemetry_val = trade_data.get("telemetry")
    telemetry_str = json.dumps(telemetry_val) if isinstance(telemetry_val, dict) else str(telemetry_val or "")

    cursor.execute("""
        INSERT INTO trades (
            tx_hash, chain_id, buy_dex, sell_dex, token_pair,
            amount_in, amount_out, gross_profit, net_profit,
            gas_used, gas_price_gwei, gas_cost_usdt, price_impact, slippage,
            status, mode, created_at, telemetry
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        trade_data.get("tx_hash", ""),
        int(trade_data.get("chain_id", 1)),
        trade_data.get("buy_dex") or trade_data.get("buy", "Uniswap_V2"),
        trade_data.get("sell_dex") or trade_data.get("sell", "SushiSwap_V2"),
        trade_data.get("token_pair") or trade_data.get("symbol", "WETH/USDT"),
        float(trade_data.get("amount_in", 0.0)),
        float(trade_data.get("amount_out", 0.0)),
        float(trade_data.get("gross_profit", 0.0)),
        float(trade_data.get("net_profit", trade_data.get("profit", 0.0))),
        int(trade_data.get("gas_used", 0)),
        float(trade_data.get("gas_price_gwei", 0.0)),
        float(trade_data.get("gas_cost_usdt", trade_data.get("fees", 0.0))),
        float(trade_data.get("price_impact", 0.0)),
        float(trade_data.get("slippage", 0.0)),
        trade_data.get("status", "CONFIRMED"),
        trade_data.get("mode", "MOCK"),
        trade_data.get("created_at") or datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S"),
        telemetry_str
    ))

    trade_id = cursor.lastrowid
    conn.commit()
    conn.close()

    sync_trades_to_json_backup()
    return trade_id


def _normalize_mode_clause(mode: Optional[str]) -> Tuple[str, tuple]:
    """Helper to translate UI mode filters (LIVE, SIMULATION, ALL) to DB queries."""
    if not mode or mode == "ALL":
        return ("", ())
    if mode == "LIVE":
        return ("mode IN ('LIVE', 'TESTNET')", ())
    if mode in ("SIMULATION", "MOCK"):
        return ("mode IN ('SIMULATION', 'MOCK')", ())
    return ("mode = ?", (mode,))


def get_all_trades(limit: int = 100, mode: Optional[str] = None) -> List[Dict[str, Any]]:
    create_database()
    conn = get_connection()
    cursor = conn.cursor()
    clause, params = _normalize_mode_clause(mode)
    if clause:
        cursor.execute(f"SELECT * FROM trades WHERE {clause} ORDER BY id DESC LIMIT ?", (*params, limit))
    else:
        cursor.execute("SELECT * FROM trades ORDER BY id DESC LIMIT ?", (limit,))
    rows = cursor.fetchall()
    conn.close()
    res = []
    for row in rows:
        d = dict(row)
        if d.get("telemetry"):
            try:
                d["telemetry"] = json.loads(d["telemetry"])
            except Exception:
                pass
        res.append(d)
    return res


get_trades = get_all_trades


def get_latest_trade(mode: Optional[str] = None) -> Optional[Dict[str, Any]]:
    create_database()
    conn = get_connection()
    cursor = conn.cursor()
    clause, params = _normalize_mode_clause(mode)
    if clause:
        cursor.execute(f"SELECT * FROM trades WHERE {clause} ORDER BY id DESC LIMIT 1", params)
    else:
        cursor.execute("SELECT * FROM trades ORDER BY id DESC LIMIT 1")
    row = cursor.fetchone()
    conn.close()
    if not row:
        return None
    d = dict(row)
    if d.get("telemetry"):
        try:
            d["telemetry"] = json.loads(d["telemetry"])
        except Exception:
            pass
    return d


def get_total_trades(mode: Optional[str] = None) -> int:
    create_database()
    conn = get_connection()
    cursor = conn.cursor()
    clause, params = _normalize_mode_clause(mode)
    if clause:
        cursor.execute(f"SELECT COUNT(*) FROM trades WHERE {clause} AND status = 'CONFIRMED'", params)
    else:
        cursor.execute("SELECT COUNT(*) FROM trades WHERE status = 'CONFIRMED'")
    count = cursor.fetchone()[0]
    conn.close()
    return count


def get_total_profit(mode: Optional[str] = None) -> float:
    create_database()
    conn = get_connection()
    cursor = conn.cursor()
    clause, params = _normalize_mode_clause(mode)
    if clause:
        cursor.execute(f"SELECT COALESCE(SUM(net_profit), 0.0) FROM trades WHERE {clause} AND status = 'CONFIRMED'", params)
    else:
        cursor.execute("SELECT COALESCE(SUM(net_profit), 0.0) FROM trades WHERE status = 'CONFIRMED'")
    total = cursor.fetchone()[0]
    conn.close()
    return round(float(total), 4)


def get_today_live_profit(mode: Optional[str] = None) -> float:
    create_database()
    conn = get_connection()
    cursor = conn.cursor()
    clause, params = _normalize_mode_clause(mode)
    if clause:
        cursor.execute(f"""
            SELECT COALESCE(SUM(net_profit), 0.0)
            FROM trades
            WHERE DATE(created_at) = DATE('now') AND {clause} AND status = 'CONFIRMED'
        """, params)
    else:
        cursor.execute("""
            SELECT COALESCE(SUM(net_profit), 0.0)
            FROM trades
            WHERE DATE(created_at) = DATE('now') AND status = 'CONFIRMED'
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
    cursor.execute("DELETE FROM execution_logs")
    conn.commit()
    conn.close()

    if os.path.exists(BACKUP_JSON_PATH):
        try:
            with open(BACKUP_JSON_PATH, "w", encoding="utf-8") as f:
                json.dump([], f)
        except Exception:
            pass


def save_execution_log(event: Dict[str, Any]) -> int:
    """Save execution audit event to database for 24/7 persistent history."""
    try:
        create_database()
        conn = get_connection()
        cursor = conn.cursor()
        now_ts = datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S")
        telemetry_val = event.get("telemetry")
        telemetry_str = json.dumps(telemetry_val) if isinstance(telemetry_val, dict) else str(telemetry_val or "")
        cursor.execute("""
            INSERT INTO execution_logs (
                timestamp, event_type, route, amount_in, net_profit, status, reason, tx_hash, telemetry, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            event.get("timestamp") or now_ts,
            event.get("event_type", "INFO"),
            event.get("route", ""),
            float(event.get("amount_in", 0.0)),
            float(event.get("net_profit", 0.0)),
            event.get("status", "LOGGED"),
            event.get("reason", ""),
            event.get("tx_hash", ""),
            telemetry_str,
            now_ts
        ))
        log_id = cursor.lastrowid
        conn.commit()
        conn.close()
        return log_id
    except Exception as e:
        print(f"⚠️ Error saving execution log: {e}", flush=True)
        return -1


def get_recent_execution_logs(limit: int = 50) -> List[Dict[str, Any]]:
    """Retrieve the most recent execution logs from database across restarts."""
    try:
        create_database()
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute("""
            SELECT id, timestamp, event_type, route, amount_in, net_profit, status, reason, tx_hash, telemetry, created_at
            FROM execution_logs
            ORDER BY id DESC
            LIMIT ?
        """, (limit,))
        rows = cursor.fetchall()
        conn.close()
        res = []
        for r in rows:
            d = dict(r)
            if d.get("telemetry"):
                try:
                    d["telemetry"] = json.loads(d["telemetry"])
                except Exception:
                    pass
            res.append(d)
        return res
    except Exception as e:
        print(f"⚠️ Error reading execution logs: {e}", flush=True)
        return []


def save_latency_audit(audit_dict: Dict[str, Any]) -> int:
    """Save trade latency audit telemetry to SQLite database."""
    try:
        create_database()
        conn = get_connection()
        cursor = conn.cursor()
        intervals = audit_dict.get("intervals_ms", {})
        timestamps = audit_dict.get("timestamps", {})
        cursor.execute("""
            INSERT INTO latency_audits (
                tx_hash, token_pair, mode,
                opportunity_detected_at, quote_received_at, validation_started_at,
                prep_started_at, submitted_at, confirmed_at,
                quote_age_ms, detection_to_prep_ms, prep_to_submit_ms,
                submit_to_confirm_ms, total_elapsed_ms,
                bottleneck_stage, benchmark_status, final_result,
                skip_reason, telemetry_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            audit_dict.get("tx_hash", ""),
            audit_dict.get("token_pair", "WETH/USDC"),
            audit_dict.get("mode", "MOCK"),
            float(timestamps.get("opportunity_detected_at", 0.0)),
            float(timestamps.get("quote_received_at", 0.0)),
            float(timestamps.get("validation_started_at", 0.0)),
            float(timestamps.get("prep_started_at", 0.0)),
            float(timestamps.get("submitted_at", 0.0)),
            float(timestamps.get("confirmed_at", 0.0)),
            float(audit_dict.get("quote_age_ms", 0.0)),
            float(intervals.get("detection_to_prep_ms", 0.0)),
            float(intervals.get("prep_to_submit_ms", 0.0)),
            float(intervals.get("submit_to_confirm_ms", 0.0)),
            float(intervals.get("total_elapsed_ms", 0.0)),
            audit_dict.get("bottleneck_stage", ""),
            audit_dict.get("benchmark_status", ""),
            audit_dict.get("final_result", "CONFIRMED"),
            audit_dict.get("skip_reason", ""),
            json.dumps(audit_dict),
            audit_dict.get("created_at") or datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S")
        ))
        audit_id = cursor.lastrowid
        conn.commit()
        conn.close()
        return audit_id
    except Exception as exc:
        print(f"⚠️ Error saving latency audit: {exc}", flush=True)
        return -1


def get_recent_latency_audits(limit: int = 50) -> List[Dict[str, Any]]:
    """Retrieve recent latency telemetry audits from SQLite database."""
    try:
        create_database()
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute("""
            SELECT id, tx_hash, token_pair, mode,
                   opportunity_detected_at, quote_received_at, validation_started_at,
                   prep_started_at, submitted_at, confirmed_at,
                   quote_age_ms, detection_to_prep_ms, prep_to_submit_ms,
                   submit_to_confirm_ms, total_elapsed_ms,
                   bottleneck_stage, benchmark_status, final_result,
                   skip_reason, telemetry_json, created_at
            FROM latency_audits
            ORDER BY id DESC
            LIMIT ?
        """, (limit,))
        rows = cursor.fetchall()
        conn.close()
        results = []
        for r in rows:
            d = dict(r)
            if d.get("telemetry_json"):
                try:
                    full_obj = json.loads(d["telemetry_json"])
                    full_obj["id"] = d["id"]
                    results.append(full_obj)
                    continue
                except Exception:
                    pass
            results.append(d)
        return results
    except Exception as exc:
        print(f"⚠️ Error reading latency audits: {exc}", flush=True)
        return []


def get_live_pnl_summary(mode: Optional[str] = None) -> Dict[str, Any]:
    create_database()
    conn = get_connection()
    cursor = conn.cursor()

    clause, params = _normalize_mode_clause(mode)
    if clause:
        where_clause = f"WHERE {clause} AND status = 'CONFIRMED'"
    else:
        where_clause = "WHERE status = 'CONFIRMED'"

    cursor.execute(f"""
        SELECT
            COUNT(*) as total_trades,
            COALESCE(SUM(net_profit), 0.0) as total_net_profit,
            COALESCE(SUM(gross_profit), 0.0) as total_gross_profit,
            COALESCE(SUM(gas_cost_usdt), 0.0) as total_gas_spent,
            COALESCE(AVG(net_profit), 0.0) as avg_profit_per_trade,
            COALESCE(MAX(net_profit), 0.0) as max_profit_trade
        FROM trades
        {where_clause}
    """, params)
    row = dict(cursor.fetchone())

    recent_query = f"SELECT * FROM trades {where_clause} ORDER BY id DESC LIMIT 5"
    cursor.execute(recent_query, params)
    recent = [dict(r) for r in cursor.fetchall()]
    conn.close()

    row["recent_trades"] = recent
    row["total_net_profit"] = round(row["total_net_profit"], 4)
    row["total_gross_profit"] = round(row["total_gross_profit"], 4)
    row["total_gas_spent"] = round(row["total_gas_spent"], 4)
    row["avg_profit_per_trade"] = round(row["avg_profit_per_trade"], 4)
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
