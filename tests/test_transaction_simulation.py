import unittest
import time


class TransactionSimulatorPython:
    """Python simulator replicating on-chain ArbitrageExecutor pre-flight validations."""

    def __init__(self):
        self.whitelisted_tokens = {"0xUSDT", "0xWETH", "0xUSDC", "0xDAI"}
        self.whitelisted_routers = {"0xUniswapRouter", "0xSushiswapRouter"}
        self.authorized_executors = {"0xExecutorBot"}
        self.is_paused = False

    def simulate(self, req: dict) -> dict:
        now = time.time()
        status = "SIMULATION_FAILED"
        revert_reason = None

        # 1. RPC failure
        if req.get("rpc_failure", False):
            return {
                "status": "SIMULATION_FAILED",
                "is_ready_for_execution": False,
                "revert_reason": "RPC Error: Node unavailable or connection timed out"
            }

        # 2. Chain ID
        if req.get("chain_id", 0) <= 0:
            return {"status": "SIMULATION_FAILED", "is_ready_for_execution": False, "revert_reason": "Invalid chain ID"}

        # 3. Deadline
        deadline = req.get("deadline", 0)
        if deadline <= now:
            return {"status": "SIMULATION_FAILED", "is_ready_for_execution": False, "revert_reason": "ExpiredDeadline"}

        # 4. Token validation
        token_in = req.get("token_in")
        token_out = req.get("token_out")
        if not token_in or not token_out or token_in == token_out:
            return {"status": "SIMULATION_FAILED", "is_ready_for_execution": False, "revert_reason": "IdenticalTokens"}
        if token_in not in self.whitelisted_tokens or token_out not in self.whitelisted_tokens:
            return {"status": "SIMULATION_FAILED", "is_ready_for_execution": False, "revert_reason": "TokenNotWhitelisted"}

        # 5. Router validation
        router_buy = req.get("router_buy")
        router_sell = req.get("router_sell")
        if not router_buy or not router_sell or router_buy == router_sell:
            return {"status": "SIMULATION_FAILED", "is_ready_for_execution": False, "revert_reason": "IdenticalRouters"}
        if router_buy not in self.whitelisted_routers or router_sell not in self.whitelisted_routers:
            return {"status": "SIMULATION_FAILED", "is_ready_for_execution": False, "revert_reason": "RouterNotWhitelisted"}

        # 6. Contract permissions
        if req.get("is_contract_paused", self.is_paused):
            return {"status": "SIMULATION_FAILED", "is_ready_for_execution": False, "revert_reason": "ContractPaused"}

        executor = req.get("executor_address")
        if executor not in self.authorized_executors:
            return {"status": "SIMULATION_FAILED", "is_ready_for_execution": False, "revert_reason": "Unauthorized"}

        # 7. Balance & Allowance
        amount_in = req.get("amount_in", 0.0)
        user_balance = req.get("executor_balance", amount_in)
        if user_balance < amount_in:
            return {"status": "SIMULATION_FAILED", "is_ready_for_execution": False, "revert_reason": f"InsufficientBalance: have {user_balance} < need {amount_in}"}

        user_allowance = req.get("executor_allowance", amount_in)
        if user_allowance < amount_in:
            return {"status": "SIMULATION_FAILED", "is_ready_for_execution": False, "revert_reason": f"InsufficientAllowance: have {user_allowance} < need {amount_in}"}

        # 8. Revert trigger
        if req.get("should_revert", False):
            return {"status": "SIMULATION_FAILED", "is_ready_for_execution": False, "revert_reason": req.get("revert_error", "Execution reverted")}

        # 9. Output & Slippage
        simulated_output = req.get("simulated_output", 0.0)
        min_output = req.get("min_output", 0.0)
        if simulated_output < min_output:
            return {"status": "SIMULATION_FAILED", "is_ready_for_execution": False, "revert_reason": f"SlippageViolation: {simulated_output} < {min_output}"}

        # 10. Gas Cost Ceiling
        gas_cost = req.get("gas_cost_usdt", 0.005)
        max_gas = req.get("max_gas_usdt", 0.25)
        if gas_cost > max_gas:
            return {"status": "SIMULATION_FAILED", "is_ready_for_execution": False, "revert_reason": f"ExcessiveGasCost: ${gas_cost:.4f} > ${max_gas:.4f}"}

        # 11. Net Profit
        net_profit = simulated_output - amount_in - gas_cost
        min_profit = req.get("min_net_profit", 0.01)
        if net_profit < min_profit or net_profit <= 0:
            return {"status": "SIMULATION_FAILED", "is_ready_for_execution": False, "revert_reason": f"UnprofitableArbitrage: profit ${net_profit:.4f} < min ${min_profit:.4f}"}

        # Passed
        return {
            "status": "SIMULATION_PASSED",
            "is_ready_for_execution": True,
            "expected_net_profit": round(net_profit, 4),
            "revert_reason": None
        }


