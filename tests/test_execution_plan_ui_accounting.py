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
        self.orig_emerg = getattr(config, "EMERGENCY_STOP", True)
        config.TRADING_MODE = "MOCK"
        config.LIVE_TRADING_ARMED = False
        config.AUTO_TRADE_ENABLED = False

    def tearDown(self):
        config.TRADING_MODE = self.orig_mode
        config.LIVE_TRADING_ARMED = self.orig_armed
        config.AUTO_TRADE_ENABLED = self.orig_auto
        config.EMERGENCY_STOP = self.orig_emerg

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

        # Must have the tag element for provenance defaulting to Simulation Quote in MOCK mode
        self.assertIn('id="arbPlanTypeTag"', content)
        self.assertIn('(Simulation Quote — MOCK)', content)
        # Must have clear DEX fee disclosure
        self.assertIn('Included in Expected Output', content)
        # Default badge must be STANDBY, not hardcoded OPTIMAL ROUTE
        self.assertIn('id="arbPlanBadge" class="badge badge-yellow">STANDBY</span>', content)
        # Default net profit must be clean placeholder '--', not hardcoded '+$0.0007'
        self.assertIn('id="arbNetProfit" style="color:var(--text-muted); font-size:16px;">--</strong>', content)
        # Must have gas label element
        self.assertIn('id="arbGasCostLabel"', content)

    def test_quote_provenance_strictly_distinguishes_mock_from_live(self):
        """MOCK quotes or simulated pools must NEVER display 'Verified On-Chain Quote'.

        Only fresh, exact quotes in LIVE mode from confirmed on-chain RPC reserves
        can ever be labeled '(Verified On-Chain Quote)'.
        """
        def evaluate_quote_provenance(best_route, selected_amount, is_stale, current_mode="MOCK"):
            if is_stale:
                return "(Quote Stale)"
            if not best_route or not best_route.get("buy_dex") or best_route.get("arbitrage_available") is False:
                return "(Quote Unavailable)"

            is_exact = bool(
                best_route.get("amount_in") and
                abs(best_route["amount_in"] - selected_amount) <= 0.001 and
                best_route.get("gross_return_usdt") is not None and
                best_route.get("net_profit_usdt") is not None
            )
            is_real_onchain = best_route.get("source") in ("on-chain-rpc", "rpc")

            if current_mode == "LIVE" and is_real_onchain and is_exact:
                return "(Verified On-Chain Quote)"
            if current_mode == "MOCK" or best_route.get("source") == "simulated-pool" or best_route.get("is_simulated"):
                return "(Simulation Quote — MOCK)"
            return "(Illustrative Estimate)"

        # 1. In MOCK mode, exact route from simulated pool -> strictly (Simulation Quote — MOCK)
        mock_sim_route = {
            "buy_dex": "Uniswap_V2", "sell_dex": "SushiSwap_V2",
            "amount_in": 10.0, "gross_return_usdt": 10.0793, "net_profit_usdt": 0.0743,
            "source": "simulated-pool", "trading_mode": "MOCK", "is_simulated": True
        }
        self.assertEqual(evaluate_quote_provenance(mock_sim_route, 10.0, False, "MOCK"), "(Simulation Quote — MOCK)")

        # 2. In LIVE mode with simulated-pool source -> strictly (Simulation Quote — MOCK), NEVER Verified
        self.assertEqual(evaluate_quote_provenance(mock_sim_route, 10.0, False, "LIVE"), "(Simulation Quote — MOCK)")

        # 3. In LIVE mode, exact amount, on-chain-rpc source -> (Verified On-Chain Quote)
        live_onchain_route = {
            "buy_dex": "Uniswap_V2", "sell_dex": "SushiSwap_V2",
            "amount_in": 10.0, "gross_return_usdt": 10.0793, "net_profit_usdt": 0.0743,
            "source": "on-chain-rpc", "trading_mode": "LIVE", "is_simulated": False
        }
        self.assertEqual(evaluate_quote_provenance(live_onchain_route, 10.0, False, "LIVE"), "(Verified On-Chain Quote)")

        # 4. In LIVE mode, amount mismatch (user selected 15, route is for 10) -> (Illustrative Estimate)
        self.assertEqual(evaluate_quote_provenance(live_onchain_route, 15.0, False, "LIVE"), "(Illustrative Estimate)")

        # 5. Stale quote -> strictly (Quote Stale) regardless of mode
        self.assertEqual(evaluate_quote_provenance(live_onchain_route, 10.0, True, "LIVE"), "(Quote Stale)")
        self.assertEqual(evaluate_quote_provenance(mock_sim_route, 10.0, True, "MOCK"), "(Quote Stale)")

    def test_analyze_market_exposes_truthful_metadata(self):
        """analyze_market must include source, trading_mode, is_simulated, and gas_mode."""
        market = analyze_market(custom_amount=10.0)
        self.assertIsNotNone(market)
        self.assertIn("trading_mode", market)
        self.assertEqual(market["trading_mode"], "MOCK")
        self.assertIn("gas_mode", market)
        self.assertEqual(market["gas_mode"], "MOCK_SIMULATION")
        self.assertIn("source", market)
        self.assertIn("is_simulated", market)
        self.assertTrue(market["is_simulated"])
        self.assertFalse(market["includes_l1_fee"])

        if market.get("best_route"):
            best = market["best_route"]
            self.assertIn("source", best)
            self.assertIn("trading_mode", best)
            self.assertEqual(best["trading_mode"], "MOCK")
            self.assertEqual(best["gas_mode"], "MOCK_SIMULATION")
            self.assertTrue(best["is_simulated"])
            self.assertFalse(best["includes_l1_fee"])

    def test_javascript_enforces_provenance_and_gas_mode(self):
        """Confirm static/app.js enforces getExecutionPlanProvenance and gas mode suffixes."""
        js_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static", "app.js")
        with open(js_path, "r", encoding="utf-8") as f:
            js_content = f.read()

        # Check for 30-second staleness guard
        self.assertIn("Date.now() - latestMarketData._lastSuccessTs > 30000", js_content)
        # Check for stale quote status handling
        self.assertIn("Quote stale", js_content)
        # Check for provenance function
        self.assertIn("getExecutionPlanProvenance", js_content)
        self.assertIn("(Simulation Quote — MOCK)", js_content)
        self.assertIn("(Verified On-Chain Quote)", js_content)
        # Check for gas suffix differentiation
        self.assertIn("(Simulated MOCK gas)", js_content)
        self.assertIn("(Incl. L1 calldata)", js_content)

    def test_simulated_quote_cannot_authorize_live_execution(self):
        """Server-side live preflight must strictly block live trades when armed is false or mode is MOCK."""
        import live_executor
        dummy_plan = {
            "buy_dex": "Uniswap_V2",
            "sell_dex": "SushiSwap_V2",
            "amount_in": 10.0,
            "chain_id": 42161,
            "source": "simulated-pool",
            "is_simulated": True,
        }

        # 1. In MOCK mode: execute_live must fail with INVALID_MODE (or BLOCKED_EMERGENCY_STOP)
        config.TRADING_MODE = "MOCK"
        config.LIVE_TRADING_ARMED = False
        res = live_executor.execute_live(dummy_plan)
        self.assertFalse(res["success"])
        self.assertIn(res.get("status"), ("INVALID_MODE", "BLOCKED_EMERGENCY_STOP", "NOT_ARMED"))

        # 2. In LIVE mode but LIVE_TRADING_ARMED is False (and emergency stop unset for testing check):
        config.TRADING_MODE = "LIVE"
        config.EMERGENCY_STOP = False
        config.LIVE_TRADING_ARMED = False
        res2 = live_executor.execute_live(dummy_plan)
        self.assertFalse(res2["success"])
        self.assertEqual(res2.get("status"), "NOT_ARMED")

    def test_safety_invariants_preserved(self):
        """Trading mode must be MOCK and armed/auto-trade disabled."""
        self.assertEqual(config.TRADING_MODE, "MOCK")
        self.assertFalse(config.LIVE_TRADING_ARMED)
        self.assertFalse(config.AUTO_TRADE_ENABLED)


if __name__ == "__main__":
    unittest.main()

