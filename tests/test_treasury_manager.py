"""
Phase 11: Off-Chain Treasury Manager — Python Test Suite

Tests the TreasuryManager architecture, type structures, configuration,
validation logic, bucket allocation math, and withdrawal limit enforcement.
"""

import pytest
import math
from decimal import Decimal
from typing import Dict, List, Optional
from enum import IntEnum
from dataclasses import dataclass, field


# ─────────────────────────────────────────────────────────────────────────────
# PYTHON TYPE MIRRORS (matching src/treasury/types.ts)
# ─────────────────────────────────────────────────────────────────────────────

class TreasuryBucket(IntEnum):
    """Mirrors the on-chain ITreasury.Bucket enum"""
    TRADING_CAPITAL = 0
    GAS_RESERVE = 1
    PROFIT_RESERVE = 2
    EMERGENCY_RESERVE = 3
    REVENUE = 4


BUCKET_NAMES = {
    TreasuryBucket.TRADING_CAPITAL: "Trading Capital",
    TreasuryBucket.GAS_RESERVE: "Gas Reserve",
    TreasuryBucket.PROFIT_RESERVE: "Profit Reserve",
    TreasuryBucket.EMERGENCY_RESERVE: "Emergency Reserve",
    TreasuryBucket.REVENUE: "Revenue",
}


@dataclass
class OnChainBucketBalances:
    """Raw on-chain balances (in wei / base units)"""
    trading_capital: int = 0
    gas_reserve: int = 0
    profit_reserve: int = 0
    emergency_reserve: int = 0
    revenue: int = 0
    total_realized_profit: int = 0
    total_withdrawn: int = 0


@dataclass
class FormattedBucketBalances:
    """Decimal-adjusted human-readable balances"""
    trading_capital: float = 0.0
    gas_reserve: float = 0.0
    profit_reserve: float = 0.0
    emergency_reserve: float = 0.0
    revenue: float = 0.0
    total_realized_profit: float = 0.0
    total_withdrawn: float = 0.0
    total_balance: float = 0.0


@dataclass
class AllocationRatios:
    """BPS allocation ratios"""
    trading_capital_bps: int = 5000
    gas_reserve_bps: int = 1500
    profit_reserve_bps: int = 1500
    emergency_reserve_bps: int = 1000
    revenue_bps: int = 1000

    @property
    def total(self) -> int:
        return (
            self.trading_capital_bps +
            self.gas_reserve_bps +
            self.profit_reserve_bps +
            self.emergency_reserve_bps +
            self.revenue_bps
        )


@dataclass
class WithdrawalLimits:
    """Per-token withdrawal limits"""
    max_per_tx: int = 0
    max_daily: int = 0
    remaining_daily: int = 0


@dataclass
class WithdrawalRequest:
    """Request to withdraw from treasury"""
    token: str = ""
    amount: int = 0
    recipient: str = ""
    bucket: TreasuryBucket = TreasuryBucket.REVENUE
    reason: str = ""


@dataclass
class DepositRequest:
    """Request to deposit into treasury"""
    token: str = ""
    amount: int = 0
    bucket: TreasuryBucket = TreasuryBucket.TRADING_CAPITAL


@dataclass
class TreasuryManagerConfig:
    """Configuration for TreasuryManager"""
    treasury_address: str = ""
    chain_id: int = 84532
    rpc_url: str = "https://sepolia.base.org"
    private_key: Optional[str] = None
    default_token_address: str = "0x0000000000000000000000000000000000000000"
    default_token_decimals: int = 18
    polling_interval_ms: int = 30000
    max_retries: int = 3
    retry_delay_ms: int = 1000


@dataclass
class TreasuryHealthStatus:
    """Comprehensive health check"""
    healthy: bool = True
    paused: bool = False
    total_value_usd: float = 0.0
    buckets: FormattedBucketBalances = field(default_factory=FormattedBucketBalances)
    allocation_ratios: AllocationRatios = field(default_factory=AllocationRatios)
    warnings: List[str] = field(default_factory=list)
    last_checked: int = 0


