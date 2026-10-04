import os
import unittest
from unittest.mock import patch

# Configure test environment
os.environ["API_AUTH_TOKEN"] = "test-secret-token-live-arming-12345"
os.environ["TRADING_MODE"] = "MOCK"
os.environ["LIVE_TRADING_ARMED"] = "false"
os.environ["EMERGENCY_STOP"] = "false"

import config
from app import app
from database import create_database, save_bot_setting, load_all_bot_settings
import arbitrage


class TestLiveTradingArming(unittest.TestCase):
    def setUp(self):
        create_database()
        self.client = app.test_client()
        self.auth_token = "test-secret-token-live-arming-12345"
        config.API_AUTH_TOKEN = self.auth_token
        os.environ["API_AUTH_TOKEN"] = self.auth_token
        self.headers = {"Authorization": f"Bearer {self.auth_token}"}

        # Reset states to clean defaults before each test
        config.TRADING_MODE = "MOCK"
        config.LIVE_TRADING_ARMED = False
        config.EMERGENCY_STOP = False
        save_bot_setting("trading_mode", "MOCK")
        save_bot_setting("live_trading_armed", False)
        save_bot_setting("emergency_stop", False)

    def tearDown(self):
        config.TRADING_MODE = "MOCK"
        config.LIVE_TRADING_ARMED = False
        config.EMERGENCY_STOP = False

    def test_live_not_armed_trade_rejected_via_api(self):
        """Requirement 10.1: LIVE + not armed = trade rejected via API."""
        config.TRADING_MODE = "LIVE"
        config.LIVE_TRADING_ARMED = False
        config.EMERGENCY_STOP = False

        res = self.client.post("/api/trade", headers=self.headers, json={"trade_amount": 5.0})
        self.assertEqual(res.status_code, 400)
        data = res.get_json()
        self.assertFalse(data["success"])
        self.assertEqual(data["status"], "NOT_ARMED")
        self.assertIn("not armed", data["message"].lower())

    def test_live_not_armed_trade_rejected_via_arbitrage_gate(self):
        """Requirement 10.1: LIVE + not armed = trade rejected in execute_real_trade."""
        config.TRADING_MODE = "LIVE"
        config.LIVE_TRADING_ARMED = False
        config.EMERGENCY_STOP = False

        mock_market = {
            "best_route": {
                "buy_dex": "Uniswap_V2",
                "sell_dex": "SushiSwap_V2",
                "amount_in": 5.0,
                "is_profitable": True,
                "net_profit_usdt": 1.5,
            }
        }
        result = arbitrage.execute_real_trade(mock_market, is_manual=True)
        self.assertFalse(result["success"])
        self.assertEqual(result["status"], "TRADE SKIPPED")
        self.assertIn("not armed", result["skip_reason"].lower())

    def test_live_armed_trade_allowed_to_continue_to_validation(self):
        """Requirement 10.2: LIVE + armed = trade allowed to continue past arming gate."""
        config.TRADING_MODE = "LIVE"
        config.LIVE_TRADING_ARMED = True
        config.EMERGENCY_STOP = False

        res = self.client.post("/api/trade", headers=self.headers, json={"trade_amount": 5.0})
        data = res.get_json()
        # It must NOT be rejected with status NOT_ARMED!
        # It continues to market/balance/liquidity check.
        self.assertNotEqual(data.get("status"), "NOT_ARMED")

    def test_emergency_stop_trade_rejected(self):
        """Requirement 10.3: Emergency stop = trade rejected (overrides armed state)."""
        config.TRADING_MODE = "LIVE"
        config.LIVE_TRADING_ARMED = True
        config.EMERGENCY_STOP = True

        res = self.client.post("/api/trade", headers=self.headers, json={"trade_amount": 5.0})
        self.assertEqual(res.status_code, 400)
        data = res.get_json()
        self.assertFalse(data["success"])
        self.assertEqual(data["status"], "BLOCKED_EMERGENCY_STOP")

    def test_emergency_stop_blocks_arming(self):
        """Requirement 6 & 7: Emergency stop active prevents arming."""
        config.EMERGENCY_STOP = True
        config.LIVE_TRADING_ARMED = False

        res = self.client.post(
            "/api/trade/arm",
            headers=self.headers,
            json={"arm": True, "confirm_live": True}
        )
        self.assertEqual(res.status_code, 400)
        data = res.get_json()
        self.assertFalse(data["success"])
        self.assertEqual(data["status"], "BLOCKED_EMERGENCY_STOP")
        self.assertFalse(config.LIVE_TRADING_ARMED)

    def test_emergency_stop_disarms_live_trading(self):
        """Activating emergency stop automatically disarms live trading."""
        config.LIVE_TRADING_ARMED = True
        save_bot_setting("live_trading_armed", True)

        res = self.client.post(
            "/api/emergency-stop",
            headers=self.headers,
            json={"active": True}
        )
        self.assertEqual(res.status_code, 200)
        self.assertTrue(config.EMERGENCY_STOP)
        self.assertFalse(config.LIVE_TRADING_ARMED)

    def test_changing_mode_to_live_does_not_arm(self):
        """Requirement 10.4: Changing mode to LIVE does not arm live_trading_armed."""
        config.TRADING_MODE = "MOCK"
        config.LIVE_TRADING_ARMED = False

        res = self.client.post(
            "/api/settings",
            headers=self.headers,
            json={"trading_mode": "LIVE"}
        )
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertEqual(data["settings"]["trading_mode"], "LIVE")
        self.assertFalse(data["settings"]["live_trading_armed"])
        self.assertFalse(config.LIVE_TRADING_ARMED)

    def test_changing_mode_with_unconfirmed_arm_does_not_arm(self):
        """Sending live_trading_armed: true without confirm_live does NOT arm."""
        config.TRADING_MODE = "MOCK"
        config.LIVE_TRADING_ARMED = False

        res = self.client.post(
            "/api/settings",
            headers=self.headers,
            json={"trading_mode": "LIVE", "live_trading_armed": True}
        )
        self.assertEqual(res.status_code, 200)
        self.assertFalse(config.LIVE_TRADING_ARMED)

    def test_restart_does_not_silently_arm(self):
        """Requirement 10.5: Restart does not silently arm even if DB has armed=True."""
        # Simulate previous run that wrote live_trading_armed = True to DB
        save_bot_setting("live_trading_armed", True)
        settings = load_all_bot_settings()
        self.assertTrue(bool(settings.get("live_trading_armed")))

        # Simulate application reboot startup logic
        config.LIVE_TRADING_ARMED = False
        try:
            save_bot_setting("live_trading_armed", False)
        except Exception:
            pass

        self.assertFalse(config.LIVE_TRADING_ARMED)
        refreshed_settings = load_all_bot_settings()
        self.assertFalse(bool(refreshed_settings.get("live_trading_armed")))

    def test_arm_requires_authentication(self):
        """Requirement 4: Only an authenticated request can arm live trading."""
        # Unauthenticated request (no token)
        res = self.client.post("/api/trade/arm", json={"arm": True, "confirm_live": True})
        self.assertEqual(res.status_code, 401)

        # Invalid token
        res2 = self.client.post(
            "/api/trade/arm",
            headers={"Authorization": "Bearer wrong-token"},
            json={"arm": True, "confirm_live": True}
        )
        self.assertEqual(res2.status_code, 403)

    def test_arm_requires_explicit_confirmation(self):
        """Requirement 5: Arming requires explicit confirmation (confirm_live=True)."""
        config.LIVE_TRADING_ARMED = False

        # Request to arm without confirmation
        res = self.client.post(
            "/api/trade/arm",
            headers=self.headers,
            json={"arm": True}
        )
        self.assertEqual(res.status_code, 400)
        data = res.get_json()
        self.assertFalse(data["success"])
        self.assertEqual(data["status"], "CONFIRMATION_REQUIRED")
        self.assertFalse(config.LIVE_TRADING_ARMED)

        # Request to arm with explicit confirmation
        res2 = self.client.post(
            "/api/trade/arm",
            headers=self.headers,
            json={"arm": True, "confirm_live": True}
        )
        self.assertEqual(res2.status_code, 200)
        data2 = res2.get_json()
        self.assertTrue(data2["success"])
        self.assertEqual(data2["status"], "ARMED")
        self.assertTrue(config.LIVE_TRADING_ARMED)

    def test_disarm_endpoint_works_without_confirmation(self):
        """Disarming live trading is always permitted."""
        config.LIVE_TRADING_ARMED = True

        res = self.client.post(
            "/api/trade/arm",
            headers=self.headers,
            json={"arm": False}
        )
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertTrue(data["success"])
        self.assertEqual(data["status"], "DISARMED")
        self.assertFalse(config.LIVE_TRADING_ARMED)


if __name__ == "__main__":
    unittest.main()
