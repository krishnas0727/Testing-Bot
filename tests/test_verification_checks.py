import unittest
import os
import config
from app import app
from database import create_database, save_bot_setting


class TestExplicitVerificationChecks(unittest.TestCase):
    def setUp(self):
        create_database()
        self.client = app.test_client()
        self.token = "test-verification-secret-token"
        config.API_AUTH_TOKEN = self.token
        os.environ["API_AUTH_TOKEN"] = self.token
        self.headers = {"Authorization": f"Bearer {self.token}"}

    def tearDown(self):
        config.EMERGENCY_STOP = False
        config.LIVE_TRADING_ARMED = False
        config.TRADING_MODE = "MOCK"

    def test_live_mode_never_arms_automatically(self):
        """VERIFY 4a: Confirm LIVE mode never arms automatically."""
        config.TRADING_MODE = "MOCK"
        config.LIVE_TRADING_ARMED = False
        save_bot_setting("live_trading_armed", False)

        # Switch to LIVE via settings without explicit confirm_live
        res = self.client.post("/api/settings", headers=self.headers, json={"trading_mode": "LIVE"})
        self.assertEqual(res.status_code, 200)
        self.assertFalse(config.LIVE_TRADING_ARMED, "LIVE mode armed automatically on mode switch!")

        # Attempt to set live_trading_armed without confirm_live flag
        res = self.client.post("/api/settings", headers=self.headers, json={"live_trading_armed": True})
        self.assertEqual(res.status_code, 200)
        self.assertFalse(config.LIVE_TRADING_ARMED, "LIVE mode armed without explicit confirm_live!")

    def test_emergency_stop_blocks_trading_and_withdrawal(self):
        """VERIFY 4b: Confirm EMERGENCY_STOP blocks both trading and withdrawal."""
        config.EMERGENCY_STOP = True
        config.TRADING_MODE = "LIVE"
        config.LIVE_TRADING_ARMED = True

        # 1. Blocks /api/trade
        res_trade = self.client.post("/api/trade", headers=self.headers, json={"trade_amount": 5.0})
        self.assertEqual(res_trade.status_code, 400)
        self.assertEqual(res_trade.get_json()["status"], "BLOCKED_EMERGENCY_STOP")

        # 2. Blocks /api/treasury/withdraw
        res_withdraw = self.client.post(
            "/api/treasury/withdraw",
            headers=self.headers,
            json={
                "amount": 10.0,
                "token": "USDC",
                "recipient_address": "0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1",
                "mode": "LIVE"
            }
        )
        self.assertEqual(res_withdraw.status_code, 400)
        self.assertEqual(res_withdraw.get_json()["status"], "BLOCKED_EMERGENCY_STOP")

    def test_api_trade_returns_401_without_token(self):
        """VERIFY 4c: Confirm /api/trade returns 401 without API token."""
        config.EMERGENCY_STOP = False
        res = self.client.post("/api/trade", json={"trade_amount": 5.0})
        self.assertEqual(res.status_code, 401)
        self.assertFalse(res.get_json()["success"])
        self.assertIn("Unauthorized", res.get_json()["message"])


if __name__ == "__main__":
    unittest.main()