# ─────────────────────────────────────────────────────────────────────────────
# HELPER FUNCTIONS
# ─────────────────────────────────────────────────────────────────────────────

def format_units(value: int, decimals: int = 18) -> float:
    """Convert raw integer to decimal-adjusted float"""
    return value / (10 ** decimals)


def parse_units(value: float, decimals: int = 18) -> int:
    """Convert float to raw integer with decimals"""
    return int(Decimal(str(value)) * Decimal(10 ** decimals))


def calculate_allocation(amount: int, ratios: AllocationRatios) -> OnChainBucketBalances:
    """Calculate how depositProfit distributes across 5 buckets"""
    bps_denom = 10000
    tc = (amount * ratios.trading_capital_bps) // bps_denom
    gr = (amount * ratios.gas_reserve_bps) // bps_denom
    pr = (amount * ratios.profit_reserve_bps) // bps_denom
    er = (amount * ratios.emergency_reserve_bps) // bps_denom
    rv = amount - tc - gr - pr - er  # Remainder to revenue (dust handling)
    return OnChainBucketBalances(
        trading_capital=tc,
        gas_reserve=gr,
        profit_reserve=pr,
        emergency_reserve=er,
        revenue=rv,
        total_realized_profit=amount,
        total_withdrawn=0,
    )


def format_balances(raw: OnChainBucketBalances, decimals: int = 18) -> FormattedBucketBalances:
    """Convert raw balances to formatted balances"""
    tc = format_units(raw.trading_capital, decimals)
    gr = format_units(raw.gas_reserve, decimals)
    pr = format_units(raw.profit_reserve, decimals)
    er = format_units(raw.emergency_reserve, decimals)
    rv = format_units(raw.revenue, decimals)
    return FormattedBucketBalances(
        trading_capital=tc,
        gas_reserve=gr,
        profit_reserve=pr,
        emergency_reserve=er,
        revenue=rv,
        total_realized_profit=format_units(raw.total_realized_profit, decimals),
        total_withdrawn=format_units(raw.total_withdrawn, decimals),
        total_balance=tc + gr + pr + er + rv,
    )


def validate_withdrawal(
    request: WithdrawalRequest,
    balances: OnChainBucketBalances,
    limits: WithdrawalLimits,
    is_whitelisted: bool = True,
    has_role: bool = True,
) -> Optional[str]:
    """Validates a withdrawal request, returns error message or None"""
    if not is_whitelisted:
        return f"Token {request.token} is not whitelisted"

    bucket_balance = {
        TreasuryBucket.TRADING_CAPITAL: balances.trading_capital,
        TreasuryBucket.GAS_RESERVE: balances.gas_reserve,
        TreasuryBucket.PROFIT_RESERVE: balances.profit_reserve,
        TreasuryBucket.EMERGENCY_RESERVE: balances.emergency_reserve,
        TreasuryBucket.REVENUE: balances.revenue,
    }.get(request.bucket, 0)

    if bucket_balance < request.amount:
        return f"Insufficient {BUCKET_NAMES[request.bucket]} balance"

    if limits.max_per_tx > 0 and request.amount > limits.max_per_tx:
        return "Amount exceeds per-transaction limit"

    if limits.max_daily > 0 and request.amount > limits.remaining_daily:
        return "Amount exceeds remaining daily limit"

    if not has_role:
        return "Signer does not have TREASURY_MANAGER_ROLE"

    return None


