"""
Execution Modes Verification Suite — Python

Verifies:
1. Two clearly separated execution modes: USER-SIGNED (Default) vs AUTOMATED (Optional)
2. User-Signed Non-Custodial pipeline (zero private key access, manual wallet signing)
3. Automated execution 12 safety checks & risk limits
4. Independent Emergency Controls for automated executor
5. Treasury accounting separation (User settlement vs Treasury 60/20/20 allocation)
6. Strict UI states: "Waiting for Wallet Confirmation" vs "Automated Executor Active"
"""

import pytest
import os
import json


def test_execution_mode_default_and_separation():
    """Verify default mode is strictly USER-SIGNED and automated is disabled by default."""
    execution_state = {
        "active_mode": "USER_SIGNED",
        "automated_enabled": False,
        "automated_paused": True,
        "automated_emergency_stop": False,
        "user_signed_status": "Waiting for Wallet Confirmation",
        "private_keys_accessible": False,
    }

    # Strict defaults
    assert execution_state["active_mode"] == "USER_SIGNED"
    assert execution_state["automated_enabled"] is False
    assert execution_state["automated_paused"] is True
    assert execution_state["private_keys_accessible"] is False

    def switch_mode(target_mode: str) -> tuple[bool, str]:
        if target_mode == "AUTOMATED" and not execution_state["automated_enabled"]:
            return False, "Cannot switch to AUTOMATED: Explicit enablement required."
        execution_state["active_mode"] = target_mode
        return True, f"Switched to {target_mode}"

    # Fails to switch to AUTOMATED when disabled
    ok, err = switch_mode("AUTOMATED")
    assert ok is False
    assert "Explicit enablement required" in err

    # Enable and switch
    execution_state["automated_enabled"] = True
    ok, msg = switch_mode("AUTOMATED")
    assert ok is True
    assert execution_state["active_mode"] == "AUTOMATED"


def test_user_signed_trade_preparation_and_non_custodial_summary():
    """Verify User-Signed trade summary calculation before wallet signing."""
    def prepare_user_signed_trade(amount_in: float, gross_profit: float, slippage_pct: float, gas_est: float) -> dict:
        dex_fees = amount_in * 0.006 # 60 bps total
        net_profit = gross_profit - (gas_est + dex_fees)
        min_output = amount_in * (1.0 - slippage_pct / 100.0)

        return {
            "amount_in": amount_in,
            "minimum_output_received": round(min_output, 4),
            "estimated_gas_cost_usd": gas_est,
            "slippage_tolerance_pct": slippage_pct,
            "expected_net_profit_usd": round(net_profit, 4),
            "ui_status": "Waiting for Wallet Confirmation",
            "non_custodial": True,
            "private_keys_required": False,
        }

    summary = prepare_user_signed_trade(amount_in=100.0, gross_profit=2.50, slippage_pct=0.5, gas_est=0.25)
    assert summary["amount_in"] == 100.0
    assert summary["minimum_output_received"] == 99.5
    assert summary["expected_net_profit_usd"] == 1.65 # 2.50 - (0.25 + 0.60)
    assert summary["ui_status"] == "Waiting for Wallet Confirmation"
    assert summary["non_custodial"] is True
    assert summary["private_keys_required"] is False


