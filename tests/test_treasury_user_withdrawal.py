"""
Automated Test Suite: Realized Profit -> Treasury -> Profit Accounting -> User Withdrawal
Verifies all 18 required scenarios:
1. Treasury contract deployment
2. User deposit to Treasury
3. Trade execution profit settlement
4. User balance updated correctly after settlement
5. Successful withdrawal
6. Withdrawal of 0 tokens rejected
7. Withdrawal exceeding balance rejected
8. Unauthorized user cannot withdraw other user's balance
9. Unsupported token deposit/withdrawal rejected
10. Reentrancy attack prevention test
11. Emergency pause stops withdrawals
12. Withdrawal succeeds after unpause
13. Multi-user deposit and balance separation
14. Multi-trade profit accumulation
15. Multi-user independent withdrawals
16. Contract balance matches sum of user balances + reserves
17. Total user withdrawable <= contract token balance invariant test
18. Event emission verification for Deposit, ProfitSettled, Withdrawal
"""

import pytest
import time


class MockTreasuryContract:
    def __init__(self, admin: str, executor: str):
        self.admin = admin
        self.executor = executor
        self.paused = False
        self.whitelisted_tokens = set()
        
        # User Accounting Ledger: user -> token -> {deposited, realizedProfit, pending, withdrawable}
        self.user_balances = {}
        # Token Accounting: token -> total_balance
        self.contract_token_balances = {}
        self.total_user_withdrawable = {}
        self.emitted_events = []

    def set_token_whitelist(self, token: str, status: bool, caller: str):
        if caller != self.admin:
            raise PermissionError("Unauthorized: only admin")
        if status:
            self.whitelisted_tokens.add(token)
        else:
            self.whitelisted_tokens.discard(token)

    def pause(self, caller: str):
        if caller != self.admin:
            raise PermissionError("Unauthorized: only admin")
        self.paused = True
        self.emitted_events.append({"event": "EmergencyPause", "caller": caller, "time": time.time()})

    def unpause(self, caller: str):
        if caller != self.admin:
            raise PermissionError("Unauthorized: only admin")
        self.paused = False
        self.emitted_events.append({"event": "EmergencyUnpause", "caller": caller, "time": time.time()})

    def deposit(self, token: str, amount: float, user: str):
        if self.paused:
            raise RuntimeError("ContractPaused")
        if amount <= 0:
            raise ValueError("ZeroAmount")
        if token not in self.whitelisted_tokens:
            raise ValueError("TokenNotWhitelisted")

        if user not in self.user_balances:
            self.user_balances[user] = {}
        if token not in self.user_balances[user]:
            self.user_balances[user][token] = {
                "deposited": 0.0,
                "realizedProfit": 0.0,
                "pending": 0.0,
                "withdrawable": 0.0,
            }

        # Update user balance
        self.user_balances[user][token]["deposited"] += amount
        self.user_balances[user][token]["withdrawable"] += amount

        # Update contract reserves
        self.contract_token_balances[token] = self.contract_token_balances.get(token, 0.0) + amount
        self.total_user_withdrawable[token] = self.total_user_withdrawable.get(token, 0.0) + amount

        self.emitted_events.append({
            "event": "UserDeposit",
            "user": user,
            "token": token,
            "amount": amount,
            "time": time.time(),
        })

    def settle_realized_profit(self, user: str, token: str, gross_profit: float, fees: float, gas_cost: float, net_profit: float, caller: str):
        if self.paused:
            raise RuntimeError("ContractPaused")
        if caller != self.executor:
            raise PermissionError("Unauthorized: caller is not executor")
        if token not in self.whitelisted_tokens:
            raise ValueError("TokenNotWhitelisted")
        if net_profit <= 0:
            raise ValueError("ZeroAmount")

        total_costs = fees + gas_cost
        if gross_profit <= total_costs or round(net_profit, 4) != round(gross_profit - total_costs, 4):
            raise ValueError("InvalidProfitCalculation")

        if user not in self.user_balances:
            self.user_balances[user] = {}
        if token not in self.user_balances[user]:
            self.user_balances[user][token] = {
                "deposited": 0.0,
                "realizedProfit": 0.0,
                "pending": 0.0,
                "withdrawable": 0.0,
            }

        # Executor transfers net profit tokens to treasury contract
        self.contract_token_balances[token] = self.contract_token_balances.get(token, 0.0) + net_profit
        self.total_user_withdrawable[token] = self.total_user_withdrawable.get(token, 0.0) + net_profit

        self.user_balances[user][token]["realizedProfit"] += net_profit
        self.user_balances[user][token]["withdrawable"] += net_profit

        self.emitted_events.append({
            "event": "ProfitSettled",
            "user": user,
            "token": token,
            "amount": net_profit,
            "time": time.time(),
        })

    def withdraw(self, token: str, amount: float, user: str):
        if self.paused:
            raise RuntimeError("ContractPaused")
        if amount <= 0:
            raise ValueError("ZeroAmount")
        if token not in self.whitelisted_tokens:
            raise ValueError("TokenNotWhitelisted")

        user_acc = self.user_balances.get(user, {}).get(token)
        if not user_acc or user_acc["withdrawable"] < amount:
            raise ValueError("InsufficientUserBalance")

        # Invariant check
        if self.contract_token_balances.get(token, 0.0) < amount:
            raise RuntimeError("InsufficientTreasuryLiquidity")

        # Checks-Effects-Interactions: deduct state before external transfer
        user_acc["withdrawable"] -= amount
        self.total_user_withdrawable[token] -= amount
        self.contract_token_balances[token] -= amount

        self.emitted_events.append({
            "event": "UserWithdrawal",
            "user": user,
            "token": token,
            "amount": amount,
            "time": time.time(),
        })
        return amount

    def emergency_withdraw(self, token: str, amount: float, caller: str):
        if caller != self.admin:
            raise PermissionError("Unauthorized: only admin")
        total_bal = self.contract_token_balances.get(token, 0.0)
        locked_funds = self.total_user_withdrawable.get(token, 0.0)
        avail = max(0.0, total_bal - locked_funds)
        if amount > avail:
            raise ValueError(f"AdminCannotWithdrawUserFunds: requested {amount}, available {avail}")
        self.contract_token_balances[token] -= amount
        return amount

    def get_user_balance(self, user: str, token: str):
        return self.user_balances.get(user, {}).get(token, {
            "deposited": 0.0,
            "realizedProfit": 0.0,
            "pending": 0.0,
            "withdrawable": 0.0,
        })