class TransactionSimulationTests(unittest.TestCase):
    def setUp(self):
        self.simulator = TransactionSimulatorPython()
        self.base_request = {
            "chain_id": 8453,
            "executor_address": "0xExecutorBot",
            "router_buy": "0xUniswapRouter",
            "router_sell": "0xSushiswapRouter",
            "token_in": "0xUSDT",
            "token_out": "0xWETH",
            "amount_in": 50.0,
            "simulated_output": 50.70,
            "min_output": 50.45,
            "gas_cost_usdt": 0.005,
            "max_gas_usdt": 0.25,
            "min_net_profit": 0.01,
            "deadline": time.time() + 120,
            "current_block": 15000001
        }

    def test_successful_simulation(self):
        res = self.simulator.simulate(self.base_request)
        self.assertEqual(res["status"], "SIMULATION_PASSED")
        self.assertTrue(res["is_ready_for_execution"])
        self.assertIsNone(res["revert_reason"])

    def test_reverted_transaction(self):
        req = dict(self.base_request, should_revert=True, revert_error="CustomError: SwapFailed")
        res = self.simulator.simulate(req)
        self.assertEqual(res["status"], "SIMULATION_FAILED")
        self.assertFalse(res["is_ready_for_execution"])
        self.assertIn("SwapFailed", res["revert_reason"])

    def test_insufficient_balance(self):
        req = dict(self.base_request, executor_balance=10.0)
        res = self.simulator.simulate(req)
        self.assertEqual(res["status"], "SIMULATION_FAILED")
        self.assertIn("InsufficientBalance", res["revert_reason"])

    def test_insufficient_allowance(self):
        req = dict(self.base_request, executor_allowance=0.0)
        res = self.simulator.simulate(req)
        self.assertEqual(res["status"], "SIMULATION_FAILED")
        self.assertIn("InsufficientAllowance", res["revert_reason"])

    def test_invalid_router(self):
        req = dict(self.base_request, router_buy="0xUnverifiedRouter")
        res = self.simulator.simulate(req)
        self.assertEqual(res["status"], "SIMULATION_FAILED")
        self.assertIn("RouterNotWhitelisted", res["revert_reason"])

    def test_invalid_token(self):
        req = dict(self.base_request, token_in="0xScamToken")
        res = self.simulator.simulate(req)
        self.assertEqual(res["status"], "SIMULATION_FAILED")
        self.assertIn("TokenNotWhitelisted", res["revert_reason"])

    def test_low_output_slippage_violation(self):
        req = dict(self.base_request, simulated_output=50.20) # 50.20 < 50.45 min
        res = self.simulator.simulate(req)
        self.assertEqual(res["status"], "SIMULATION_FAILED")
        self.assertIn("SlippageViolation", res["revert_reason"])

    def test_high_gas_cost(self):
        req = dict(self.base_request, gas_cost_usdt=0.60) # 0.60 > 0.25 max
        res = self.simulator.simulate(req)
        self.assertEqual(res["status"], "SIMULATION_FAILED")
        self.assertIn("ExcessiveGasCost", res["revert_reason"])

    def test_low_profit(self):
        req = dict(self.base_request, simulated_output=50.008) # net profit $0.003 < 0.01
        res = self.simulator.simulate(req)
        self.assertEqual(res["status"], "SIMULATION_FAILED")
        self.assertIn("UnprofitableArbitrage", res["revert_reason"])

    def test_deadline_violation(self):
        req = dict(self.base_request, deadline=time.time() - 10)
        res = self.simulator.simulate(req)
        self.assertEqual(res["status"], "SIMULATION_FAILED")
        self.assertIn("ExpiredDeadline", res["revert_reason"])

    def test_paused_contract(self):
        req = dict(self.base_request, is_contract_paused=True)
        res = self.simulator.simulate(req)
        self.assertEqual(res["status"], "SIMULATION_FAILED")
        self.assertIn("ContractPaused", res["revert_reason"])

    def test_unauthorized_executor(self):
        req = dict(self.base_request, executor_address="0xHackerWallet")
        res = self.simulator.simulate(req)
        self.assertEqual(res["status"], "SIMULATION_FAILED")
        self.assertIn("Unauthorized", res["revert_reason"])

    def test_rpc_failure(self):
        req = dict(self.base_request, rpc_failure=True)
        res = self.simulator.simulate(req)
        self.assertEqual(res["status"], "SIMULATION_FAILED")
        self.assertIn("RPC Error", res["revert_reason"])


if __name__ == "__main__":
    unittest.main()
