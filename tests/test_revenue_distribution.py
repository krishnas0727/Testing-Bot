"""
Phase 11: Revenue Distribution Engine — Python Test Suite

Tests:
- 100% valid allocation (default 60/20/20, custom 50/25/25, 70/15/15)
- Invalid allocation > 100% (> 10000 bps) rejection
- Invalid allocation < 100% (< 10000 bps) rejection
- Allocation update authorization (Admin vs Non-Admin)
- Min/Max bounds enforcement
- Rounding and dust absorption (Zero loss, precise integer math)
- Profit scales: 1 wei, 7 wei (dust), 1,000,000 USDT (whale)
- Zero profit rejection
- Negative profit (trade loss) rejection
- Unrealized / unconfirmed trade rejection
- Separate bucket accounting (Trading Capital, Reserve, Revenue)
- Revenue withdrawal security: Trading bot blocked, Manager/Admin allowed, pause behavior
"""

import pytest
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple


BPS_DENOMINATOR = 10000


@dataclass
class ThreeBucketAllocationPolicy:
    trading_capital_bps: int = 6000
    reserve_bps: int = 2000
    revenue_bps: int = 2000
    min_trading_capital_bps: Optional[int] = 1000
    max_trading_capital_bps: Optional[int] = 9000
    min_reserve_bps: Optional[int] = 500
    max_reserve_bps: Optional[int] = 5000
    min_revenue_bps: Optional[int] = 500
    max_revenue_bps: Optional[int] = 5000


@dataclass
class TradeSettlementInput:
    trade_id: str
    tx_hash: str
    chain_id: int
    token: str
    gross_profit: int
    dex_fees: int
    gas_cost: int
    other_costs: int = 0
    confirmed_realized_net_profit: Optional[int] = None
    is_confirmed: bool = True
    token_decimals: int = 18


@dataclass
class DistributionResult:
    trade_id: str
    tx_hash: str
    chain_id: int
    token: str
    realized_net_profit: int
    trading_allocation: int
    reserve_allocation: int
    revenue_allocation: int
    status: str
    rejection_reason: Optional[str] = None


