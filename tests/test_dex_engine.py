import unittest
from unittest.mock import patch

import config
from dex_engine import (
    calculate_amount_out,
    calculate_price_impact,
    calculate_slippage_min_out,
    estimate_arbitrage_gas_cost_usd,
    get_dex_reserves,
    simulate_atomic_arbitrage,
    get_all_dex_quotes,
)


class DEXEngineTests(unittest.TestCase):
    def test_constant_product_swap_formula(self):
        # 100 USDT input into pool with 100,000 USDT and 33.33 WETH (0.3% fee)
        # expected out: (100 * 0.997 * 33.333333) / (100000 + 100 * 0.997) ≈ 0.0332
        out = calculate_amount_out(
            amount_in=100.0,
            reserve_in=100_000.0,
            reserve_out=33.333333,
            fee_pct=0.30
        )
        self.assertGreater(out, 0.03)
        self.assertLess(out, 0.035)

    def test_zero_or_negative_inputs_return_zero(self):
        self.assertEqual(calculate_amount_out(0, 1000, 1000), 0.0)
        self.assertEqual(calculate_amount_out(-10, 1000, 1000), 0.0)
        self.assertEqual(calculate_amount_out(100, 0, 1000), 0.0)

    def test_price_impact_calculation(self):
        # Small trade has negligible price impact
        impact_small = calculate_price_impact(
            amount_in=10.0,
            amount_out=0.00332,
            spot_price=0.0003333
        )
        self.assertLess(impact_small, 0.5)

        # Huge trade relative to pool has large price impact
        huge_out = calculate_amount_out(50_000.0, 100_000.0, 33.33, 0.30)
        impact_large = calculate_price_impact(
            amount_in=50_000.0,
            amount_out=huge_out,
            spot_price=33.33 / 100_000.0
        )
        self.assertGreater(impact_large, 10.0)

    def test_slippage_calculation(self):
        min_out = calculate_slippage_min_out(amount_out=100.0, slippage_pct=0.50)
        self.assertEqual(min_out, 99.50)

    def test_gas_cost_estimation_in_usd(self):
        gas_info = estimate_arbitrage_gas_cost_usd(
            eth_price_usd=3000.0,
            gas_units=250000,
            gas_price_wei=20_000_000_000  # 20 Gwei
        )
        self.assertEqual(gas_info["gas_price_gwei"], 20.0)
        # gas cost eth = 250000 * 20e9 / 1e18 = 0.005 ETH * $3000 = $15.00
        self.assertAlmostEqual(gas_info["gas_cost_usd"], 15.0, places=2)
        self.assertTrue(gas_info["is_gas_acceptable"])

    def test_get_dex_reserves_returns_structured_data(self):
        res = get_dex_reserves("Uniswap_V2", "WETH", "USDT")
        self.assertIn("base_reserve", res)
        self.assertIn("quote_reserve", res)
        self.assertIn("spot_price", res)
        self.assertGreater(res["spot_price"], 0)

    def test_simulate_atomic_arbitrage_profitable(self):
        plan = {
            "buy_dex": "Uniswap_V2",
            "sell_dex": "SushiSwap_V2",
            "amount_in": 100.0,
            "gross_return_usdt": 101.50,
            "net_profit_usdt": 0.85,
        }
        res = simulate_atomic_arbitrage(plan)
        self.assertTrue(res["success"])
        self.assertEqual(res["status"], "SIMULATION_SUCCESS")

    def test_simulate_atomic_arbitrage_unprofitable_reverts(self):
        plan = {
            "buy_dex": "Uniswap_V2",
            "sell_dex": "SushiSwap_V2",
            "amount_in": 100.0,
            "gross_return_usdt": 99.50,  # Below amount_in + min_profit
            "net_profit_usdt": -0.60,
        }
        res = simulate_atomic_arbitrage(plan)
        self.assertFalse(res["success"])
        self.assertEqual(res["status"], "ATOMIC_REVERT_UNPROFITABLE")


if __name__ == "__main__":
    unittest.main()