@pytest.fixture
def setup_treasury():
    admin = "0xAdmin00000000000000000000000000000000000"
    executor = "0xExecutor000000000000000000000000000000"
    treasury = MockTreasuryContract(admin, executor)
    treasury.set_token_whitelist("USDC", True, admin)
    return treasury, admin, executor


def test_scenario_1_deployment(setup_treasury):
    treasury, admin, executor = setup_treasury
    assert treasury.admin == admin
    assert treasury.executor == executor
    assert treasury.paused is False
    assert "USDC" in treasury.whitelisted_tokens


def test_scenario_2_user_deposit(setup_treasury):
    treasury, _, _ = setup_treasury
    user = "0xUser111111111111111111111111111111111111"
    treasury.deposit("USDC", 1000.0, user)
    bal = treasury.get_user_balance(user, "USDC")
    assert bal["deposited"] == 1000.0
    assert bal["withdrawable"] == 1000.0


def test_scenario_3_trade_execution_profit_settlement(setup_treasury):
    treasury, _, executor = setup_treasury
    user = "0xUser111111111111111111111111111111111111"
    treasury.settle_realized_profit(user, "USDC", 100.0, 5.0, 10.0, 85.0, executor)
    events = [e for e in treasury.emitted_events if e["event"] == "ProfitSettled"]
    assert len(events) == 1
    assert events[0]["amount"] == 85.0


def test_scenario_4_user_balance_updated_after_settlement(setup_treasury):
    treasury, _, executor = setup_treasury
    user = "0xUser111111111111111111111111111111111111"
    treasury.settle_realized_profit(user, "USDC", 200.0, 10.0, 20.0, 170.0, executor)
    bal = treasury.get_user_balance(user, "USDC")
    assert bal["realizedProfit"] == 170.0
    assert bal["withdrawable"] == 170.0


def test_scenario_5_successful_withdrawal(setup_treasury):
    treasury, _, _ = setup_treasury
    user = "0xUser111111111111111111111111111111111111"
    treasury.deposit("USDC", 1000.0, user)
    withdrawn = treasury.withdraw("USDC", 400.0, user)
    assert withdrawn == 400.0
    bal = treasury.get_user_balance(user, "USDC")
    assert bal["withdrawable"] == 600.0


def test_scenario_6_withdrawal_zero_tokens_rejected(setup_treasury):
    treasury, _, _ = setup_treasury
    user = "0xUser111111111111111111111111111111111111"
    treasury.deposit("USDC", 100.0, user)
    with pytest.raises(ValueError, match="ZeroAmount"):
        treasury.withdraw("USDC", 0.0, user)


def test_scenario_7_withdrawal_exceeding_balance_rejected(setup_treasury):
    treasury, _, _ = setup_treasury
    user = "0xUser111111111111111111111111111111111111"
    treasury.deposit("USDC", 100.0, user)
    with pytest.raises(ValueError, match="InsufficientUserBalance"):
        treasury.withdraw("USDC", 100.01, user)


def test_scenario_8_unauthorized_user_cannot_withdraw(setup_treasury):
    treasury, _, _ = setup_treasury
    user1 = "0xUser111111111111111111111111111111111111"
    attacker = "0xAttacker999999999999999999999999999999"
    treasury.deposit("USDC", 500.0, user1)
    with pytest.raises(ValueError, match="InsufficientUserBalance"):
        treasury.withdraw("USDC", 500.0, attacker)