def check_health(
    paused: bool,
    balances: FormattedBucketBalances,
    ratios: AllocationRatios,
) -> TreasuryHealthStatus:
    """Simulates health check logic"""
    warnings = []
    if paused:
        warnings.append("Treasury contract is PAUSED")
    if ratios.total != 10000:
        warnings.append(f"Allocation ratios sum to {ratios.total}")
    if balances.gas_reserve < 0.01:
        warnings.append("Gas Reserve is critically low")
    if balances.trading_capital < 1.0:
        warnings.append("Trading Capital below minimum")
    
    return TreasuryHealthStatus(
        healthy=not paused and len(warnings) == 0,
        paused=paused,
        total_value_usd=balances.total_balance,
        buckets=balances,
        allocation_ratios=ratios,
        warnings=warnings,
        last_checked=1700000000,
    )


# ─────────────────────────────────────────────────────────────────────────────
# TEST SUITE
# ─────────────────────────────────────────────────────────────────────────────

class TestTreasuryBucket:
    """Test TreasuryBucket enum mirrors on-chain values"""

    def test_enum_values(self):
        assert TreasuryBucket.TRADING_CAPITAL == 0
        assert TreasuryBucket.GAS_RESERVE == 1
        assert TreasuryBucket.PROFIT_RESERVE == 2
        assert TreasuryBucket.EMERGENCY_RESERVE == 3
        assert TreasuryBucket.REVENUE == 4

    def test_bucket_names(self):
        assert BUCKET_NAMES[TreasuryBucket.TRADING_CAPITAL] == "Trading Capital"
        assert BUCKET_NAMES[TreasuryBucket.GAS_RESERVE] == "Gas Reserve"
        assert BUCKET_NAMES[TreasuryBucket.PROFIT_RESERVE] == "Profit Reserve"
        assert BUCKET_NAMES[TreasuryBucket.EMERGENCY_RESERVE] == "Emergency Reserve"
        assert BUCKET_NAMES[TreasuryBucket.REVENUE] == "Revenue"

    def test_all_buckets_have_names(self):
        for bucket in TreasuryBucket:
            assert bucket in BUCKET_NAMES


class TestAllocationCalculation:
    """Test profit allocation across 5 buckets"""

    def test_default_allocation_ratios(self):
        ratios = AllocationRatios()
        assert ratios.total == 10000

    def test_default_50_15_15_10_10_split(self):
        """Default: 50% TC, 15% GR, 15% PR, 10% ER, 10% RV"""
        amount = parse_units(1000, 18)  # 1000 tokens
        ratios = AllocationRatios()
        result = calculate_allocation(amount, ratios)

        formatted = format_balances(result, 18)
        assert formatted.trading_capital == pytest.approx(500.0, rel=1e-9)
        assert formatted.gas_reserve == pytest.approx(150.0, rel=1e-9)
        assert formatted.profit_reserve == pytest.approx(150.0, rel=1e-9)
        assert formatted.emergency_reserve == pytest.approx(100.0, rel=1e-9)
        assert formatted.revenue == pytest.approx(100.0, rel=1e-9)
        assert formatted.total_balance == pytest.approx(1000.0, rel=1e-9)

    def test_custom_allocation_ratios(self):
        """Custom: 60% TC, 10% GR, 10% PR, 10% ER, 10% RV"""
        amount = parse_units(500, 18)
        ratios = AllocationRatios(
            trading_capital_bps=6000,
            gas_reserve_bps=1000,
            profit_reserve_bps=1000,
            emergency_reserve_bps=1000,
            revenue_bps=1000,
        )
        assert ratios.total == 10000
        result = calculate_allocation(amount, ratios)
        formatted = format_balances(result, 18)
        assert formatted.trading_capital == pytest.approx(300.0, rel=1e-9)
        assert formatted.gas_reserve == pytest.approx(50.0, rel=1e-9)

    def test_small_amount_dust_handling(self):
        """Revenue bucket absorbs rounding dust"""
        amount = 7  # Very small — indivisible by 10000
        ratios = AllocationRatios()
        result = calculate_allocation(amount, ratios)
        total = (
            result.trading_capital +
            result.gas_reserve +
            result.profit_reserve +
            result.emergency_reserve +
            result.revenue
        )
        assert total == amount  # No dust lost

    def test_zero_amount(self):
        result = calculate_allocation(0, AllocationRatios())
        assert result.trading_capital == 0
        assert result.revenue == 0

    def test_allocation_preserves_total(self):
        """For any amount, sum of buckets must equal input amount"""
        for amount_tokens in [0.01, 1.0, 100.0, 999.99, 1000000.0]:
            amount = parse_units(amount_tokens, 18)
            result = calculate_allocation(amount, AllocationRatios())
            total = (
                result.trading_capital +
                result.gas_reserve +
                result.profit_reserve +
                result.emergency_reserve +
                result.revenue
            )
            assert total == amount, f"Failed for {amount_tokens}"

    def test_different_decimals(self):
        """Test with USDC (6 decimals)"""
        amount = parse_units(1000, 6)  # 1000 USDC
        result = calculate_allocation(amount, AllocationRatios())
        formatted = format_balances(result, 6)
        assert formatted.trading_capital == pytest.approx(500.0, rel=1e-6)


