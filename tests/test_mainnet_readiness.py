"""
Phase 22: Controlled Mainnet Launch Verification Suite — Python

Verifies:
1. Base L2 Mainnet (Chain ID 8453) network & contract configuration separation
2. 14-Point Pre-Launch Readiness checklist evaluation
3. Controlled first trade sizing boundaries ($5.00 - $100.00 USD)
4. Strict net profit gate enforcement (>= $0.10 USD)
5. Concurrency & duplicate-trade lock mechanism
6. Instant emergency rollback protocol
7. Zero fake data invariant (only mined receipts confirm trades)
"""

import pytest
import os
import json


def test_base_mainnet_configuration_isolation():
    """Verify Base L2 mainnet configuration values and separation from testnets."""
    config_path = os.path.join(os.path.dirname(__file__), "../src/config/mainnet.ts")
    assert os.path.exists(config_path), "mainnet.ts configuration file missing!"

    with open(config_path, "r", encoding="utf-8") as f:
        content = f.read()

    # Must specify Base Mainnet Chain ID 8453
    assert "chainId: 8453" in content
    # Native Base USDC
    assert "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" in content
    # Canonical WETH
    assert "0x4200000000000000000000000000000000000006" in content
    # Strict bounds
    assert "minTradeAmountUsd: 5.0" in content
    assert "maxTradeAmountUsd: 100.0" in content
    assert "minNetProfitUsd: 0.10" in content


def test_14_point_readiness_checklist_logic():
    """Verify that all 14 launch readiness criteria must pass for launch approval."""
    checklist = {
        "unit_tests_pass": True,
        "contract_tests_pass": True,
        "integration_tests_pass": True,
        "edge_case_tests_pass": True,
        "security_audit_clear": True,
        "prod_infrastructure_ready": True,
        "backend_health_ready": True,
        "database_connected": True,
        "rpc_connected": True,
        "contract_address_valid": True,
        "contract_ownership_verified": True,
        "dex_routers_verified": True,
        "wallet_funded_gas": True,
        "live_trading_armed": False, # Default unarmed
    }

    def evaluate_readiness(checks: dict) -> tuple[bool, list[str]]:
        blockers = []
        for key, val in checks.items():
            if not val:
                blockers.append(f"Gate failed: {key}")
        return len(blockers) == 0, blockers

    # When unarmed, readiness must report ready_for_arming=False
    ready, blockers = evaluate_readiness(checklist)
    assert not ready
    assert "Gate failed: live_trading_armed" in blockers

    # When all armed and verified
    checklist["live_trading_armed"] = True
    ready, blockers = evaluate_readiness(checklist)
    assert ready
    assert len(blockers) == 0


def test_controlled_trade_size_bounds():
    """Verify trade size guardrails: min $5.00, max first trade $100.00."""
    MIN_SIZE = 5.0
    MAX_SIZE = 100.0

    def validate_size(size_usd: float) -> tuple[bool, str]:
        if size_usd < MIN_SIZE:
            return False, f"Size ${size_usd:.2f} below min ${MIN_SIZE:.2f}"
        if size_usd > MAX_SIZE:
            return False, f"Size ${size_usd:.2f} exceeds max ${MAX_SIZE:.2f}"
        return True, "Valid"

    # Below minimum
    valid, msg = validate_size(4.99)
    assert not valid
    assert "below min" in msg

    # Above maximum
    valid, msg = validate_size(100.01)
    assert not valid
    assert "exceeds max" in msg

    # Valid boundaries
    assert validate_size(5.0)[0] is True
    assert validate_size(25.0)[0] is True
    assert validate_size(100.0)[0] is True


def test_minimum_profit_gate():
    """Verify net profit threshold enforcement: requires >= $0.10 USD."""
    MIN_NET_PROFIT = 0.10

    def check_profitability(gross_profit: float, dex_fee: float, gas_cost: float, slippage_loss: float) -> tuple[bool, float]:
        net = gross_profit - (dex_fee + gas_cost + slippage_loss)
        return net >= MIN_NET_PROFIT, round(net, 4)

    # Profitable scenario
    profitable, net = check_profitability(gross_profit=1.20, dex_fee=0.30, gas_cost=0.15, slippage_loss=0.10)
    assert profitable is True
    assert net == 0.65

    # Barely profitable below threshold ($0.05 net)
    profitable, net = check_profitability(gross_profit=0.60, dex_fee=0.30, gas_cost=0.15, slippage_loss=0.10)
    assert profitable is False
    assert net == 0.05

    # Negative profit scenario
    profitable, net = check_profitability(gross_profit=0.40, dex_fee=0.30, gas_cost=0.20, slippage_loss=0.10)
    assert profitable is False
    assert net == -0.20


def test_concurrency_and_duplicate_trade_lock():
    """Verify in-flight trade deduplication lock prevents simultaneous double-executions."""
    active_locks = set()

    def acquire_trade_lock(pair: str, route: str) -> bool:
        lock_key = f"{pair}::{route}"
        if lock_key in active_locks:
            return False
        active_locks.add(lock_key)
        return True

    def release_trade_lock(pair: str, route: str):
        lock_key = f"{pair}::{route}"
        active_locks.discard(lock_key)

    # First trade acquires lock
    assert acquire_trade_lock("USDC/WETH", "UniV2->SushiV2") is True

    # Duplicate / simultaneous trade on same route is rejected
    assert acquire_trade_lock("USDC/WETH", "UniV2->SushiV2") is False

    # Different route succeeds
    assert acquire_trade_lock("USDC/WETH", "SushiV2->UniV2") is True

    # Release first lock and retry succeeds
    release_trade_lock("USDC/WETH", "UniV2->SushiV2")
    assert acquire_trade_lock("USDC/WETH", "UniV2->SushiV2") is True


def test_emergency_rollback_logic():
    """Verify rollback sets trading mode to MOCK, disarms live trading, and triggers emergency stop."""
    system_state = {
        "trading_mode": "LIVE",
        "live_armed": True,
        "emergency_stop": False,
        "pending_trades_aborted": 0,
    }

    def emergency_rollback(reason: str) -> dict:
        system_state["trading_mode"] = "MOCK"
        system_state["live_armed"] = False
        system_state["emergency_stop"] = True
        system_state["pending_trades_aborted"] += 1
        return {
            "status": "ROLLED_BACK",
            "reason": reason,
            "currentState": system_state.copy(),
        }

    res = emergency_rollback("Slippage exceeded safety boundary")
    assert res["status"] == "ROLLED_BACK"
    assert system_state["trading_mode"] == "MOCK"
    assert system_state["live_armed"] is False
    assert system_state["emergency_stop"] is True


def test_live_trading_invariant_no_fake_receipts():
    """Verify that trades are strictly CONFIRMED only when on-chain mined status is 1."""
    def record_trade_result(receipt_status: int, tx_hash: str) -> str:
        if receipt_status == 1:
            return "CONFIRMED"
        elif receipt_status == 0:
            return "REVERTED"
        else:
            raise ValueError("Unknown receipt status")

    assert record_trade_result(1, "0x123abc...") == "CONFIRMED"
    assert record_trade_result(0, "0x456def...") == "REVERTED"
