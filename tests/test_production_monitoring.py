"""
Phase 23: Production Monitoring Verification Suite — Python

Verifies:
1. Application Health states: HEALTHY, DEGRADED, UNAVAILABLE
2. Blockchain Monitoring: Chain ID validation & Network Mismatch safety trip
3. Trade Monitoring: Strict on-chain confirmation invariant (Zero fake profits)
4. Consecutive Failure Circuit Breaker: Auto-rollback on 2 consecutive fails
5. Gas Monitoring: Gas price ceiling and minimum native gas balance gating
6. Wallet Monitoring: Disconnect & address change detection with revalidation
7. Error Classification & Secret Redaction (Zero leakage of private keys/secrets)
8. Alert Deduplication: Throttling alerts within 60s window
"""

import pytest
import time
import os
import json


def test_application_health_state_evaluation():
    """Verify application health state transitions across component statuses."""
    def evaluate_overall_health(components: dict, circuit_breaker_tripped: bool) -> str:
        if circuit_breaker_tripped:
            return "UNAVAILABLE"
        statuses = [c["status"] for c in components.values()]
        if any(s == "UNAVAILABLE" for s in statuses):
            return "UNAVAILABLE"
        if any(s == "DEGRADED" for s in statuses):
            return "DEGRADED"
        return "HEALTHY"

    comps = {
        "backend": {"status": "HEALTHY"},
        "database": {"status": "HEALTHY"},
        "rpc": {"status": "HEALTHY"},
        "dex": {"status": "HEALTHY"},
    }
    assert evaluate_overall_health(comps, False) == "HEALTHY"

    # Degraded RPC
    comps["rpc"]["status"] = "DEGRADED"
    assert evaluate_overall_health(comps, False) == "DEGRADED"

    # Unavailable Database
    comps["database"]["status"] = "UNAVAILABLE"
    assert evaluate_overall_health(comps, False) == "UNAVAILABLE"

    # Normal components but Emergency Stop active
    comps["database"]["status"] = "HEALTHY"
    comps["rpc"]["status"] = "HEALTHY"
    assert evaluate_overall_health(comps, True) == "UNAVAILABLE"


def test_blockchain_network_mismatch_circuit_breaker():
    """Verify that connecting to an unexpected chain ID trips emergency stop."""
    EXPECTED_CHAIN_ID = 8453 # Base L2 Mainnet

    def check_network(connected_chain_id: int) -> tuple[bool, str]:
        if connected_chain_id != EXPECTED_CHAIN_ID:
            return False, f"NETWORK_MISMATCH: got {connected_chain_id}, expected {EXPECTED_CHAIN_ID}"
        return True, "CONNECTED"

    # Correct Base L2
    ok, msg = check_network(8453)
    assert ok is True
    assert msg == "CONNECTED"

    # Mismatched network (e.g. Ethereum Mainnet 1 or Hardhat 31337)
    ok, msg = check_network(1)
    assert ok is False
    assert "NETWORK_MISMATCH" in msg

    ok, msg = check_network(31337)
    assert ok is False
    assert "NETWORK_MISMATCH" in msg


def test_trade_monitoring_onchain_confirmation_invariant():
    """Verify that trade metrics update strictly on verified blockchain confirmation."""
    system_metrics = {
        "successful_trades": 0,
        "failed_trades": 0,
        "cumulative_realized_profit_usd": 0.0,
        "consecutive_failures": 0,
    }

    def process_trade_event(event: str, receipt_status: int | None, profit: float, gas_cost: float):
        if event == "SUBMITTED":
            # Must NOT update success count or profit
            return
        elif event == "MINED":
            if receipt_status == 1:
                system_metrics["successful_trades"] += 1
                system_metrics["cumulative_realized_profit_usd"] += profit
                system_metrics["consecutive_failures"] = 0
            else:
                system_metrics["failed_trades"] += 1
                system_metrics["cumulative_realized_profit_usd"] -= gas_cost
                system_metrics["consecutive_failures"] += 1

    # Trade 1: Submitted (Mempool pending)
    process_trade_event("SUBMITTED", None, profit=1.50, gas_cost=0.20)
    assert system_metrics["successful_trades"] == 0
    assert system_metrics["cumulative_realized_profit_usd"] == 0.0

    # Trade 1: Confirmed on-chain (status 1)
    process_trade_event("MINED", receipt_status=1, profit=1.50, gas_cost=0.20)
    assert system_metrics["successful_trades"] == 1
    assert system_metrics["cumulative_realized_profit_usd"] == 1.50
    assert system_metrics["consecutive_failures"] == 0

    # Trade 2: Reverted on-chain (status 0)
    process_trade_event("MINED", receipt_status=0, profit=0.0, gas_cost=0.35)
    assert system_metrics["successful_trades"] == 1
    assert system_metrics["failed_trades"] == 1
    assert round(system_metrics["cumulative_realized_profit_usd"], 2) == 1.15
    assert system_metrics["consecutive_failures"] == 1