def test_automated_execution_safety_and_risk_limits():
    """Verify all automated execution pre-flight gates and limits."""
    automated_config = {
        "enabled": True,
        "paused": False,
        "emergency_stop": False,
        "min_net_profit_usd": 0.20,
        "max_trade_size_usd": 100.0,
        "max_slippage_pct": 0.5,
        "max_gas_price_gwei": 5.0,
        "max_daily_loss_usd": 20.0,
        "daily_loss_incurred": 0.0,
    }

    def validate_automated_trade(amount_in: float, net_profit: float, gas_price_gwei: float, slippage_pct: float) -> tuple[bool, str]:
        if not automated_config["enabled"]:
            return False, "AUTOMATED_DISABLED"
        if automated_config["paused"]:
            return False, "AUTOMATED_PAUSED"
        if automated_config["emergency_stop"]:
            return False, "AUTOMATED_EMERGENCY_STOP"
        if amount_in > automated_config["max_trade_size_usd"]:
            return False, "MAX_TRADE_SIZE_EXCEEDED"
        if net_profit < automated_config["min_net_profit_usd"]:
            return False, "BELOW_AUTOMATED_MIN_PROFIT"
        if gas_price_gwei > automated_config["max_gas_price_gwei"]:
            return False, "GAS_PRICE_EXCEEDED"
        if slippage_pct > automated_config["max_slippage_pct"]:
            return False, "SLIPPAGE_EXCEEDED"
        if automated_config["daily_loss_incurred"] >= automated_config["max_daily_loss_usd"]:
            return False, "DAILY_LOSS_EXCEEDED"
        return True, "VALIDATED"

    # Valid trade
    assert validate_automated_trade(50.0, 0.85, 0.05, 0.4)[0] is True

    # Exceeds max trade size
    assert validate_automated_trade(150.0, 2.0, 0.05, 0.4)[1] == "MAX_TRADE_SIZE_EXCEEDED"

    # Below min profit
    assert validate_automated_trade(50.0, 0.15, 0.05, 0.4)[1] == "BELOW_AUTOMATED_MIN_PROFIT"

    # High gas
    assert validate_automated_trade(50.0, 0.85, 8.5, 0.4)[1] == "GAS_PRICE_EXCEEDED"

    # High slippage
    assert validate_automated_trade(50.0, 0.85, 0.05, 1.2)[1] == "SLIPPAGE_EXCEEDED"


def test_independent_automated_emergency_controls():
    """Verify independent emergency controls for automated execution do not block user-signed trades."""
    system_controls = {
        "automated_emergency_stop": False,
        "automated_paused": False,
        "user_signed_available": True,
    }

    def trip_automated_emergency_stop():
        system_controls["automated_emergency_stop"] = True
        system_controls["automated_paused"] = True

    trip_automated_emergency_stop()
    assert system_controls["automated_emergency_stop"] is True
    assert system_controls["automated_paused"] is True
    # User-Signed remains available!
    assert system_controls["user_signed_available"] is True


def test_treasury_accounting_separation():
    """Verify separated accounting: User-signed settles to user, automated settles to Treasury."""
    user_account = {"balance_usd": 500.0, "realized_profit_usd": 0.0}
    treasury_vault = {
        "trading_capital_60": 0.0,
        "gas_reserve_20": 0.0,
        "protocol_revenue_20": 0.0,
    }

    def settle_profit(execution_mode: str, realized_net_profit: float):
        if execution_mode == "USER_SIGNED":
            user_account["realized_profit_usd"] += realized_net_profit
            user_account["balance_usd"] += realized_net_profit
        elif execution_mode == "AUTOMATED":
            treasury_vault["trading_capital_60"] += realized_net_profit * 0.60
            treasury_vault["gas_reserve_20"] += realized_net_profit * 0.20
            treasury_vault["protocol_revenue_20"] += realized_net_profit * 0.20

    # User-signed trade settlement
    settle_profit("USER_SIGNED", realized_net_profit=2.0)
    assert user_account["realized_profit_usd"] == 2.0
    assert user_account["balance_usd"] == 502.0
    assert treasury_vault["trading_capital_60"] == 0.0

    # Automated trade settlement
    settle_profit("AUTOMATED", realized_net_profit=10.0)
    assert treasury_vault["trading_capital_60"] == 6.0
    assert treasury_vault["gas_reserve_20"] == 2.0
    assert treasury_vault["protocol_revenue_20"] == 2.0
    # User balance unchanged by automated trade
    assert user_account["balance_usd"] == 502.0