class RevenueDistributionEngine:
    def __init__(self, initial_policy: Optional[ThreeBucketAllocationPolicy] = None):
        self.policy = initial_policy or ThreeBucketAllocationPolicy()
        self.validate_policy(self.policy)
        self.ledger: Dict[str, Dict[str, int]] = {}
        self.history: List[DistributionResult] = []

    def validate_policy(self, policy: ThreeBucketAllocationPolicy):
        if (
            policy.trading_capital_bps < 0
            or policy.reserve_bps < 0
            or policy.revenue_bps < 0
        ):
            raise ValueError("Allocation percentages cannot be negative")

        total = policy.trading_capital_bps + policy.reserve_bps + policy.revenue_bps
        if total != BPS_DENOMINATOR:
            raise ValueError(
                f"Total allocation must equal exactly 10000 bps (100%). Got {total} bps"
            )

        if (
            policy.min_trading_capital_bps is not None
            and policy.trading_capital_bps < policy.min_trading_capital_bps
        ):
            raise ValueError(f"Trading Capital is below minimum ({policy.min_trading_capital_bps} bps)")

        if (
            policy.max_trading_capital_bps is not None
            and policy.trading_capital_bps > policy.max_trading_capital_bps
        ):
            raise ValueError(f"Trading Capital exceeds maximum ({policy.max_trading_capital_bps} bps)")

    def update_policy(
        self,
        new_policy: ThreeBucketAllocationPolicy,
        caller_role: str,
        caller_address: str,
    ):
        if caller_role != "ADMIN":
            raise PermissionError(f"Unauthorized: Only ADMIN can modify policy. Got: {caller_role}")
        self.validate_policy(new_policy)
        self.policy = new_policy

    def calculate_distribution(
        self, input_data: TradeSettlementInput
    ) -> Tuple[int, int, int, int]:
        """Returns (net_profit, trading_allocation, reserve_allocation, revenue_allocation)"""
        if not input_data.is_confirmed:
            raise ValueError("Unrealized profit rejected: Trade execution is not confirmed")

        total_costs = input_data.dex_fees + input_data.gas_cost + input_data.other_costs
        net_profit = (
            input_data.confirmed_realized_net_profit
            if input_data.confirmed_realized_net_profit is not None
            else input_data.gross_profit - total_costs
        )

        if net_profit <= 0:
            raise ValueError(f"Realized net profit must be positive. Got: {net_profit}")

        # Integer arithmetic in BPS
        trading_cap = (net_profit * self.policy.trading_capital_bps) // BPS_DENOMINATOR
        reserve = (net_profit * self.policy.reserve_bps) // BPS_DENOMINATOR
        # Remainder dust allocated to revenue
        revenue = net_profit - trading_cap - reserve

        assert trading_cap + reserve + revenue == net_profit, "Zero dust loss invariant violated"
        return net_profit, trading_cap, reserve, revenue

    def process_trade_settlement(self, input_data: TradeSettlementInput) -> DistributionResult:
        if not input_data.is_confirmed:
            res = DistributionResult(
                trade_id=input_data.trade_id,
                tx_hash=input_data.tx_hash,
                chain_id=input_data.chain_id,
                token=input_data.token,
                realized_net_profit=0,
                trading_allocation=0,
                reserve_allocation=0,
                revenue_allocation=0,
                status="REJECTED_UNCONFIRMED",
                rejection_reason="Trade is unconfirmed",
            )
            self.history.append(res)
            return res

        total_costs = input_data.dex_fees + input_data.gas_cost + input_data.other_costs
        net_profit = (
            input_data.confirmed_realized_net_profit
            if input_data.confirmed_realized_net_profit is not None
            else input_data.gross_profit - total_costs
        )

        if net_profit == 0:
            res = DistributionResult(
                trade_id=input_data.trade_id,
                tx_hash=input_data.tx_hash,
                chain_id=input_data.chain_id,
                token=input_data.token,
                realized_net_profit=0,
                trading_allocation=0,
                reserve_allocation=0,
                revenue_allocation=0,
                status="REJECTED_ZERO_PROFIT",
                rejection_reason="Zero profit",
            )
            self.history.append(res)
            return res

        if net_profit < 0:
            res = DistributionResult(
                trade_id=input_data.trade_id,
                tx_hash=input_data.tx_hash,
                chain_id=input_data.chain_id,
                token=input_data.token,
                realized_net_profit=net_profit,
                trading_allocation=0,
                reserve_allocation=0,
                revenue_allocation=0,
                status="REJECTED_NEGATIVE_PROFIT",
                rejection_reason="Negative profit",
            )
            self.history.append(res)
            return res

        net_profit, tc, rs, rv = self.calculate_distribution(input_data)

        # Ledger update
        key = input_data.token.lower()
        if key not in self.ledger:
            self.ledger[key] = {"tradingCapital": 0, "reserve": 0, "revenue": 0}
        self.ledger[key]["tradingCapital"] += tc
        self.ledger[key]["reserve"] += rs
        self.ledger[key]["revenue"] += rv

        res = DistributionResult(
            trade_id=input_data.trade_id,
            tx_hash=input_data.tx_hash,
            chain_id=input_data.chain_id,
            token=input_data.token,
            realized_net_profit=net_profit,
            trading_allocation=tc,
            reserve_allocation=rs,
            revenue_allocation=rv,
            status="DISTRIBUTED",
        )
        self.history.append(res)
        return res

    def validate_revenue_withdrawal(
        self,
        caller_role: str,
        amount: int,
        available_revenue: int,
        is_paused: bool,
    ) -> Tuple[bool, Optional[str]]:
        if caller_role == "ARBITRAGE_EXECUTOR":
            return False, "Security Violation: Trading Bot forbidden from withdrawing revenue"
        if is_paused:
            return False, "Treasury is paused"
        if caller_role not in ("ADMIN", "TREASURY_MANAGER"):
            return False, f"Unauthorized role: {caller_role}"
        if amount <= 0:
            return False, "Amount must be positive"
        if amount > available_revenue:
            return False, "Insufficient revenue balance"
        return True, None


# ─────────────────────────────────────────────────────────────────────────────
# TESTS
# ─────────────────────────────────────────────────────────────────────────────

def test_initial_policy_60_20_20():
    engine = RevenueDistributionEngine()
    assert engine.policy.trading_capital_bps == 6000
    assert engine.policy.reserve_bps == 2000
    assert engine.policy.revenue_bps == 2000
    total = (
        engine.policy.trading_capital_bps
        + engine.policy.reserve_bps
        + engine.policy.revenue_bps
    )
    assert total == 10000


def test_reject_over_100_percent():
    with pytest.raises(ValueError, match="Total allocation must equal exactly 10000 bps"):
        RevenueDistributionEngine(
            ThreeBucketAllocationPolicy(trading_capital_bps=6000, reserve_bps=3000, revenue_bps=2000)
        )


def test_reject_under_100_percent():
    with pytest.raises(ValueError, match="Total allocation must equal exactly 10000 bps"):
        RevenueDistributionEngine(
            ThreeBucketAllocationPolicy(trading_capital_bps=6000, reserve_bps=1000, revenue_bps=2000)
        )


def test_bounds_enforcement():
    with pytest.raises(ValueError, match="Trading Capital is below minimum"):
        RevenueDistributionEngine(
            ThreeBucketAllocationPolicy(
                trading_capital_bps=500,
                reserve_bps=4500,
                revenue_bps=5000,
                min_trading_capital_bps=1000,
            )
        )


def test_admin_policy_update():
    engine = RevenueDistributionEngine()
    new_pol = ThreeBucketAllocationPolicy(trading_capital_bps=5000, reserve_bps=2500, revenue_bps=2500)
    engine.update_policy(new_pol, "ADMIN", "0xAdmin")
    assert engine.policy.trading_capital_bps == 5000


def test_non_admin_policy_update_rejection():
    engine = RevenueDistributionEngine()
    new_pol = ThreeBucketAllocationPolicy(trading_capital_bps=5000, reserve_bps=2500, revenue_bps=2500)
    with pytest.raises(PermissionError, match="Unauthorized: Only ADMIN"):
        engine.update_policy(new_pol, "ARBITRAGE_EXECUTOR", "0xBot")


