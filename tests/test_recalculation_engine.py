import unittest
import time
from dex_engine import calculate_amount_out, calculate_price_impact


class RealTimeRecalculationEnginePython:
    def __init__(self, max_pending_timeout_sec: float = 8.0, max_data_age_sec: float = 5.0, min_net_profit: float = 0.01):
        self.max_pending_timeout_sec = max_pending_timeout_sec
        self.max_data_age_sec = max_data_age_sec
        self.min_net_profit = min_net_profit

    def revalidate(self, approved_opp: dict, fresh_data: dict) -> dict:
        now = time.time()
        rejection_reasons = []

        # 1. Opportunity pending timeout
        initial_time = approved_opp.get("approved_timestamp", now)
        pending_age = now - initial_time
        if pending_age > self.max_pending_timeout_sec:
            rejection_reasons.append(f"Opportunity pending timeout exceeded ({pending_age:.2f}s > {self.max_pending_timeout_sec}s)")

        # 2. RPC failure / invalid pool check
        if not fresh_data or not fresh_data.get("is_valid", True):
            rejection_reasons.append("RPC or pool state refresh failure: Invalid pool state")
            return {
                "final_decision": "REJECTED",
                "rejection_reasons": rejection_reasons,
                "new_net_profit": 0.0
            }

        # 3. Data staleness
        data_age = now - fresh_data.get("fetched_at", now)
        if data_age > self.max_data_age_sec:
            rejection_reasons.append(f"Fresh market data is stale ({data_age:.2f}s > {self.max_data_age_sec}s)")

        # 4. Recalculate AMM swap quotes
        trade_size = approved_opp.get("trade_size", 50.0)
        fee_pct = 0.003

        # Leg 1: Quote -> Base
        weth_out = calculate_amount_out(
            trade_size,
            fresh_data["buy_pool"]["quote_reserve"],
            fresh_data["buy_pool"]["base_reserve"],
            fee_pct
        )

        # Leg 2: Base -> Quote
        usdt_out = calculate_amount_out(
            weth_out,
            fresh_data["sell_pool"]["base_reserve"],
            fresh_data["sell_pool"]["quote_reserve"],
            fee_pct
        )

        # Recalculate profit & gas
        gas_cost = fresh_data.get("gas_cost_usdt", 0.005)
        gross_profit = usdt_out - trade_size
        net_profit = gross_profit - gas_cost

        # 5. Check liquidity
        min_liq = min(fresh_data["buy_pool"].get("liquidity_usd", 100000), fresh_data["sell_pool"].get("liquidity_usd", 100000))
        if min_liq < 1000.0:
            rejection_reasons.append(f"Pool liquidity (${min_liq:.2f}) below min threshold $1,000.00")

        # 6. Check gas ceiling
        if gas_cost > 0.25:
            rejection_reasons.append(f"Gas cost (${gas_cost:.4f}) exceeds ceiling $0.25")

        # 7. Check net profit
        if net_profit <= 0 or net_profit < self.min_net_profit:
            rejection_reasons.append(f"Recalculated net profit (${net_profit:.4f}) below min threshold ${self.min_net_profit:.4f}")

        # 8. Check external risk circuit breaker
        if fresh_data.get("circuit_breaker_open", False):
            rejection_reasons.append("Circuit breaker tripped: Execution blocked")

        is_valid = len(rejection_reasons) == 0
        final_decision = "VALID_FOR_SIMULATION" if is_valid else "REJECTED"

        return {
            "opportunity_id": approved_opp.get("opportunity_id"),
            "previous_net_profit": approved_opp.get("net_profit_usdt", 0.0),
            "new_net_profit": round(net_profit, 4),
            "previous_gas_cost": approved_opp.get("gas_cost_usdt", 0.0),
            "new_gas_cost": round(gas_cost, 4),
            "current_block": fresh_data.get("current_block", 15000000),
            "final_decision": final_decision,
            "rejection_reasons": rejection_reasons,
            "delta_net_profit": round(net_profit - approved_opp.get("net_profit_usdt", 0.0), 4)
        }


class RealTimeRecalculationTests(unittest.TestCase):
    def setUp(self):
        self.engine = RealTimeRecalculationEnginePython()
        self.approved_opp = {
            "opportunity_id": "opp_py_101",
            "trade_size": 50.0,
            "net_profit_usdt": 0.68,
            "gas_cost_usdt": 0.005,
            "approved_timestamp": time.time()
        }
        self.fresh_data = {
            "is_valid": True,
            "fetched_at": time.time(),
            "current_block": 15000001,
            "gas_cost_usdt": 0.005,
            "buy_pool": {
                "base_reserve": 100.0,
                "quote_reserve": 300000.0,
                "liquidity_usd": 600000.0
            },
            "sell_pool": {
                "base_reserve": 100.0,
                "quote_reserve": 306000.0,
                "liquidity_usd": 612000.0
            }
        }

    def test_approve_healthy_recalculation(self):
        res = self.engine.revalidate(self.approved_opp, self.fresh_data)
        self.assertEqual(res["final_decision"], "VALID_FOR_SIMULATION")
        self.assertGreater(res["new_net_profit"], 0)

    def test_pool_price_change_eliminating_profit(self):
        # Sell pool price collapses to 3001
        data = dict(self.fresh_data)
        data["sell_pool"] = {"base_reserve": 100.0, "quote_reserve": 300100.0, "liquidity_usd": 600200.0}
        res = self.engine.revalidate(self.approved_opp, data)
        self.assertEqual(res["final_decision"], "REJECTED")
        self.assertTrue(any("below min threshold" in r for r in res["rejection_reasons"]))

    def test_pool_liquidity_drop(self):
        # Pool drained to $400
        data = dict(self.fresh_data)
        data["buy_pool"] = {"base_reserve": 0.1, "quote_reserve": 300.0, "liquidity_usd": 400.0}
        res = self.engine.revalidate(self.approved_opp, data)
        self.assertEqual(res["final_decision"], "REJECTED")
        self.assertTrue(any("liquidity" in r for r in res["rejection_reasons"]))

    def test_gas_cost_spike(self):
        data = dict(self.fresh_data, gas_cost_usdt=0.50)
        res = self.engine.revalidate(self.approved_opp, data)
        self.assertEqual(res["final_decision"], "REJECTED")
        self.assertTrue(any("Gas cost" in r for r in res["rejection_reasons"]))

    def test_stale_market_data(self):
        data = dict(self.fresh_data, fetched_at=time.time() - 10.0)
        res = self.engine.revalidate(self.approved_opp, data)
        self.assertEqual(res["final_decision"], "REJECTED")
        self.assertTrue(any("stale" in r for r in res["rejection_reasons"]))

    def test_opportunity_timeout(self):
        opp = dict(self.approved_opp, approved_timestamp=time.time() - 20.0)
        res = self.engine.revalidate(opp, self.fresh_data)
        self.assertEqual(res["final_decision"], "REJECTED")
        self.assertTrue(any("timeout" in r for r in res["rejection_reasons"]))

    def test_rpc_failure(self):
        data = dict(self.fresh_data, is_valid=False)
        res = self.engine.revalidate(self.approved_opp, data)
        self.assertEqual(res["final_decision"], "REJECTED")
        self.assertTrue(any("RPC or pool state refresh failure" in r for r in res["rejection_reasons"]))


if __name__ == "__main__":
    unittest.main()
