"""Unit Tests for DEX Protocol Fee Calculations (Phase 7).

Verifies strict compliance with Phase 7 requirements:
1. Clearly distinguishes fee percentage (0.3%), decimal fraction (0.003), token fee units, and USD value.
2. For 0.3% fee: 0.3% = 0.003.
3. Example: $5.00 * 0.003 = $0.015 per swap.
4. For two swap legs: correctly calculates both legs ($5 trade total fee ≈ $0.03, NOT $3.02).
5. Does not confuse 0.3, 0.003, 0.03, or 3.
6. Verifies fee values with known amounts: $5, $100, and $1000.
7. Verifies fee values are not treated as percentages twice.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import config
from dex_engine import calculate_amount_out
from arbitrage import (
    get_dex_fee_fraction,
    calculate_dex_swap_fee_usd,
    calculate_two_leg_dex_fees_usd,
    _calculate_net_profit,
    analyze_market,
)


class TestDEXFeeCalculation(unittest.TestCase):
    def test_fee_percentage_and_decimal_fraction_distinction(self):
        """Requirement 2, 3, 6: Disambiguate 0.30% percentage vs 0.003 decimal fraction."""
        # 0.3% percentage must yield 0.003 decimal fraction
        self.assertEqual(get_dex_fee_fraction(0.30), 0.003)
        self.assertEqual(get_dex_fee_fraction(0.3), 0.003)

        # If already passed as 0.003 decimal fraction, must not divide by 100 twice
        self.assertEqual(get_dex_fee_fraction(0.003), 0.003)

        # config constants must agree
        self.assertEqual(config.DEX_PROTOCOL_FEE_PCT, 0.30)
        self.assertEqual(config.DEX_PROTOCOL_FEE_FRACTION, 0.003)

    def test_known_amount_single_swap_fees(self):
        """Requirement 4 & 8: Validate single swap fee for $5, $100, $1000."""
        # $5 swap: $5.00 * 0.003 = $0.0150
        fee_5 = calculate_dex_swap_fee_usd(5.0, 0.30)
        self.assertAlmostEqual(fee_5, 0.0150, places=4)

        # $100 swap: $100.00 * 0.003 = $0.3000
        fee_100 = calculate_dex_swap_fee_usd(100.0, 0.30)
        self.assertAlmostEqual(fee_100, 0.3000, places=4)

        # $1000 swap: $1000.00 * 0.003 = $3.0000
        fee_1000 = calculate_dex_swap_fee_usd(1000.0, 0.30)
        self.assertAlmostEqual(fee_1000, 3.0000, places=4)

    def test_known_amount_two_leg_arbitrage_fees(self):
        """Requirement 5 & 8: Validate both legs for $5, $100, $1000."""
        # $5 trade:
        # Leg 1: $5.00 * 0.003 = $0.0150
        # Leg 2: $5.00 * 0.003 = $0.0150
        # Total = $0.0300 (Fixes the $3.02 bug!)
        two_leg_5 = calculate_two_leg_dex_fees_usd(5.0, 5.0, 0.30)
        self.assertAlmostEqual(two_leg_5["fee_leg1_usd"], 0.0150, places=4)
        self.assertAlmostEqual(two_leg_5["fee_leg2_usd"], 0.0150, places=4)
        self.assertAlmostEqual(two_leg_5["total_dex_fees_usd"], 0.0300, places=4)
        # Must NEVER be approximately $3.00 or $3.02
        self.assertLess(two_leg_5["total_dex_fees_usd"], 0.10)

        # With realistic asymmetric legs ($5.00 in -> $5.07 out on leg 2)
        asym_5 = calculate_two_leg_dex_fees_usd(5.0, 5.07, 0.30)
        self.assertAlmostEqual(asym_5["fee_leg1_usd"], 0.0150, places=4)
        self.assertAlmostEqual(asym_5["fee_leg2_usd"], 0.01521, places=4)
        self.assertAlmostEqual(asym_5["total_dex_fees_usd"], 0.03021, places=4)
        self.assertAlmostEqual(round(asym_5["total_dex_fees_usd"], 2), 0.03)

        # $100 trade:
        # Leg 1: $100.00 * 0.003 = $0.3000
        # Leg 2: $100.00 * 0.003 = $0.3000
        # Total = $0.6000
        two_leg_100 = calculate_two_leg_dex_fees_usd(100.0, 100.0, 0.30)
        self.assertAlmostEqual(two_leg_100["fee_leg1_usd"], 0.3000, places=4)
        self.assertAlmostEqual(two_leg_100["fee_leg2_usd"], 0.3000, places=4)
        self.assertAlmostEqual(two_leg_100["total_dex_fees_usd"], 0.6000, places=4)

        # $1000 trade:
        # Leg 1: $1000.00 * 0.003 = $3.0000
        # Leg 2: $1000.00 * 0.003 = $3.0000
        # Total = $6.0000
        two_leg_1000 = calculate_two_leg_dex_fees_usd(1000.0, 1000.0, 0.30)
        self.assertAlmostEqual(two_leg_1000["fee_leg1_usd"], 3.0000, places=4)
        self.assertAlmostEqual(two_leg_1000["fee_leg2_usd"], 3.0000, places=4)
        self.assertAlmostEqual(two_leg_1000["total_dex_fees_usd"], 6.0000, places=4)

    def test_calculate_amount_out_safe_against_double_percentage(self):
        """Requirement 9 & 10: Verify router swap formula applies 0.3% (997/1000) correctly."""
        reserve_in = 100_000.0   # 100k USDT
        reserve_out = 50.0       # 50 WETH (~$2000 spot)
        amount_in = 5.0          # 5 USDT

        # Standard Uniswap V2 0.3% formula:
        # amount_in_with_fee = 5.0 * (1 - 0.003) = 5.0 * 0.997 = 4.985
        # expected_out = (4.985 * 50) / (100_000 + 4.985)
        expected_out = (4.985 * 50.0) / (100_000.0 + 4.985)

        # Passing 0.30%
        out_pct = calculate_amount_out(amount_in, reserve_in, reserve_out, fee_pct=0.30)
        self.assertAlmostEqual(out_pct, expected_out, places=8)

        # Passing 0.003 decimal fraction directly
        out_frac = calculate_amount_out(amount_in, reserve_in, reserve_out, fee_pct=0.003)
        self.assertAlmostEqual(out_frac, expected_out, places=8)

        # Both must produce identical output
        self.assertEqual(out_pct, out_frac)

    def test_net_profit_calculation_reports_correct_dex_fees(self):
        """Requirement 1, 7: _calculate_net_profit reports ~0.03 USDT DEX fees for $5 trade."""
        buy_q = {
            "spot_price": 2000.0,
            "quote_reserve": 200_000.0,
            "base_reserve": 100.0,
        }
        sell_q = {
            "spot_price": 2040.0,  # 2% spread
            "quote_reserve": 204_000.0,
            "base_reserve": 100.0,
        }

        # $5 trade
        result_5 = _calculate_net_profit(
            trade_amt=5.0,
            buy_q=buy_q,
            sell_q=sell_q,
            gas_price_gwei=1.0,
            eth_price_usdt=2000.0,
        )

        dex_fees_5 = result_5["dex_fees_usdt"]
        # Must be approximately $0.030, NEVER ~$3.02
        self.assertAlmostEqual(dex_fees_5, 0.030, places=2)
        self.assertLess(dex_fees_5, 0.05)
        self.assertGreater(dex_fees_5, 0.02)
        self.assertEqual(result_5["dex_fee_pct"], 0.30)
        self.assertEqual(result_5["dex_fee_fraction"], 0.003)

        # $100 trade: fee should be ~$0.60
        result_100 = _calculate_net_profit(
            trade_amt=100.0,
            buy_q=buy_q,
            sell_q=sell_q,
            gas_price_gwei=1.0,
            eth_price_usdt=2000.0,
        )
        self.assertAlmostEqual(result_100["dex_fees_usdt"], 0.60, delta=0.02)

        # $1000 trade: fee should be ~$6.00
        result_1000 = _calculate_net_profit(
            trade_amt=1000.0,
            buy_q=buy_q,
            sell_q=sell_q,
            gas_price_gwei=1.0,
            eth_price_usdt=2000.0,
        )
        self.assertAlmostEqual(result_1000["dex_fees_usdt"], 6.00, delta=0.20)

    def test_market_opportunity_reports_correct_dex_fees(self):
        """Requirement 7: analyze_market opportunity dictionary has correct dex_fees_usdt."""
        market = analyze_market(custom_amount=5.0)
        if market and market.get("opportunities"):
            for opp in market["opportunities"]:
                fees = opp.get("dex_fees_usdt", 0.0)
                # For $5 trade, dex_fees_usdt must be ~0.03, never ~3.00
                self.assertLess(fees, 0.05)
                self.assertGreater(fees, 0.02)


if __name__ == "__main__":
    unittest.main()