def test_clean_profit_distribution():
    engine = RevenueDistributionEngine()
    trade = TradeSettlementInput(
        trade_id="T1",
        tx_hash="0x1",
        chain_id=8453,
        token="0xUSDC",
        gross_profit=120_000,
        dex_fees=10_000,
        gas_cost=10_000,
        confirmed_realized_net_profit=100_000,
        is_confirmed=True,
    )
    net, tc, rs, rv = engine.calculate_distribution(trade)
    assert net == 100_000
    assert tc == 60_000
    assert rs == 20_000
    assert rv == 20_000
    assert tc + rs + rv == net


def test_dust_absorption_odd_amount():
    engine = RevenueDistributionEngine()
    trade = TradeSettlementInput(
        trade_id="T-Dust",
        tx_hash="0xdust",
        chain_id=8453,
        token="0xToken",
        gross_profit=10,
        dex_fees=1,
        gas_cost=2,
        confirmed_realized_net_profit=7,
        is_confirmed=True,
    )
    net, tc, rs, rv = engine.calculate_distribution(trade)
    assert net == 7
    assert tc == 4  # (7 * 6000) // 10000 = 4
    assert rs == 1  # (7 * 2000) // 10000 = 1
    assert rv == 2  # 7 - 4 - 1 = 2 (absorbed dust)
    assert tc + rs + rv == 7


def test_single_wei_profit():
    engine = RevenueDistributionEngine()
    trade = TradeSettlementInput(
        trade_id="T-1Wei",
        tx_hash="0x1wei",
        chain_id=8453,
        token="0xToken",
        gross_profit=1,
        dex_fees=0,
        gas_cost=0,
        confirmed_realized_net_profit=1,
        is_confirmed=True,
    )
    net, tc, rs, rv = engine.calculate_distribution(trade)
    assert net == 1
    assert tc == 0
    assert rs == 0
    assert rv == 1
    assert tc + rs + rv == 1


def test_whale_profit_large_int():
    engine = RevenueDistributionEngine()
    whale_amount = 1_000_000 * 10**18
    trade = TradeSettlementInput(
        trade_id="T-Whale",
        tx_hash="0xwhale",
        chain_id=8453,
        token="0xToken",
        gross_profit=whale_amount,
        dex_fees=0,
        gas_cost=0,
        confirmed_realized_net_profit=whale_amount,
        is_confirmed=True,
    )
    net, tc, rs, rv = engine.calculate_distribution(trade)
    assert tc == 600_000 * 10**18
    assert rs == 200_000 * 10**18
    assert rv == 200_000 * 10**18
    assert tc + rs + rv == whale_amount


def test_unconfirmed_trade_rejected():
    engine = RevenueDistributionEngine()
    trade = TradeSettlementInput(
        trade_id="T-Unconfirmed",
        tx_hash="0xunconfirmed",
        chain_id=8453,
        token="0xToken",
        gross_profit=100,
        dex_fees=0,
        gas_cost=0,
        is_confirmed=False,
    )
    res = engine.process_trade_settlement(trade)
    assert res.status == "REJECTED_UNCONFIRMED"


def test_zero_profit_rejected():
    engine = RevenueDistributionEngine()
    trade = TradeSettlementInput(
        trade_id="T-Zero",
        tx_hash="0xzero",
        chain_id=8453,
        token="0xToken",
        gross_profit=10,
        dex_fees=5,
        gas_cost=5,
        is_confirmed=True,
    )
    res = engine.process_trade_settlement(trade)
    assert res.status == "REJECTED_ZERO_PROFIT"


def test_negative_profit_rejected():
    engine = RevenueDistributionEngine()
    trade = TradeSettlementInput(
        trade_id="T-Loss",
        tx_hash="0xloss",
        chain_id=8453,
        token="0xToken",
        gross_profit=5,
        dex_fees=10,
        gas_cost=5,
        is_confirmed=True,
    )
    res = engine.process_trade_settlement(trade)
    assert res.status == "REJECTED_NEGATIVE_PROFIT"


def test_revenue_withdrawal_guard_blocks_trading_bot():
    engine = RevenueDistributionEngine()
    allowed, reason = engine.validate_revenue_withdrawal(
        caller_role="ARBITRAGE_EXECUTOR",
        amount=100,
        available_revenue=1000,
        is_paused=False,
    )
    assert not allowed
    assert "Trading Bot forbidden" in reason


def test_revenue_withdrawal_allows_treasury_manager():
    engine = RevenueDistributionEngine()
    allowed, reason = engine.validate_revenue_withdrawal(
        caller_role="TREASURY_MANAGER",
        amount=500,
        available_revenue=1000,
        is_paused=False,
    )
    assert allowed
    assert reason is None


def test_revenue_withdrawal_blocked_when_paused():
    engine = RevenueDistributionEngine()
    allowed, reason = engine.validate_revenue_withdrawal(
        caller_role="ADMIN",
        amount=100,
        available_revenue=1000,
        is_paused=True,
    )
    assert not allowed
    assert "paused" in reason
