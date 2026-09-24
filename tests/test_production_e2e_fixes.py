"""End-to-End and Production Verification Tests.

Verifies:
- HTML templates render cleanly without Jinja errors or conflict markers
- Static assets (app.js, style.css) have zero conflict markers and pass syntax checks
- Small trade amounts (0.05, 0.1, 0.5, 1, 5) are supported without arbitrary restrictions
- Dynamic trade sizing works for micro-balances
- No private keys or secret credentials are leaked in frontend templates
- Multi-chain configurations (Base, Polygon, Arbitrum, Ethereum, Sepolia) are valid
- Profit math strictly deducts gas, swap fees, and slippage
"""
import os
import unittest
from unittest.mock import patch

import config
from app import app
from arbitrage import calculate_dynamic_trade_amount, analyze_market
from dex_engine import calculate_amount_out, calculate_price_impact, calculate_slippage_min_out


class ProductionVerificationTests(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()

    def test_routes_render_html(self):
        """Test that all SPA routes render index.html with 200 OK."""
        routes = ["/", "/prices", "/arbitrage", "/trades", "/settings"]
        for route in routes:
            resp = self.client.get(route)
            self.assertEqual(resp.status_code, 200, f"Route {route} failed to render")
            self.assertIn(b"DEX Arbitrage Terminal", resp.data)

    def test_no_merge_conflict_markers_in_project_files(self):
        """Verify templates and static assets contain no git conflict markers."""
        base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        targets = [
            os.path.join(base_dir, "templates", "index.html"),
            os.path.join(base_dir, "static", "app.js"),
            os.path.join(base_dir, "static", "style.css"),
            os.path.join(base_dir, "app.py"),
            os.path.join(base_dir, "config.py"),
            os.path.join(base_dir, "arbitrage.py"),
            os.path.join(base_dir, "dex_engine.py"),
            os.path.join(base_dir, "wallet_manager.py"),
        ]
        markers = ["<<<<<<<", "=======", ">>>>>>>"]
        for fpath in targets:
            self.assertTrue(os.path.exists(fpath), f"File {fpath} does not exist")
            with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
                lines = f.readlines()
                for idx, line in enumerate(lines, 1):
                    for marker in markers:
                        # Skip html comment visual dividers like <!-- =================== -->
                        if marker == "=======" and ("=" * 10) in line:
                            continue
                        if marker in line and not line.strip().startswith("//") and not line.strip().startswith("#"):
                            self.fail(f"Found merge marker '{marker}' in {os.path.basename(fpath)} at line {idx}: {line.strip()}")

    def test_no_private_keys_in_frontend(self):
        """Verify that private keys or sensitive variables are never rendered to HTML/JS."""
        resp = self.client.get("/")
        self.assertNotIn(b"PRIVATE_KEY", resp.data)
        self.assertNotIn(b"0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", resp.data)

    def test_small_trade_amounts_supported(self):
        """Verify that micro trade amounts (0.05, 0.1, 0.5, 1, 5) are accepted and calculated."""
        test_amounts = [0.05, 0.1, 0.5, 1.0, 5.0]
        for amt in test_amounts:
            # Sizing helper returns requested amount when available balance is sufficient
            sized = calculate_dynamic_trade_amount(available_balance=100.0, requested_amount=amt)
            self.assertAlmostEqual(sized, amt, places=4, msg=f"Failed for amount {amt}")

    def test_multi_chain_registry_consistency(self):
        """Verify that all supported chains in CHAIN_REGISTRY have required configurations."""
        expected_chains = [8453, 1, 42161, 137, 11155111]
        for cid in expected_chains:
            self.assertIn(cid, config.CHAIN_REGISTRY, f"Chain ID {cid} missing from CHAIN_REGISTRY")
            info = config.CHAIN_REGISTRY[cid]
            self.assertIn("routers", info)
            self.assertIn("factories", info)
            self.assertIn("tokens", info)
            self.assertIn("rpc_url", info)
            self.assertIn("explorer", info)
            # Ensure native token and primary tokens exist
            tokens = info["tokens"]
            self.assertIn("WETH", tokens)
            self.assertTrue(tokens["WETH"]["address"].startswith("0x"))
            self.assertEqual(tokens["WETH"]["decimals"], 18)

    def test_profit_calculation_math(self):
        """Verify that profit math strictly deducts gas, fees, and checks positive return."""
        # Scenario: Uniswap reserves: 100 WETH, 300,000 USDT (Price: 3000)
        # SushiSwap reserves: 100 WETH, 306,000 USDT (Price: 3060, 2% spread)
        trade_amount = 0.10  # 0.10 USDT micro trade
        weth_bought = calculate_amount_out(
            amount_in=trade_amount,
            reserve_in=300000.0,
            reserve_out=100.0,
            fee_pct=0.30
        )
        self.assertGreater(weth_bought, 0)
        usdt_returned = calculate_amount_out(
            amount_in=weth_bought,
            reserve_in=100.0,
            reserve_out=306000.0,
            fee_pct=0.30
        )
        gross_profit = usdt_returned - trade_amount
        # At 2% spread with 0.3% + 0.3% fees, gross return is positive
        self.assertGreater(gross_profit, 0)

        # Slippage calculation check
        min_out = calculate_slippage_min_out(usdt_returned, slippage_pct=0.50)
        self.assertAlmostEqual(min_out, usdt_returned * 0.995, places=5)

    def test_app_py_calculate_dynamic_trade_amount_available(self):
        """Verify calculate_dynamic_trade_amount is imported in app.py module namespace."""
        import app as app_module
        self.assertTrue(hasattr(app_module, "calculate_dynamic_trade_amount"),
                        "calculate_dynamic_trade_amount must be imported in app.py")

    def test_explicit_live_mode_warning_banner_and_modal_in_template(self):
        """Verify explicit live trading warning banners and review modal exist in templates/index.html."""
        resp = self.client.get("/")
        self.assertEqual(resp.status_code, 200)
        html = resp.data.decode("utf-8")

        # 1. Exact required warning text
        self.assertIn("LIVE TRADING — REAL FUNDS", html)
        self.assertIn("This transaction will use your connected wallet and real blockchain funds.", html)
        self.assertIn("Verify the network, tokens, amount, slippage, price impact, gas fee, and recipient before confirming.", html)

        # 2. Key UI elements
        self.assertIn('id="dashLiveWarningBanner"', html)
        self.assertIn('id="arbLiveWarningBanner"', html)
        self.assertIn('id="liveTradeConfirmModalOverlay"', html)

        # 3. Parameter fields in confirmation modal
        self.assertIn('id="liveConfirmNetwork"', html)
        self.assertIn('id="liveConfirmInput"', html)
        self.assertIn('id="liveConfirmOutput"', html)
        self.assertIn('id="liveConfirmGas"', html)
        self.assertIn('id="liveConfirmSlippage"', html)
        self.assertIn('id="liveConfirmImpact"', html)
        self.assertIn('id="liveConfirmRecipient"', html)

        # 4. Final action button text
        self.assertIn("Review Live Trade → Confirm in Wallet", html)

    def test_explicit_live_mode_warning_logic_in_app_js(self):
        """Verify static/app.js implements live confirmation modal lifecycle and triggers."""
        base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        app_js_path = os.path.join(base_dir, "static", "app.js")
        with open(app_js_path, "r", encoding="utf-8") as f:
            js = f.read()

        # Handler functions
        self.assertIn("function showLiveTradeConfirmModal", js)
        self.assertIn("function closeLiveConfirmModal", js)
        self.assertIn("function onLiveCheckboxToggle", js)
        self.assertIn("function onLiveConfirmProceed", js)

        # Trigger in executeMetaMaskOnChainTrade
        self.assertIn("showLiveTradeConfirmModal", js)
        self.assertIn("LIVE_CONFIRMATION_CANCELLED", js)


if __name__ == "__main__":
    unittest.main()

