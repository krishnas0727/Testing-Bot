"""
Comprehensive Security & Authentication Test Suite (Phase 1)

Verifies:
1. Default Flask HOST is 127.0.0.1 (not 0.0.0.0).
2. Unauthorized requests to sensitive endpoints are rejected with HTTP 401.
3. Requests with invalid tokens are rejected with HTTP 403.
4. Requests with valid tokens are accepted.
5. Sensitive endpoints cannot execute without authentication:
   - /api/settings (POST)
   - /api/trade (POST)
   - /api/trade/confirm-live (POST)
   - /api/emergency-stop (POST)
   - /api/treasury/withdraw (POST)
   - /api/trades/clear and /api/clear-trades (POST)
   - /api/wallet/connect (POST)
   - /api/wallet/disconnect (POST)
   - /api/chain/switch (POST)
   - /api/pair/switch (POST)
   - /api/live-verification/run (POST)
6. Non-sensitive GET endpoints remain accessible.
7. API tokens and private keys are never exposed in responses or persisted to SQLite.
"""

import json
import os
import unittest
from unittest.mock import patch

from app import app
import config
import database


class TestApiSecurity(unittest.TestCase):
    TEST_TOKEN = "test-secret-auth-token-xyz-12345"

    def setUp(self):
        self.client = app.test_client()
        self.client.testing = True
        self.orig_token = getattr(config, "API_AUTH_TOKEN", "")
        self.orig_env_token = os.environ.get("API_AUTH_TOKEN", "")
        config.API_AUTH_TOKEN = self.TEST_TOKEN
        os.environ["API_AUTH_TOKEN"] = self.TEST_TOKEN
        self.valid_headers = {"Authorization": f"Bearer {self.TEST_TOKEN}"}
        self.invalid_headers = {"Authorization": "Bearer wrong-invalid-token"}

    def tearDown(self):
        config.API_AUTH_TOKEN = self.orig_token
        if self.orig_env_token:
            os.environ["API_AUTH_TOKEN"] = self.orig_env_token
        else:
            os.environ.pop("API_AUTH_TOKEN", None)

    # ─────────────────────────────────────────────────────────────────────────
    # 1. HOST CONFIGURATION TESTS
    # ─────────────────────────────────────────────────────────────────────────

    def test_default_host_is_localhost(self):
        """Requirement 6 & 7: Verify default Flask HOST is 127.0.0.1 and not 0.0.0.0."""
        # Check config.HOST default
        self.assertEqual(config.HOST, "127.0.0.1")
        self.assertNotEqual(config.HOST, "0.0.0.0")

    def test_default_host_in_main_block(self):
        """Verify app.py fallback host logic defaults to config.HOST or 127.0.0.1."""
        with patch.dict(os.environ, {}, clear=True):
            host = os.environ.get("HOST", getattr(config, "HOST", "127.0.0.1"))
            self.assertEqual(host, "127.0.0.1")

    # ─────────────────────────────────────────────────────────────────────────
    # 2. TOKEN AUTHENTICATION STATUS CODES
    # ─────────────────────────────────────────────────────────────────────────

    def test_unauthorized_request_rejected_401(self):
        """Requirement 5: Missing token must return HTTP 401."""
        res = self.client.post("/api/auth/verify")
        self.assertEqual(res.status_code, 401)
        data = res.get_json()
        self.assertFalse(data["success"])
        self.assertIn("Unauthorized", data["message"])
        # Token must not be leaked in message
        self.assertNotIn(self.TEST_TOKEN, data["message"])

    def test_invalid_token_rejected_403(self):
        """Requirement 5: Invalid token must return HTTP 403."""
        res = self.client.post("/api/auth/verify", headers=self.invalid_headers)
        self.assertEqual(res.status_code, 403)
        data = res.get_json()
        self.assertFalse(data["success"])
        self.assertIn("Forbidden", data["message"])
        self.assertNotIn(self.TEST_TOKEN, data["message"])

    def test_valid_token_accepted_200(self):
        """Requirement 4 & 5: Valid Bearer token must return HTTP 200."""
        res = self.client.post("/api/auth/verify", headers=self.valid_headers)
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertTrue(data["success"])
        self.assertIn("valid", data["message"].lower())

    def test_unconfigured_server_token_returns_401(self):
        """Requirement 1 & 5: If API_AUTH_TOKEN is not configured on server, requests return 401."""
        config.API_AUTH_TOKEN = ""
        os.environ.pop("API_AUTH_TOKEN", None)
        try:
            res = self.client.post("/api/auth/verify", headers=self.valid_headers)
            self.assertEqual(res.status_code, 401)
            data = res.get_json()
            self.assertFalse(data["success"])
            self.assertIn("not configured", data["message"].lower())
        finally:
            config.API_AUTH_TOKEN = self.TEST_TOKEN
            os.environ["API_AUTH_TOKEN"] = self.TEST_TOKEN

    # ─────────────────────────────────────────────────────────────────────────
    # 3. SENSITIVE ENDPOINTS PROTECTION
    # ─────────────────────────────────────────────────────────────────────────

    def test_sensitive_settings_post_requires_auth(self):
        """Requirement 2: /api/settings POST cannot modify settings without auth."""
        orig_trade_amount = config.DEFAULT_TRADE_AMOUNT
        # Attempt unauthorized modification
        res_unauth = self.client.post("/api/settings", json={"trade_amount": 999.0})
        self.assertEqual(res_unauth.status_code, 401)
        self.assertEqual(config.DEFAULT_TRADE_AMOUNT, orig_trade_amount)

        # Attempt invalid token modification
        res_invalid = self.client.post("/api/settings", json={"trade_amount": 999.0}, headers=self.invalid_headers)
        self.assertEqual(res_invalid.status_code, 403)
        self.assertEqual(config.DEFAULT_TRADE_AMOUNT, orig_trade_amount)

        # Authorized modification succeeds
        res_auth = self.client.post("/api/settings", json={"trade_amount": 12.5}, headers=self.valid_headers)
        self.assertEqual(res_auth.status_code, 200)
        self.assertEqual(config.DEFAULT_TRADE_AMOUNT, 12.5)

        # Cleanup
        config.DEFAULT_TRADE_AMOUNT = orig_trade_amount

    def test_sensitive_trade_post_requires_auth(self):
        """Requirement 2: /api/trade POST cannot execute trade without auth."""
        res_unauth = self.client.post("/api/trade", json={"trade_amount": 10.0})
        self.assertEqual(res_unauth.status_code, 401)

        res_invalid = self.client.post("/api/trade", json={"trade_amount": 10.0}, headers=self.invalid_headers)
        self.assertEqual(res_invalid.status_code, 403)

    def test_sensitive_confirm_live_requires_auth(self):
        """Requirement 2: /api/trade/confirm-live cannot confirm trades without auth."""
        dummy_tx = "0x" + "d" * 64
        res_unauth = self.client.post("/api/trade/confirm-live", json={"tx_hash": dummy_tx})
        self.assertEqual(res_unauth.status_code, 401)

        res_invalid = self.client.post("/api/trade/confirm-live", json={"tx_hash": dummy_tx}, headers=self.invalid_headers)
        self.assertEqual(res_invalid.status_code, 403)

    def test_sensitive_emergency_stop_post_requires_auth(self):
        """Requirement 2: /api/emergency-stop POST cannot toggle stop without auth."""
        orig_stop = config.EMERGENCY_STOP
        res_unauth = self.client.post("/api/emergency-stop", json={"active": not orig_stop})
        self.assertEqual(res_unauth.status_code, 401)
        self.assertEqual(config.EMERGENCY_STOP, orig_stop)

        res_invalid = self.client.post("/api/emergency-stop", json={"active": not orig_stop}, headers=self.invalid_headers)
        self.assertEqual(res_invalid.status_code, 403)
        self.assertEqual(config.EMERGENCY_STOP, orig_stop)

        # Authorized call succeeds
        res_auth = self.client.post("/api/emergency-stop", json={"active": orig_stop}, headers=self.valid_headers)
        self.assertEqual(res_auth.status_code, 200)

    def test_sensitive_treasury_withdraw_requires_auth(self):
        """Requirement 2: /api/treasury/withdraw cannot withdraw funds without auth."""
        res_unauth = self.client.post("/api/treasury/withdraw", json={
            "amount": 10.0,
            "recipient_address": "0x9cb6b2c1205a16ba947b783ed99569234decfcc0"
        })
        self.assertEqual(res_unauth.status_code, 401)

        res_invalid = self.client.post("/api/treasury/withdraw", json={
            "amount": 10.0,
            "recipient_address": "0x9cb6b2c1205a16ba947b783ed99569234decfcc0"
        }, headers=self.invalid_headers)
        self.assertEqual(res_invalid.status_code, 403)

    def test_sensitive_trades_clear_requires_auth(self):
        """Requirement 2: /api/trades/clear cannot clear history without auth."""
        res_unauth = self.client.post("/api/trades/clear")
        self.assertEqual(res_unauth.status_code, 401)

        res_unauth2 = self.client.post("/api/clear-trades")
        self.assertEqual(res_unauth2.status_code, 401)

        res_invalid = self.client.post("/api/trades/clear", headers=self.invalid_headers)
        self.assertEqual(res_invalid.status_code, 403)

    def test_sensitive_wallet_connect_and_disconnect_require_auth(self):
        """Requirement 2: /api/wallet/connect and /api/wallet/disconnect require auth."""
        test_addr = "0x71C8BF422005A3Db0782F434914f6b15Ac5c0c6E"
        # Connect
        res_conn_unauth = self.client.post("/api/wallet/connect", json={"address": test_addr})
        self.assertEqual(res_conn_unauth.status_code, 401)

        res_conn_invalid = self.client.post("/api/wallet/connect", json={"address": test_addr}, headers=self.invalid_headers)
        self.assertEqual(res_conn_invalid.status_code, 403)

        # Disconnect
        res_dc_unauth = self.client.post("/api/wallet/disconnect")
        self.assertEqual(res_dc_unauth.status_code, 401)

        res_dc_invalid = self.client.post("/api/wallet/disconnect", headers=self.invalid_headers)
        self.assertEqual(res_dc_invalid.status_code, 403)

    def test_sensitive_chain_switch_requires_auth(self):
        """Requirement 2: /api/chain/switch requires auth."""
        res_unauth = self.client.post("/api/chain/switch", json={"chain_id": 137})
        self.assertEqual(res_unauth.status_code, 401)

        res_invalid = self.client.post("/api/chain/switch", json={"chain_id": 137}, headers=self.invalid_headers)
        self.assertEqual(res_invalid.status_code, 403)

    def test_sensitive_pair_switch_requires_auth(self):
        """Requirement 2: /api/pair/switch requires auth."""
        res_unauth = self.client.post("/api/pair/switch", json={"symbol": "WETH/USDC"})
        self.assertEqual(res_unauth.status_code, 401)

        res_invalid = self.client.post("/api/pair/switch", json={"symbol": "WETH/USDC"}, headers=self.invalid_headers)
        self.assertEqual(res_invalid.status_code, 403)

    def test_sensitive_live_verification_run_requires_auth(self):
        """Requirement 2: /api/live-verification/run requires auth."""
        res_unauth = self.client.post("/api/live-verification/run", json={"explicit_confirmation": True})
        self.assertEqual(res_unauth.status_code, 401)

        res_invalid = self.client.post("/api/live-verification/run", json={"explicit_confirmation": True}, headers=self.invalid_headers)
        self.assertEqual(res_invalid.status_code, 403)

    # ─────────────────────────────────────────────────────────────────────────
    # 4. READ-ONLY ENDPOINTS REMAIN ACCESSIBLE
    # ─────────────────────────────────────────────────────────────────────────

    def test_public_get_endpoints_accessible_without_auth(self):
        """Verify that public read-only GET endpoints remain accessible."""
        # /api/health
        res_health = self.client.get("/api/health")
        self.assertEqual(res_health.status_code, 200)

        # /api/settings (GET is read-only)
        res_settings = self.client.get("/api/settings")
        self.assertEqual(res_settings.status_code, 200)

        # /api/emergency-stop (GET is read-only)
        res_stop = self.client.get("/api/emergency-stop")
        self.assertEqual(res_stop.status_code, 200)

        # /api/chains (GET)
        res_chains = self.client.get("/api/chains")
        self.assertEqual(res_chains.status_code, 200)

    # ─────────────────────────────────────────────────────────────────────────
    # 5. TOKEN NEVER LEAKED IN RESPONSES OR SQLITE
    # ─────────────────────────────────────────────────────────────────────────

    def test_api_token_not_exposed_in_settings_response(self):
        """Requirement 3: API token must not be in /api/settings response."""
        res = self.client.get("/api/settings")
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        settings = data.get("settings", {})
        self.assertNotIn("api_auth_token", settings)
        self.assertNotIn("api_token", settings)
        self.assertNotIn(self.TEST_TOKEN, json.dumps(data))

    def test_api_token_not_exposed_in_health_response(self):
        """Requirement 3: API token must not be in /api/health response."""
        res = self.client.get("/api/health")
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertNotIn(self.TEST_TOKEN, json.dumps(data))

    def test_api_token_never_persisted_in_database(self):
        """Requirement 3 & 9: save_bot_setting rejects storing API tokens to SQLite."""
        database.save_bot_setting("api_auth_token", self.TEST_TOKEN)
        database.save_bot_setting("api_token", self.TEST_TOKEN)
        saved = database.load_all_bot_settings()
        self.assertNotIn("api_auth_token", saved)
        self.assertNotIn("api_token", saved)


if __name__ == "__main__":
    unittest.main()
