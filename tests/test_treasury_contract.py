import unittest
import time


class MockTreasuryContractPython:
    """Python simulation replicating Treasury.sol logic and accounting."""

    BPS_DENOMINATOR = 10000

    def __init__(self, admin: str, executor: str):
        self.admin = admin
        self.roles = {
            "ADMIN_ROLE": {admin},
            "TREASURY_MANAGER_ROLE": {admin},
            "ARBITRAGE_EXECUTOR_ROLE": {executor} if executor else set(),
            "PAUSER_ROLE": {admin},
        }
        self.paused = False

        # Allocation percentages (BPS)
        self.trading_capital_bps = 5000     # 50%
        self.gas_reserve_bps = 1500         # 15%
        self.profit_reserve_bps = 1500      # 15%
        self.emergency_reserve_bps = 1000   # 10%
        self.revenue_bps = 1000            # 10%

        # Accounting: token => {bucket: amount}
        self.token_ledger = {}
        self.token_whitelist = set()
        self.withdrawal_limits = {} # token => {"max_per_tx": X, "max_daily": Y}
        self.daily_withdrawn = {}   # token => {day_index: amount}

    def has_role(self, role: str, account: str) -> bool:
        return account in self.roles.get(role, set()) or account in self.roles.get("ADMIN_ROLE", set())

    def grant_role(self, caller: str, role: str, account: str):
        if not self.has_role("ADMIN_ROLE", caller):
            raise PermissionError("Unauthorized: only ADMIN can grant roles")
        self.roles.setdefault(role, set()).add(account)

    def revoke_role(self, caller: str, role: str, account: str):
        if not self.has_role("ADMIN_ROLE", caller):
            raise PermissionError("Unauthorized: only ADMIN can revoke roles")
        if role in self.roles:
            self.roles[role].discard(account)

    def set_token_whitelist(self, caller: str, token: str, status: bool):
        if not self.has_role("TREASURY_MANAGER_ROLE", caller):
            raise PermissionError("Unauthorized: only TREASURY_MANAGER can set token whitelist")
        if status:
            self.token_whitelist.add(token)
        else:
            self.token_whitelist.discard(token)

    def set_withdrawal_limits(self, caller: str, token: str, max_per_tx: float, max_daily: float):
        if not self.has_role("ADMIN_ROLE", caller):
            raise PermissionError("Unauthorized: only ADMIN can set limits")
        self.withdrawal_limits[token] = {"max_per_tx": max_per_tx, "max_daily": max_daily}

    def pause(self, caller: str):
        if not self.has_role("PAUSER_ROLE", caller):
            raise PermissionError("Unauthorized: only PAUSER can pause")
        self.paused = True

    def unpause(self, caller: str):
        if not self.has_role("PAUSER_ROLE", caller):
            raise PermissionError("Unauthorized: only PAUSER can unpause")
        self.paused = False

    def deposit_profit(self, caller: str, token: str, amount: float):
        if self.paused:
            raise RuntimeError("ContractPaused")
        if not self.has_role("ARBITRAGE_EXECUTOR_ROLE", caller):
            raise PermissionError("Unauthorized: only ARBITRAGE_EXECUTOR can deposit profit")
        if token not in self.token_whitelist:
            raise ValueError(f"TokenNotWhitelisted: {token}")
        if amount <= 0:
            raise ValueError("ZeroAmount")

        to_trading = (amount * self.trading_capital_bps) / self.BPS_DENOMINATOR
        to_gas = (amount * self.gas_reserve_bps) / self.BPS_DENOMINATOR
        to_profit = (amount * self.profit_reserve_bps) / self.BPS_DENOMINATOR
        to_emergency = (amount * self.emergency_reserve_bps) / self.BPS_DENOMINATOR
        to_revenue = amount - to_trading - to_gas - to_profit - to_emergency

        ledger = self.token_ledger.setdefault(token, {
            "trading_capital": 0.0,
            "gas_reserve": 0.0,
            "profit_reserve": 0.0,
            "emergency_reserve": 0.0,
            "revenue": 0.0,
            "total_realized_profit": 0.0,
            "total_withdrawn": 0.0
        })

        ledger["trading_capital"] += to_trading
        ledger["gas_reserve"] += to_gas
        ledger["profit_reserve"] += to_profit
        ledger["emergency_reserve"] += to_emergency
        ledger["revenue"] += to_revenue
        ledger["total_realized_profit"] += amount

    def withdraw(self, caller: str, token: str, amount: float, bucket: str, recipient: str):
        if self.paused:
            raise RuntimeError("ContractPaused")
        if not self.has_role("TREASURY_MANAGER_ROLE", caller):
            raise PermissionError("Unauthorized: only TREASURY_MANAGER can withdraw")
        if token not in self.token_whitelist:
            raise ValueError("TokenNotWhitelisted")
        if amount <= 0:
            raise ValueError("ZeroAmount")

        limits = self.withdrawal_limits.get(token, {})
        if limits.get("max_per_tx") and amount > limits["max_per_tx"]:
            raise ValueError(f"WithdrawalLimitExceeded: {amount} > {limits['max_per_tx']}")

        current_day = int(time.time() // 86400)
        daily_dict = self.daily_withdrawn.setdefault(token, {})
        today_total = daily_dict.get(current_day, 0.0) + amount
        if limits.get("max_daily") and today_total > limits["max_daily"]:
            raise ValueError(f"DailyWithdrawalLimitExceeded: {today_total} > {limits['max_daily']}")
        daily_dict[current_day] = today_total

        ledger = self.token_ledger.get(token)
        if not ledger or ledger.get(bucket, 0.0) < amount:
            raise ValueError(f"InsufficientBucketBalance in {bucket}")

        ledger[bucket] -= amount
        ledger["total_withdrawn"] += amount

    def emergency_withdraw(self, caller: str, token: str, amount: float, recipient: str):
        if not self.has_role("ADMIN_ROLE", caller):
            raise PermissionError("Unauthorized: only ADMIN can emergency withdraw")
        # Admin can rescue any token
        return True


class TreasuryContractTests(unittest.TestCase):
    def setUp(self):
        self.admin = "0xAdmin"
        self.executor = "0xArbitrageExecutor"
        self.manager = "0xTreasuryManager"
        self.pauser = "0xPauser"
        self.attacker = "0xAttacker"
        self.recipient = "0xRecipient"

        self.treasury = MockTreasuryContractPython(self.admin, self.executor)
        self.treasury.grant_role(self.admin, "TREASURY_MANAGER_ROLE", self.manager)
        self.treasury.grant_role(self.admin, "PAUSER_ROLE", self.pauser)

        self.treasury.set_token_whitelist(self.manager, "USDT", True)
        self.treasury.set_token_whitelist(self.manager, "USDC", True)

    def test_profit_deposit_and_five_bucket_allocation(self):
        self.treasury.deposit_profit(self.executor, "USDT", 1000.0)
        ledger = self.treasury.token_ledger["USDT"]

        self.assertEqual(ledger["trading_capital"], 500.0)    # 50%
        self.assertEqual(ledger["gas_reserve"], 150.0)        # 15%
        self.assertEqual(ledger["profit_reserve"], 150.0)     # 15%
        self.assertEqual(ledger["emergency_reserve"], 100.0)  # 10%
        self.assertEqual(ledger["revenue"], 100.0)            # 10%
        self.assertEqual(ledger["total_realized_profit"], 1000.0)

    def test_unauthorized_deposit_rejection(self):
        with self.assertRaises(PermissionError):
            self.treasury.deposit_profit(self.attacker, "USDT", 500.0)

    def test_non_whitelisted_token_rejection(self):
        with self.assertRaises(ValueError):
            self.treasury.deposit_profit(self.executor, "SHITCOIN", 500.0)

    def test_authorized_withdrawal_within_limits(self):
        self.treasury.deposit_profit(self.executor, "USDT", 1000.0)
        self.treasury.set_withdrawal_limits(self.admin, "USDT", max_per_tx=300.0, max_daily=600.0)

        # Manager withdraws 200 from trading_capital
        self.treasury.withdraw(self.manager, "USDT", 200.0, "trading_capital", self.recipient)
        self.assertEqual(self.treasury.token_ledger["USDT"]["trading_capital"], 300.0)

    def test_withdrawal_limit_breach(self):
        self.treasury.deposit_profit(self.executor, "USDT", 1000.0)
        self.treasury.set_withdrawal_limits(self.admin, "USDT", max_per_tx=300.0, max_daily=600.0)

        # Try to withdraw 400 in single tx
        with self.assertRaises(ValueError) as ctx:
            self.treasury.withdraw(self.manager, "USDT", 400.0, "trading_capital", self.recipient)
        self.assertIn("WithdrawalLimitExceeded", str(ctx.exception))

    def test_arbitrage_executor_cannot_withdraw(self):
        self.treasury.deposit_profit(self.executor, "USDT", 1000.0)
        # Executor must NOT have withdrawal permissions
        with self.assertRaises(PermissionError):
            self.treasury.withdraw(self.executor, "USDT", 100.0, "trading_capital", self.recipient)

    def test_pause_and_unpause_protection(self):
        self.treasury.pause(self.pauser)
        with self.assertRaises(RuntimeError):
            self.treasury.deposit_profit(self.executor, "USDT", 100.0)

        self.treasury.unpause(self.pauser)
        self.treasury.deposit_profit(self.executor, "USDT", 100.0)
        self.assertEqual(self.treasury.token_ledger["USDT"]["total_realized_profit"], 100.0)

    def test_emergency_withdrawal(self):
        self.assertTrue(self.treasury.emergency_withdraw(self.admin, "USDT", 500.0, self.recipient))
        with self.assertRaises(PermissionError):
            self.treasury.emergency_withdraw(self.attacker, "USDT", 500.0, self.recipient)

    def test_multiple_token_tracking(self):
        self.treasury.deposit_profit(self.executor, "USDT", 500.0)
        self.treasury.deposit_profit(self.executor, "USDC", 800.0)

        self.assertEqual(self.treasury.token_ledger["USDT"]["total_realized_profit"], 500.0)
        self.assertEqual(self.treasury.token_ledger["USDC"]["total_realized_profit"], 800.0)


if __name__ == "__main__":
    unittest.main()
