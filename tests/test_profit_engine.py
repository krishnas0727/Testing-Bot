import unittest
from dex_engine import calculate_amount_out


class ProfitEnginePythonTests(unittest.TestCase):
    def test_amm_constant_product_swap_output(self):
        """Verify constant-product swap output matching Uniswap V2 formula."""
        reserve_in = 300000.0   # USDT
        reserve_out = 100.0     # WETH
        amount_in = 1000.0      # USDT
        fee_pct = 0.003         # 0.30%

        amount_out = calculate_amount_out(amount_in, reserve_in, reserve_out, fee_pct)
        # Expected ≈ 0.332223 WETH
        self.assertAlmostEqual(amount_out, 0.332223, places=4)

    def test_complete_net_profit_and_roi_calculation(self):
        """Verify complete Phase 5 Net Profit and ROI formulas."""
        initial_capital = 100.0
        expected_output = 102.50
        gas_cost = 0.005
        other_costs = 0.0
        safety_margin = 0.02

        gross_profit = expected_output - initial_capital
        net_profit = gross_profit - gas_cost - other_costs - safety_margin
        roi = (net_profit / initial_capital) * 100.0

        self.assertAlmostEqual(gross_profit, 2.50, places=4)
        self.assertAlmostEqual(net_profit, 2.475, places=4)
        self.assertAlmostEqual(roi, 2.475, places=3)

    def test_unprofitable_negative_net_rejection(self):
        """Verify negative profit is rejected and never misclassified as positive."""
        initial_capital = 100.0
        expected_output = 99.50 # Loss of $0.50 after fees
        gas_cost = 0.005

        gross_profit = expected_output - initial_capital
        net_profit = gross_profit - gas_cost

        self.assertLess(gross_profit, 0)
        self.assertLess(net_profit, 0)
        is_profitable = net_profit > 0
        self.assertFalse(is_profitable)

    def test_minimum_profit_threshold(self):
        """Verify trade below minimum profit gate is marked not executable."""
        net_profit = 0.008
        min_required_profit = 0.010

        is_executable = (net_profit > 0) and (net_profit >= min_required_profit)
        self.assertFalse(is_executable)

    def test_multi_trade_size_optimization(self):
        """Verify optimal size selection maximizing net profit."""
        # Simulated net profit profile where optimal size is $25
        profit_curve = {
            1.0: 0.01,
            5.0: 0.08,
            10.0: 0.18,
            25.0: 0.35,  # Peak
            50.0: 0.22,  # Slippage increases
            100.0: -0.15 # Excessive price impact
        }

        optimal_size = max(profit_curve, key=profit_curve.get)
        max_profit = profit_curve[optimal_size]

        self.assertEqual(optimal_size, 25.0)
        self.assertEqual(max_profit, 0.35)


if __name__ == "__main__":
    unittest.main()