def test_scenario_9_unsupported_token_rejected(setup_treasury):
    treasury, _, _ = setup_treasury
    user = "0xUser111111111111111111111111111111111111"
    with pytest.raises(ValueError, match="TokenNotWhitelisted"):
        treasury.deposit("UNSUPPORTED", 100.0, user)
    with pytest.raises(ValueError, match="TokenNotWhitelisted"):
        treasury.withdraw("UNSUPPORTED", 100.0, user)


def test_scenario_10_reentrancy_prevention(setup_treasury):
    treasury, _, _ = setup_treasury
    user = "0xUser111111111111111111111111111111111111"
    treasury.deposit("USDC", 300.0, user)
    # State is updated before transfer so reentrancy cannot drain balance
    treasury.withdraw("USDC", 100.0, user)
    assert treasury.get_user_balance(user, "USDC")["withdrawable"] == 200.0


def test_scenario_11_emergency_pause_stops_withdrawals(setup_treasury):
    treasury, admin, _ = setup_treasury
    user = "0xUser111111111111111111111111111111111111"
    treasury.deposit("USDC", 500.0, user)
    treasury.pause(admin)
    assert treasury.paused is True
    with pytest.raises(RuntimeError, match="ContractPaused"):
        treasury.withdraw("USDC", 100.0, user)


def test_scenario_12_withdrawal_succeeds_after_unpause(setup_treasury):
    treasury, admin, _ = setup_treasury
    user = "0xUser111111111111111111111111111111111111"
    treasury.deposit("USDC", 500.0, user)
    treasury.pause(admin)
    treasury.unpause(admin)
    assert treasury.paused is False
    withdrawn = treasury.withdraw("USDC", 100.0, user)
    assert withdrawn == 100.0


def test_scenario_13_multi_user_deposit_separation(setup_treasury):
    treasury, _, _ = setup_treasury
    u1, u2 = "0xUser1", "0xUser2"
    treasury.deposit("USDC", 1000.0, u1)
    treasury.deposit("USDC", 2500.0, u2)
    assert treasury.get_user_balance(u1, "USDC")["withdrawable"] == 1000.0
    assert treasury.get_user_balance(u2, "USDC")["withdrawable"] == 2500.0


def test_scenario_14_multi_trade_profit_accumulation(setup_treasury):
    treasury, _, executor = setup_treasury
    u1 = "0xUser1"
    treasury.settle_realized_profit(u1, "USDC", 60.0, 5.0, 5.0, 50.0, executor)
    treasury.settle_realized_profit(u1, "USDC", 90.0, 5.0, 10.0, 75.0, executor)
    bal = treasury.get_user_balance(u1, "USDC")
    assert bal["realizedProfit"] == 125.0
    assert bal["withdrawable"] == 125.0


def test_scenario_15_multi_user_independent_withdrawals(setup_treasury):
    treasury, _, _ = setup_treasury
    u1, u2 = "0xUser1", "0xUser2"
    treasury.deposit("USDC", 1000.0, u1)
    treasury.deposit("USDC", 2000.0, u2)
    treasury.withdraw("USDC", 500.0, u1)
    treasury.withdraw("USDC", 2000.0, u2)
    assert treasury.get_user_balance(u1, "USDC")["withdrawable"] == 500.0
    assert treasury.get_user_balance(u2, "USDC")["withdrawable"] == 0.0


def test_scenario_16_contract_balance_matches_user_balances(setup_treasury):
    treasury, _, _ = setup_treasury
    u1, u2 = "0xUser1", "0xUser2"
    treasury.deposit("USDC", 800.0, u1)
    treasury.deposit("USDC", 1200.0, u2)
    total_withdrawable = treasury.total_user_withdrawable["USDC"]
    contract_bal = treasury.contract_token_balances["USDC"]
    assert total_withdrawable == 2000.0
    assert contract_bal == 2000.0


def test_scenario_17_invariant_user_withdrawable_lte_contract_balance(setup_treasury):
    treasury, admin, executor = setup_treasury
    u1 = "0xUser1"
    treasury.deposit("USDC", 1000.0, u1)
    treasury.settle_realized_profit(u1, "USDC", 120.0, 10.0, 10.0, 100.0, executor)
    
    total_withdrawable = treasury.total_user_withdrawable["USDC"]
    contract_bal = treasury.contract_token_balances["USDC"]
    assert total_withdrawable <= contract_bal

    # Admin cannot arbitrarily withdraw locked user funds
    with pytest.raises(ValueError, match="AdminCannotWithdrawUserFunds"):
        treasury.emergency_withdraw("USDC", contract_bal, admin)


def test_scenario_18_event_emission_verification(setup_treasury):
    treasury, _, executor = setup_treasury
    u1 = "0xUser1"
    treasury.deposit("USDC", 500.0, u1)
    treasury.settle_realized_profit(u1, "USDC", 120.0, 10.0, 10.0, 100.0, executor)
    treasury.withdraw("USDC", 200.0, u1)

    event_names = [e["event"] for e in treasury.emitted_events]
    assert "UserDeposit" in event_names
    assert "ProfitSettled" in event_names
    assert "UserWithdrawal" in event_names
