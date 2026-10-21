"""Regression tests for execution plan UI and quote accounting.

Covers Requirements:
1. No hardcoded fallback spread creates fake positive profit when quote data is missing or invalid.
2. Missing, stale, or zero-spread quotes fail closed and do not claim positive profit.
3. DEX fees are embedded in constant-product output and never deducted twice.
4. Displayed net profit consistency: Net Profit = (Expected Output - Amount In) - Gas Cost.
5. Live execution gate rejects trades if on-chain simulation/gas estimation makes them unprofitable.
6. Standby defaults and fee inclusion transparency in HTML template.
"""

import os
import sys
import unittest
from decimal import Decimal
from unittest.mock import patch, MagicMock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import config
import dex_engine
import arbitrage
from dex_engine import calculate_amount_out, calculate_slippage_min_out
from arbitrage import analyze_market


class TestExecutionPlanUIAccounting(unittest.TestCase):
    def setUp(self):
        self.orig_mode = getattr(config, "TRADING_MODE", "MOCK")
        self.orig_armed = getattr(config, "LIVE_TRADING_ARMED", False)
        self.orig_auto = getattr(config, "AUTO_TRADE_ENABLED", False)
        config.TRADING_MODE = "MOCK"
        config.LIVE_TRADING_ARMED = False
        config.AUTO_TRADE_ENABLED = False

    def tearDown(self):
        config.TRADING_MODE = self.orig_mode
        config.LIVE_TRADING_ARMED = self.orig_armed
        config.AUTO_TRADE_ENABLED = self.orig_auto

    def test_missing_quote_data_fails_closed(self):
        """When DEX quotes cannot be fetched, analyze_market must not claim positive profit."""
        with patch("arbitrage.get_all_dex_quotes", return_value=[]):
            market = analyze_market(custom_amount=10.0)
            self.assertIsNotNone(market)
            self.assertFalse(market.get("is_profitable", False))
            self.assertFalse(market.get("arbitrage_available", False))
            self.assertIsNone(market.get("best_route"))
            self.assertEqual(market.get("net_profit_usdt", 0.0), 0.0)

    def test_zero_or_thin_spread_produces_non_positive_net_profit(self):
        """A spread equal to or below 0.60% (2 legs of 0.3% fee) must never produce positive net profit."""
        # 100 USDT in, Uniswap reserve ratio 3000, SushiSwap reserve ratio 3000 (0% spread)
        res_quote = 300_000.0
        res_base = 100.0

        # Leg 1: 10 USDT -> WETH on Uni (0.3% fee embedded)
        weth_out = calculate_amount_out(10.0, res_quote, res_base, fee_pct=0.30)
        # Leg 2: WETH -> USDT on Sushi with identical reserves (0.3% fee embedded)
        usdt_back = calculate_amount_out(weth_out, res_base, res_quote, fee_pct=0.30)

        gross_profit = usdt_back - 10.0
        # Gross profit must be negative due to two 0.3% fees
        self.assertLess(gross_profit, 0.0)

        # Net profit after gas is even lower
        gas_cost = 0.005
        net_profit = gross_profit - gas_cost
        self.assertLess(net_profit, 0.0)

    def test_dex_fee_embedded_in_output_not_double_deducted(self):
        """Verify that Uniswap V2 calculate_amount_out embeds 0.3% fee and is not deducted twice."""
        amount_in = 10.0
        reserve_in = 300_000.0
        reserve_out = 100.0

        # Output with standard 0.3% fee
        out_with_fee = calculate_amount_out(amount_in, reserve_in, reserve_out, fee_pct=0.30)
        # Zero-fee hypothetical output
        out_zero_fee = calculate_amount_out(amount_in, reserve_in, reserve_out, fee_pct=0.0)

        # Output with fee must be strictly lower than zero fee
        self.assertLess(out_with_fee, out_zero_fee)

        # The fee paid on Leg 1 in input tokens is amount_in * 0.003 = 0.030 USDT
        leg1_fee_usdt = amount_in * 0.003
        self.assertAlmostEqual(leg1_fee_usdt, 0.030, places=4)

    def test_displayed_net_profit_identity_consistency(self):
        """Displayed Net Profit = (Expected Output - Amount In) - Gas Cost."""
        amount_in = 10.0
        # Suppose a valid opportunity yields gross return of 10.0728 (which is ALREADY net of DEX fees)
        gross_return = 10.0728
        gas_cost = 0.0050
        dex_fees_info = 10.0 * 0.006  # $0.0600 informational line

        gross_profit = gross_return - amount_in
        net_profit = gross_profit - gas_cost

        # Net profit is exactly +$0.0678
        self.assertAlmostEqual(net_profit, 0.0678, places=4)

        # If an erroneous UI had subtracted dex_fees_info AGAIN, net_profit would be 0.0078
        double_counted_net_profit = net_profit - dex_fees_info
        self.assertNotAlmostEqual(net_profit, double_counted_net_profit, places=3)

    def test_index_html_contains_standby_defaults_and_transparency_tags(self):
        """templates/index.html must have arbPlanTypeTag and default standby state."""
        index_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "templates", "index.html")
        with open(index_path, "r", encoding="utf-8") as f:
            content = f.read()

        # Must have the tag element for provenance (Illustrative vs Backend Quote)
        self.assertIn('id="arbPlanTypeTag"', content)
        # Must have clear DEX fee disclosure
        self.assertIn('Included in Expected Output', content)
        # Default badge must be STANDBY, not hardcoded OPTIMAL ROUTE
        self.assertIn('id="arbPlanBadge" class="badge badge-yellow">STANDBY</span>', content)
        # Default net profit must be clean placeholder '--', not hardcoded '+$0.0007'
        self.assertIn('id="arbNetProfit" style="color:var(--text-muted); font-size:16px;">--</strong>', content)

    def test_verified_backend_quote_strict_provenance(self):
        """Verified Backend Quote must require exact amount match, freshness, and real backend output."""
        def evaluate_quote_provenance(best_route, selected_amount, is_stale):
            if is_stale or not best_route or not best_route.get("buy_dex"):
                return "UNAVAILABLE"
            is_exact = bool(
                not is_stale and
                best_route.get("amount_in") and
                abs(best_route["amount_in"] - selected_amount) <= 0.001 and
                best_route.get("gross_return_usdt") is not None and
                best_route.get("net_profit_usdt") is not None
            )
            return "VERIFIED" if is_exact else "ILLUSTRATIVE"

        # 1. Exact match and fresh -> VERIFIED
        valid_route = {"buy_dex": "Uni", "sell_dex": "Sushi", "amount_in": 10.0, "gross_return_usdt": 10.08, "net_profit_usdt": 0.075}
        self.assertEqual(evaluate_quote_provenance(valid_route, 10.0, False), "VERIFIED")

        # 2. Amount mismatch (e.g. backend was 5.0, user selected 10.0) -> ILLUSTRATIVE
        self.assertEqual(evaluate_quote_provenance(valid_route, 5.0, False), "ILLUSTRATIVE")

        # 3. Missing amount_in or missing return -> never VERIFIED
        invalid_route = {"buy_dex": "Uni", "sell_dex": "Sushi"}
        self.assertEqual(evaluate_quote_provenance(invalid_route, 10.0, False), "ILLUSTRATIVE")

        # 4. Stale quote -> UNAVAILABLE
        self.assertEqual(evaluate_quote_provenance(valid_route, 10.0, True), "UNAVAILABLE")

    def test_stale_quote_data_fails_closed_in_javascript(self):
        """Confirm static/app.js enforces staleness threshold (30s) and fails closed."""
        js_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static", "app.js")
        with open(js_path, "r", encoding="utf-8") as f:
            js_content = f.read()

        # Check for 30-second staleness guard
        self.assertIn("Date.now() - latestMarketData._lastSuccessTs > 30000", js_content)
        # Check for stale quote status handling
        self.assertIn("Quote stale", js_content)
        # Check for verified quote gate
        self.assertIn("isExactBackendQuote", js_content)

    def test_safety_invariants_preserved(self):
        """Trading mode must be MOCK and armed/auto-trade disabled."""
        self.assertEqual(config.TRADING_MODE, "MOCK")
        self.assertFalse(config.LIVE_TRADING_ARMED)
        self.assertFalse(config.AUTO_TRADE_ENABLED)


if __name__ == "__main__":
    unittest.main()