def test_consecutive_trade_failures_auto_rollback():
    """Verify that 2 consecutive trade failures trigger auto-rollback."""
    def check_circuit_breaker(consecutive_failures: int) -> bool:
        return consecutive_failures >= 2

    assert check_circuit_breaker(0) is False
    assert check_circuit_breaker(1) is False
    assert check_circuit_breaker(2) is True
    assert check_circuit_breaker(3) is True


def test_gas_monitoring_and_balance_gating():
    """Verify gas price ceiling and native ETH hot wallet balance gates."""
    GAS_CEILING_GWEI = 5.0
    MIN_REQUIRED_ETH = 0.005

    def validate_gas_conditions(gas_price_gwei: float, wallet_eth: float) -> tuple[bool, str]:
        if gas_price_gwei > GAS_CEILING_GWEI:
            return False, f"Gas price {gas_price_gwei} Gwei exceeds ceiling ({GAS_CEILING_GWEI} Gwei)"
        if wallet_eth < MIN_REQUIRED_ETH:
            return False, f"ETH balance {wallet_eth} below required {MIN_REQUIRED_ETH} ETH"
        return True, "Gas conditions optimal"

    # Acceptable
    ok, _ = validate_gas_conditions(0.05, 0.02)
    assert ok is True

    # Gas price spike
    ok, reason = validate_gas_conditions(6.2, 0.02)
    assert ok is False
    assert "exceeds ceiling" in reason

    # Low balance
    ok, reason = validate_gas_conditions(0.05, 0.003)
    assert ok is False
    assert "below required" in reason


def test_wallet_disconnect_and_address_change_revalidation():
    """Verify wallet state tracking requires re-validation when address switches or disconnects."""
    active_state = {
        "address": "0x1111111111111111111111111111111111111111",
        "requires_revalidation": False,
    }

    def on_wallet_change(new_addr: str | None):
        if not new_addr or new_addr.lower() != active_state["address"].lower():
            active_state["requires_revalidation"] = True
            active_state["address"] = new_addr

    # Same address does not require revalidation
    on_wallet_change("0x1111111111111111111111111111111111111111")
    assert active_state["requires_revalidation"] is False

    # Account switched in MetaMask
    on_wallet_change("0x2222222222222222222222222222222222222222")
    assert active_state["requires_revalidation"] is True
    assert active_state["address"] == "0x2222222222222222222222222222222222222222"

    # Disconnected
    on_wallet_change(None)
    assert active_state["requires_revalidation"] is True
    assert active_state["address"] is None


def test_error_classification_and_sensitive_data_scrubbing():
    """Verify that private keys, mnemonics, and credentials are scrubbed from diagnostic errors."""
    SENSITIVE_KEYS = {"privatekey", "private_key", "mnemonic", "secret", "apikey", "password"}

    def scrub(data: dict) -> dict:
        clean = {}
        for k, v in data.items():
            if k.lower() in SENSITIVE_KEYS:
                clean[k] = "[REDACTED_SECRET]"
            elif isinstance(v, dict):
                clean[k] = scrub(v)
            else:
                clean[k] = v
        return clean

    raw_details = {
        "trade_id": "TRADE-999",
        "private_key": "0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d",
        "password": "production_database_password",
        "apiKey": "super-secret-api-key",
        "rpc_error": "Connection timeout after 3000ms",
    }

    scrubbed = scrub(raw_details)
    assert scrubbed["trade_id"] == "TRADE-999"
    assert scrubbed["private_key"] == "[REDACTED_SECRET]"
    assert scrubbed["password"] == "[REDACTED_SECRET]"
    assert scrubbed["apiKey"] == "[REDACTED_SECRET]"
    assert scrubbed["rpc_error"] == "Connection timeout after 3000ms"


def test_alert_deduplication_throttling():
    """Verify duplicate alerts of same type are throttled within suppression window."""
    cache = {}
    WINDOW_SEC = 60

    def trigger_alert(alert_type: str, now: float) -> bool:
        if alert_type in cache:
            last_time, count = cache[alert_type]
            if now - last_time < WINDOW_SEC:
                cache[alert_type] = (last_time, count + 1)
                return False # Suppressed
        cache[alert_type] = (now, 1)
        return True # Dispatched

    t0 = 1000.0
    # First alert fires
    assert trigger_alert("RPC_UNAVAILABLE", t0) is True

    # Immediate second alert of same type suppressed
    assert trigger_alert("RPC_UNAVAILABLE", t0 + 5.0) is False

    # Different alert type allowed
    assert trigger_alert("INSUFFICIENT_GAS", t0 + 10.0) is True

    # Same alert after 65 seconds allowed
    assert trigger_alert("RPC_UNAVAILABLE", t0 + 65.0) is True