class TestFormatBalances:
    """Test raw → formatted conversion"""

    def test_18_decimal_conversion(self):
        raw = OnChainBucketBalances(
            trading_capital=10 ** 18,  # 1.0
            gas_reserve=5 * 10 ** 17,  # 0.5
        )
        formatted = format_balances(raw, 18)
        assert formatted.trading_capital == pytest.approx(1.0)
        assert formatted.gas_reserve == pytest.approx(0.5)

    def test_6_decimal_conversion(self):
        raw = OnChainBucketBalances(
            trading_capital=1_000_000,  # 1.0 USDC
            revenue=500_000,  # 0.5 USDC
        )
        formatted = format_balances(raw, 6)
        assert formatted.trading_capital == pytest.approx(1.0)
        assert formatted.revenue == pytest.approx(0.5)

    def test_total_balance_is_sum_of_five(self):
        raw = OnChainBucketBalances(
            trading_capital=100,
            gas_reserve=200,
            profit_reserve=300,
            emergency_reserve=400,
            revenue=500,
        )
        formatted = format_balances(raw, 0)
        expected = 100 + 200 + 300 + 400 + 500
        assert formatted.total_balance == pytest.approx(expected)


class TestWithdrawalValidation:
    """Test withdrawal pre-flight validation"""

    def setup_method(self):
        self.balances = OnChainBucketBalances(
            trading_capital=parse_units(500, 18),
            gas_reserve=parse_units(150, 18),
            profit_reserve=parse_units(150, 18),
            emergency_reserve=parse_units(100, 18),
            revenue=parse_units(100, 18),
        )
        self.limits = WithdrawalLimits(
            max_per_tx=parse_units(100, 18),
            max_daily=parse_units(500, 18),
            remaining_daily=parse_units(300, 18),
        )

    def test_valid_withdrawal(self):
        request = WithdrawalRequest(
            token="0xUSDC",
            amount=parse_units(50, 18),
            recipient="0xRecipient",
            bucket=TreasuryBucket.REVENUE,
            reason="Revenue extraction",
        )
        result = validate_withdrawal(request, self.balances, self.limits)
        assert result is None

    def test_reject_not_whitelisted(self):
        request = WithdrawalRequest(
            token="0xBadToken",
            amount=parse_units(10, 18),
            recipient="0xRecipient",
            bucket=TreasuryBucket.REVENUE,
            reason="Test",
        )
        result = validate_withdrawal(request, self.balances, self.limits, is_whitelisted=False)
        assert result is not None
        assert "not whitelisted" in result

    def test_reject_insufficient_balance(self):
        request = WithdrawalRequest(
            token="0xUSDC",
            amount=parse_units(200, 18),  # Revenue only has 100
            recipient="0xRecipient",
            bucket=TreasuryBucket.REVENUE,
            reason="Too much",
        )
        result = validate_withdrawal(request, self.balances, self.limits)
        assert result is not None
        assert "Insufficient" in result

    def test_reject_exceeds_per_tx_limit(self):
        request = WithdrawalRequest(
            token="0xUSDC",
            amount=parse_units(150, 18),  # Limit is 100 per tx
            recipient="0xRecipient",
            bucket=TreasuryBucket.TRADING_CAPITAL,
            reason="Over limit",
        )
        result = validate_withdrawal(request, self.balances, self.limits)
        assert result is not None
        assert "per-transaction limit" in result

    def test_reject_exceeds_daily_limit(self):
        request = WithdrawalRequest(
            token="0xUSDC",
            amount=parse_units(99, 18),  # Within per-tx but...
            recipient="0xRecipient",
            bucket=TreasuryBucket.TRADING_CAPITAL,
            reason="Daily limit test",
        )
        limits = WithdrawalLimits(
            max_per_tx=parse_units(100, 18),
            max_daily=parse_units(500, 18),
            remaining_daily=parse_units(50, 18),  # Only 50 remaining
        )
        result = validate_withdrawal(request, self.balances, limits)
        assert result is not None
        assert "daily limit" in result

    def test_reject_no_role(self):
        request = WithdrawalRequest(
            token="0xUSDC",
            amount=parse_units(10, 18),
            recipient="0xRecipient",
            bucket=TreasuryBucket.REVENUE,
            reason="No role",
        )
        result = validate_withdrawal(request, self.balances, self.limits, has_role=False)
        assert result is not None
        assert "TREASURY_MANAGER_ROLE" in result

    def test_accept_unlimited_per_tx(self):
        """When maxPerTx is 0, no per-tx limit is enforced"""
        request = WithdrawalRequest(
            token="0xUSDC",
            amount=parse_units(99, 18),
            recipient="0xRecipient",
            bucket=TreasuryBucket.REVENUE,
            reason="No per-tx limit",
        )
        limits = WithdrawalLimits(max_per_tx=0, max_daily=0, remaining_daily=0)
        result = validate_withdrawal(request, self.balances, limits)
        assert result is None

    def test_each_bucket_checked_independently(self):
        """Verify each bucket's balance is checked separately"""
        for bucket, balance_attr in [
            (TreasuryBucket.TRADING_CAPITAL, "trading_capital"),
            (TreasuryBucket.GAS_RESERVE, "gas_reserve"),
            (TreasuryBucket.PROFIT_RESERVE, "profit_reserve"),
            (TreasuryBucket.EMERGENCY_RESERVE, "emergency_reserve"),
            (TreasuryBucket.REVENUE, "revenue"),
        ]:
            bucket_balance = getattr(self.balances, balance_attr)
            # Try to withdraw exactly the bucket balance — should pass
            request = WithdrawalRequest(
                token="0xUSDC",
                amount=bucket_balance,
                recipient="0xRecipient",
                bucket=bucket,
                reason="Exact balance",
            )
            # Use unlimited limits for this test
            limits = WithdrawalLimits(max_per_tx=0, max_daily=0, remaining_daily=0)
            result = validate_withdrawal(request, self.balances, limits)
            assert result is None, f"Should pass for {BUCKET_NAMES[bucket]}"


