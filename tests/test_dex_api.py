import json
import unittest
from unittest.mock import patch

from app import app
import config


class DEXApiTests(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()
        self.client.testing = True

    def test_health_check(self):
        res = self.client.get("/api/health")
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertTrue(data["success"])
        self.assertIn("mode", data)
        self.assertIn("dexes", data)
        self.assertIn("Uniswap_V2", data["dexes"])

    def test_market_endpoint(self):
        res = self.client.get("/api/market")
        self.assertIn(res.status_code, [200, 503])
        data = res.get_json()
        if res.status_code == 200:
            self.assertTrue(data["success"])
            self.assertIn("data", data)
            self.assertIn("wallet", data)
            self.assertIn("summary", data)

    def test_prices_endpoint(self):
        res = self.client.get("/api/prices")
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertTrue(data["success"])
        self.assertIn("quotes", data)
        self.assertIn("prices", data)

    def test_wallet_endpoint(self):
        res = self.client.get("/api/wallet")
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertTrue(data["success"])
        self.assertIn("wallet", data)
        self.assertIn("eth", data["wallet"])
        self.assertIn("usdt", data["wallet"])

    def test_contract_metadata_endpoint(self):
        res = self.client.get("/api/contract")
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertTrue(data["success"])
        self.assertIn("abi", data)
        self.assertIn("routers", data)

    def test_settings_get_and_post(self):
        res = self.client.get("/api/settings")
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertTrue(data["success"])
        self.assertIn("settings", data)

        # Update settings
        update_res = self.client.post("/api/settings", json={
            "trade_amount": 150.0,
            "min_profit": 0.75,
            "slippage_pct": 0.40,
        })
        self.assertEqual(update_res.status_code, 200)
        up_data = update_res.get_json()
        self.assertTrue(up_data["success"])
        self.assertEqual(up_data["settings"]["trade_amount"], 150.0)

    def test_emergency_stop_toggle(self):
        res = self.client.post("/api/emergency-stop", json={"active": True})
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertTrue(data["success"])
        self.assertTrue(data["emergency_stop"])
        # Restore inactive
        self.client.post("/api/emergency-stop", json={"active": False})

    def test_trade_simulate_endpoint(self):
        res = self.client.post("/api/trade/simulate", json={"trade_amount": 100.0})
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertIn("status", data)

    def test_market_summary_zero_when_disconnected_or_emergency(self):
        # 1. Disconnected wallet test
        orig_wallet = config.WALLET_ADDRESS
        config.WALLET_ADDRESS = ""
        try:
            res = self.client.get("/api/market")
            if res.status_code == 200:
                summary = res.get_json()["summary"]
                self.assertFalse(summary["is_wallet_connected"])
                self.assertEqual(summary["total_profit"], 0.0)
                self.assertEqual(summary["total_trades"], 0)
        finally:
            config.WALLET_ADDRESS = orig_wallet

        # 2. Emergency stop active test
        self.client.post("/api/emergency-stop", json={"active": True})
        try:
            res = self.client.get("/api/market")
            if res.status_code == 200:
                summary = res.get_json()["summary"]
                self.assertEqual(summary["total_profit"], 0.0)
                self.assertEqual(summary["total_trades"], 0)
        finally:
            self.client.post("/api/emergency-stop", json={"active": False})

    def test_trades_mode_filtering(self):
        import database
        # Insert a simulated trade and a live trade
        database.save_trade({
            "tx_hash": "0xsimulated123",
            "mode": "SIMULATION",
            "net_profit": 1.5,
            "status": "CONFIRMED"
        })
        database.save_trade({
            "tx_hash": "0xlive456",
            "mode": "LIVE",
            "net_profit": 2.5,
            "status": "CONFIRMED"
        })

        live_res = self.client.get("/api/trades?mode=LIVE").get_json()
        sim_res = self.client.get("/api/trades?mode=SIMULATION").get_json()

        live_hashes = [t["tx_hash"] for t in live_res["trades"]]
        sim_hashes = [t["tx_hash"] for t in sim_res["trades"]]

        self.assertIn("0xlive456", live_hashes)
        self.assertNotIn("0xsimulated123", live_hashes)

        self.assertIn("0xsimulated123", sim_hashes)
        self.assertNotIn("0xlive456", sim_hashes)

        # Clean up
        database.delete_all_trades()

    def test_wallet_connect_and_disconnect(self):
        # Test valid connect
        res = self.client.post("/api/wallet/connect", json={
            "address": "0x71C8BF422005A3Db0782F434914f6b15Ac5c0c6E"
        })
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertTrue(data["success"])
        self.assertEqual(data["wallet"]["wallet_address"], "0x71C8BF422005A3Db0782F434914f6b15Ac5c0c6E")
        self.assertTrue(data["wallet"]["is_connected"])
        self.assertEqual(config.WALLET_ADDRESS, "0x71C8BF422005A3Db0782F434914f6b15Ac5c0c6E")

        # Test disconnect
        res_dc = self.client.post("/api/wallet/disconnect", json={})
        self.assertEqual(res_dc.status_code, 200)
        dc_data = res_dc.get_json()
        self.assertTrue(dc_data["success"])
        self.assertFalse(dc_data["wallet"]["is_connected"])
        self.assertEqual(config.WALLET_ADDRESS, "")

        # Test invalid format rejection
        res_bad = self.client.post("/api/wallet/connect", json={"address": "invalid_address"})
        self.assertEqual(res_bad.status_code, 400)
        self.assertFalse(res_bad.get_json()["success"])

    def test_base_l2_defaults_and_registry(self):
        """Verify Base L2 (8453) is present in registry with official RPCs and token configs."""
        self.assertIn(8453, config.CHAIN_REGISTRY)
        base_info = config.CHAIN_REGISTRY[8453]
        self.assertEqual(base_info["chain_id"], 8453)
        self.assertEqual(base_info["name"], "base")
        self.assertEqual(base_info["currency"], "ETH")
        self.assertIn("tokens", base_info)
        self.assertIn("WETH", base_info["tokens"])
        self.assertIn("USDC", base_info["tokens"])
        self.assertIn("USDT", base_info["tokens"])

    def test_chain_switch_endpoint(self):
        """Test on-the-fly network switching via /api/chain/switch."""
        # Switch to Arbitrum (42161)
        res_arb = self.client.post("/api/chain/switch", json={"chain_id": 42161})
        self.assertEqual(res_arb.status_code, 200)
        data_arb = res_arb.get_json()
        self.assertTrue(data_arb["success"])
        self.assertEqual(data_arb["chain_id"], 42161)
        self.assertEqual(config.CHAIN_ID, 42161)

        # Switch to Polygon (137)
        res_poly = self.client.post("/api/chain/switch", json={"chain_id": 137})
        self.assertEqual(res_poly.status_code, 200)
        self.assertEqual(config.CHAIN_ID, 137)

        # Switch back to Base L2 (8453)
        res_base = self.client.post("/api/chain/switch", json={"chain_id": 8453})
        self.assertEqual(res_base.status_code, 200)
        self.assertEqual(config.CHAIN_ID, 8453)
        self.assertEqual(config.DEFAULT_CHAIN, "base")

        # Test invalid chain rejection
        res_invalid = self.client.post("/api/chain/switch", json={"chain_id": 999999})
        self.assertEqual(res_invalid.status_code, 400)
        self.assertFalse(res_invalid.get_json()["success"])

    def test_chains_api_endpoint(self):
        """Test GET /api/chains returns registry of supported chains."""
        res = self.client.get("/api/chains")
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertTrue(data["success"])
        self.assertIn("chains", data)
        self.assertIn("8453", data["chains"])

    def test_all_pairs_endpoint(self):
        """Verify GET /api/market/all-pairs returns multi-pair scan data."""
        res = self.client.get("/api/market/all-pairs")
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertTrue(data["success"])
        self.assertIn("pairs", data)
        self.assertIn("chain_id", data)

    def test_switch_pair_endpoint(self):
        """Verify POST /api/pair/switch updates trading pair."""
        orig_symbol = config.SYMBOL
        try:
            res = self.client.post("/api/pair/switch", json={"symbol": "WETH/USDT"})
            self.assertEqual(res.status_code, 200)
            data = res.get_json()
            self.assertTrue(data["success"])
            self.assertEqual(config.SYMBOL, "WETH/USDT")
        finally:
            config.SYMBOL = orig_symbol

    def test_flashloan_calculate_endpoint(self):
        """Verify POST /api/flashloan/calculate returns Aave V3 simulation."""
        res = self.client.post("/api/flashloan/calculate", json={"amount": 10000.0})
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertTrue(data["success"])
        self.assertEqual(data["borrow_amount_usd"], 10000.0)
        self.assertIn("flashloan_fee_usd", data)
        self.assertIn("net_profit_usd", data)
        self.assertEqual(data["fee_pct"], 0.05)

    def test_trades_export_csv_and_json(self):
        """Verify GET /api/trades/export exports both CSV and JSON formats."""
        # Test JSON export
        res_json = self.client.get("/api/trades/export?format=json")
        self.assertEqual(res_json.status_code, 200)
        data = res_json.get_json()
        self.assertTrue(data["success"])
        self.assertIn("trades", data)

        # Test CSV export
        res_csv = self.client.get("/api/trades/export?format=csv")
        self.assertEqual(res_csv.status_code, 200)
        self.assertEqual(res_csv.content_type, "text/csv; charset=utf-8")
        self.assertIn("Tx Hash", res_csv.get_data(as_text=True))

    def test_execution_logs_endpoint(self):
        """Verify GET /api/execution-logs returns rolling execution diagnostics."""
        res = self.client.get("/api/execution-logs")
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertTrue(data["success"])
        self.assertIn("logs", data)
        self.assertIn("execution_status", data)
        self.assertIsInstance(data["logs"], list)


if __name__ == "__main__":
    unittest.main()