class TestHealthCheck:
    """Test treasury health check logic"""

    def test_healthy_when_all_good(self):
        balances = FormattedBucketBalances(
            trading_capital=500,
            gas_reserve=150,
            profit_reserve=150,
            emergency_reserve=100,
            revenue=100,
            total_balance=1000,
        )
        health = check_health(False, balances, AllocationRatios())
        assert health.healthy is True
        assert health.paused is False
        assert len(health.warnings) == 0

    def test_unhealthy_when_paused(self):
        balances = FormattedBucketBalances(
            trading_capital=500, gas_reserve=150, total_balance=650
        )
        health = check_health(True, balances, AllocationRatios())
        assert health.healthy is False
        assert health.paused is True
        assert any("PAUSED" in w for w in health.warnings)

    def test_warning_on_invalid_ratios(self):
        balances = FormattedBucketBalances(
            trading_capital=500, gas_reserve=150, total_balance=650
        )
        bad_ratios = AllocationRatios(
            trading_capital_bps=5000,
            gas_reserve_bps=1500,
            profit_reserve_bps=1500,
            emergency_reserve_bps=1000,
            revenue_bps=500,  # Total = 9500, not 10000
        )
        health = check_health(False, balances, bad_ratios)
        assert health.healthy is False
        assert any("9500" in w for w in health.warnings)

    def test_warning_on_low_gas_reserve(self):
        balances = FormattedBucketBalances(
            trading_capital=500,
            gas_reserve=0.005,  # Below 0.01 threshold
            total_balance=500.005,
        )
        health = check_health(False, balances, AllocationRatios())
        assert any("Gas Reserve" in w for w in health.warnings)

    def test_warning_on_low_trading_capital(self):
        balances = FormattedBucketBalances(
            trading_capital=0.5,  # Below 1.0 threshold
            gas_reserve=150,
            total_balance=150.5,
        )
        health = check_health(False, balances, AllocationRatios())
        assert any("Trading Capital" in w for w in health.warnings)

    def test_total_value_matches_balance(self):
        balances = FormattedBucketBalances(
            trading_capital=500,
            gas_reserve=150,
            profit_reserve=150,
            emergency_reserve=100,
            revenue=100,
            total_balance=1000,
        )
        health = check_health(False, balances, AllocationRatios())
        assert health.total_value_usd == 1000


class TestConfigDefaults:
    """Test TreasuryManagerConfig defaults"""

    def test_default_values(self):
        config = TreasuryManagerConfig()
        assert config.chain_id == 84532
        assert config.default_token_decimals == 18
        assert config.polling_interval_ms == 30000
        assert config.max_retries == 3
        assert config.retry_delay_ms == 1000
        assert config.private_key is None

    def test_read_only_without_private_key(self):
        config = TreasuryManagerConfig()
        assert config.private_key is None

    def test_write_with_private_key(self):
        config = TreasuryManagerConfig(
            private_key="0x0000000000000000000000000000000000000000000000000000000000000001"
        )
        assert config.private_key is not None


class TestFormatAndParseUnits:
    """Test format_units and parse_units helpers"""

    def test_format_18_decimals(self):
        assert format_units(10 ** 18, 18) == 1.0
        assert format_units(5 * 10 ** 17, 18) == 0.5

    def test_format_6_decimals(self):
        assert format_units(1_000_000, 6) == 1.0
        assert format_units(500_000, 6) == 0.5

    def test_parse_18_decimals(self):
        assert parse_units(1.0, 18) == 10 ** 18
        assert parse_units(0.5, 18) == 5 * 10 ** 17

    def test_parse_6_decimals(self):
        assert parse_units(1.0, 6) == 1_000_000
        assert parse_units(0.5, 6) == 500_000

    def test_round_trip(self):
        """parse → format should return original"""
        for val in [0.01, 1.0, 100.0, 999.99]:
            for dec in [6, 18]:
                raw = parse_units(val, dec)
                back = format_units(raw, dec)
                assert back == pytest.approx(val, rel=1e-9)


class TestRoleHashes:
    """Test that role hash constants match keccak256 outputs"""

    def test_admin_role_hash(self):
        import hashlib
        from eth_abi.packed import encode_packed
        from eth_hash.auto import keccak

        expected = keccak(b"ADMIN_ROLE").hex()
        assert expected == "a49807205ce4d355092ef5a8a18f56e8913cf4a201fbe287825b095693c21775"

    def test_pauser_role_hash(self):
        from eth_hash.auto import keccak

        expected = keccak(b"PAUSER_ROLE").hex()
        assert expected == "65d7a28e3265b37a6474929f336521b332c1681b933f6cb9f3376673440d862a"


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
