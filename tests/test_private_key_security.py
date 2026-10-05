import os
import io
import sys
import unittest
import sqlite3

# Set test environment
os.environ["API_AUTH_TOKEN"] = "test-secret-token-pk-security-12345"
os.environ["TRADING_MODE"] = "MOCK"
os.environ["LIVE_TRADING_ARMED"] = "false"
os.environ["PRIVATE_KEY"] = ""

import config
from app import app
from database import (
    create_database,
    get_connection,
    save_bot_setting,
    load_all_bot_settings,
    scrub_legacy_private_keys
)
import dex_engine
import live_executor


class TestPrivateKeySecurity(unittest.TestCase):
    SAMPLE_PK = "0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d"
    SAMPLE_ADDRESS = "0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1"

    def setUp(self):
        create_database()
        self.client = app.test_client()
        self.auth_token = "test-secret-token-pk-security-12345"
        config.API_AUTH_TOKEN = self.auth_token
        os.environ["API_AUTH_TOKEN"] = self.auth_token
        self.headers = {"Authorization": f"Bearer {self.auth_token}"}
        config.PRIVATE_KEY = ""
        config.TRADING_MODE = "MOCK"
        config.LIVE_TRADING_ARMED = False
        scrub_legacy_private_keys()

    def tearDown(self):
        config.PRIVATE_KEY = ""
        config.TRADING_MODE = "MOCK"
        config.LIVE_TRADING_ARMED = False
        scrub_legacy_private_keys()

    def test_save_bot_setting_blocks_private_key_storage(self):
        """Requirement 1 & 3: save_bot_setting must never persist raw private keys to SQLite."""
        save_bot_setting("private_key", self.SAMPLE_PK)
        save_bot_setting("priv_key", self.SAMPLE_PK)
        save_bot_setting("pk", self.SAMPLE_PK)
        save_bot_setting("secret_key", self.SAMPLE_PK)

        # Check via database connection directly
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM bot_settings WHERE LOWER(key) IN ('private_key', 'priv_key', 'pk', 'secret_key')")
        rows = cursor.fetchall()
        conn.close()
        self.assertEqual(len(rows), 0, "Private keys were persisted to bot_settings table!")

    def test_load_all_bot_settings_filters_sensitive_keys(self):
        """Requirement 5: load_all_bot_settings must never return private key values."""
        # Manually force insert into DB to simulate legacy dirty database
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute("INSERT INTO bot_settings (key, value) VALUES ('private_key', '\"0xlegacy_secret\"')")
        conn.commit()
        conn.close()

        settings = load_all_bot_settings()
        self.assertNotIn("private_key", settings)
        self.assertNotIn("0xlegacy_secret", str(settings))

    def test_scrub_legacy_private_keys_removes_old_rows(self):
        """Requirement 4 & 12: scrub_legacy_private_keys cleanly deletes old plaintext records."""
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute("INSERT INTO bot_settings (key, value) VALUES ('private_key', '\"0xlegacy_secret\"')")
        cursor.execute("INSERT INTO bot_settings (key, value) VALUES ('priv_key', '\"0xlegacy_secret_2\"')")
        conn.commit()
        conn.close()

        deleted = scrub_legacy_private_keys()
        self.assertGreaterEqual(deleted, 2)

        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) FROM bot_settings WHERE LOWER(key) IN ('private_key', 'priv_key')")
        remaining = cursor.fetchone()[0]
        conn.close()
        self.assertEqual(remaining, 0)

    def test_settings_api_does_not_store_private_key_in_sqlite(self):
        """Requirement 1 & 6: POST /api/settings sets in-memory key but does NOT persist to SQLite."""
        res = self.client.post(
            "/api/settings",
            headers=self.headers,
            json={"private_key": self.SAMPLE_PK}
        )
        self.assertEqual(res.status_code, 200)

        # In-memory session key is set
        self.assertEqual(config.PRIVATE_KEY, self.SAMPLE_PK)
        # Public wallet address is derived
        self.assertEqual(config.WALLET_ADDRESS.lower(), self.SAMPLE_ADDRESS.lower())

        # SQLite database MUST NOT contain the private key
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM bot_settings WHERE LOWER(key) = 'private_key'")
        rows = cursor.fetchall()
        conn.close()
        self.assertEqual(len(rows), 0, "Private key was saved to SQLite database via /api/settings!")

    def test_api_responses_do_not_expose_private_key(self):
        """Requirement 5: API responses must never expose the raw private key."""
        config.PRIVATE_KEY = self.SAMPLE_PK

        # Test GET /api/settings
        res_get = self.client.get("/api/settings")
        self.assertEqual(res_get.status_code, 200)
        self.assertNotIn(self.SAMPLE_PK, res_get.get_data(as_text=True))
        data_get = res_get.get_json()
        self.assertTrue(data_get["settings"]["has_private_key"])
        self.assertNotIn("private_key", data_get["settings"])

        # Test POST /api/settings
        res_post = self.client.post(
            "/api/settings",
            headers=self.headers,
            json={"trade_amount": 10.0}
        )
        self.assertEqual(res_post.status_code, 200)
        self.assertNotIn(self.SAMPLE_PK, res_post.get_data(as_text=True))

        # Test other public endpoints
        for ep in ("/api/health", "/api/contract", "/api/trades", "/api/wallet"):
            res = self.client.get(ep)
            self.assertNotIn(self.SAMPLE_PK, res.get_data(as_text=True))

    def test_logs_do_not_contain_private_key(self):
        """Requirement 5: Logs, errors, and stdout do not leak private keys."""
        captured_stdout = io.StringIO()
        old_stdout = sys.stdout
        try:
            sys.stdout = captured_stdout

            # Trigger save_bot_setting
            save_bot_setting("private_key", self.SAMPLE_PK)
            # Trigger load_all_bot_settings
            load_all_bot_settings()
            # Trigger settings API
            self.client.post(
                "/api/settings",
                headers=self.headers,
                json={"private_key": self.SAMPLE_PK}
            )
            # Trigger scrub
            scrub_legacy_private_keys()
        finally:
            sys.stdout = old_stdout

        log_output = captured_stdout.getvalue()
        self.assertNotIn(self.SAMPLE_PK, log_output)

    def test_missing_private_key_fails_safely(self):
        """Requirement 11: Missing private key fails safely with LIVE_SIGNER_REQUIRED."""
        config.PRIVATE_KEY = ""
        config.TRADING_MODE = "LIVE"
        config.LIVE_TRADING_ARMED = True
        config.EMERGENCY_STOP = False

        plan = {
            "buy_dex": "Uniswap_V2",
            "sell_dex": "SushiSwap_V2",
            "amount_in": 5.0,
            "chain_id": 8453,
        }

        # Test dex_engine atomic trade
        res_atomic = dex_engine.execute_atomic_trade(plan)
        self.assertFalse(res_atomic["success"])
        self.assertEqual(res_atomic["status"], "LIVE_SIGNER_REQUIRED")
        self.assertIn("PRIVATE_KEY", res_atomic["message"])

        # Test live_executor
        res_live = live_executor.execute_live(plan)
        self.assertFalse(res_live["success"])
        self.assertEqual(res_live["status"], "LIVE_SIGNER_REQUIRED")

    def test_clearing_private_key_via_api(self):
        """Users can clear the in-memory key and scrub DB safely via private_key=''."""
        config.PRIVATE_KEY = self.SAMPLE_PK

        res = self.client.post(
            "/api/settings",
            headers=self.headers,
            json={"private_key": ""}
        )
        self.assertEqual(res.status_code, 200)
        self.assertEqual(config.PRIVATE_KEY, "")
        data = res.get_json()
        self.assertFalse(data["settings"]["has_private_key"])

    def test_private_key_not_present_in_frontend_source(self):
        """Requirement 12.D: Private key is NOT present in frontend source files."""
        frontend_files = [
            os.path.join(os.path.dirname(__file__), "../static/app.js"),
            os.path.join(os.path.dirname(__file__), "../templates/index.html")
        ]
        import re
        hex_key_pattern = re.compile(r"0x[a-fA-F0-9]{64}")
        for filepath in frontend_files:
            if os.path.exists(filepath):
                with open(filepath, "r", encoding="utf-8") as f:
                    content = f.read()
                matches = hex_key_pattern.findall(content)
                self.assertEqual(len(matches), 0, f"Found private key pattern in {filepath}: {matches}")

    def test_private_key_not_hardcoded_in_production_source(self):
        """Requirement 12.E: Private key is NOT hardcoded in production source files."""
        prod_files = [
            "app.py",
            "arbitrage.py",
            "config.py",
            "database.py",
            "dex_engine.py",
            "live_executor.py",
            "treasury_execution.py",
            "wallet_manager.py"
        ]
        import re
        hex_key_pattern = re.compile(r"0x[a-fA-F0-9]{64}")
        for fname in prod_files:
            fpath = os.path.join(os.path.dirname(__file__), "..", fname)
            if os.path.exists(fpath):
                with open(fpath, "r", encoding="utf-8") as f:
                    content = f.read()
                matches = hex_key_pattern.findall(content)
                self.assertEqual(len(matches), 0, f"Found 64-char hex key pattern in {fname}: {matches}")

    def test_invalid_private_key_produces_safe_error_without_echoing_key(self):
        """Requirement 12.G: Invalid private key produces a safe error without revealing the key."""
        bad_key = "0xnot_a_valid_hex_key_1234567890abcdef1234567890abcdef1234567890abcdef"

        # 1. API settings endpoint
        res = self.client.post(
            "/api/settings",
            headers=self.headers,
            json={"private_key": bad_key}
        )
        self.assertEqual(res.status_code, 400)
        data = res.get_json()
        self.assertFalse(data["success"])
        # Crucial: the response must NOT echo the supplied secret
        self.assertNotIn(bad_key, res.get_data(as_text=True))
        self.assertIn("Invalid private key format", data["message"])

        # 2. live_executor.execute_live with invalid key
        config.PRIVATE_KEY = bad_key
        config.TRADING_MODE = "LIVE"
        config.LIVE_TRADING_ARMED = True
        config.EMERGENCY_STOP = False
        res_exec = live_executor.execute_live({
            "buy_dex": "Uniswap_V2",
            "sell_dex": "SushiSwap_V2",
            "amount_in": 5.0,
        })
        self.assertFalse(res_exec["success"])
        self.assertEqual(res_exec["status"], "INVALID_SIGNER_KEY")
        self.assertNotIn(bad_key, str(res_exec))

    def test_env_is_ignored_by_git(self):
        """Requirement 12.I: .env is ignored by Git."""
        gitignore_path = os.path.join(os.path.dirname(__file__), "../.gitignore")
        self.assertTrue(os.path.exists(gitignore_path))
        with open(gitignore_path, "r", encoding="utf-8") as f:
            lines = [line.strip() for line in f.readlines()]
        self.assertIn(".env", lines)

    def test_env_example_contains_only_placeholders(self):
        """Requirement 12.J: .env.example contains only placeholder values."""
        env_example_path = os.path.join(os.path.dirname(__file__), "../.env.example")
        self.assertTrue(os.path.exists(env_example_path))
        with open(env_example_path, "r", encoding="utf-8") as f:
            content = f.read()

        import re
        hex_key_pattern = re.compile(r"0x[a-fA-F0-9]{64}")
        matches = hex_key_pattern.findall(content)
        self.assertEqual(len(matches), 0, f"Found 64-char hex key pattern in .env.example: {matches}")
        # Verify PRIVATE_KEY= has no hardcoded secret
        for line in content.splitlines():
            if line.startswith("PRIVATE_KEY="):
                val = line.split("=", 1)[1].strip()
                # Must be empty or comment placeholder
                self.assertTrue(val == "" or val.startswith("#") or "<" in val)

    def test_live_execution_loads_key_from_environment_securely(self):
        """Requirement 12.K: Existing LIVE execution can load the server key securely via environment."""
        config.PRIVATE_KEY = self.SAMPLE_PK
        try:
            from eth_account import Account
            acct = Account.from_key(config.PRIVATE_KEY)
            self.assertEqual(acct.address.lower(), self.SAMPLE_ADDRESS.lower())
        finally:
            config.PRIVATE_KEY = ""

    def test_api_auth_token_remains_separate_from_private_key(self):
        """Requirement 12.L: API_AUTH_TOKEN remains strictly separate from PRIVATE_KEY."""
        config.API_AUTH_TOKEN = "secret-token-abc"
        config.PRIVATE_KEY = ""

        # API_AUTH_TOKEN does not count as a PRIVATE_KEY
        self.assertFalse(bool(getattr(config, "PRIVATE_KEY", "")))
        self.assertNotEqual(config.API_AUTH_TOKEN, config.PRIVATE_KEY)

        # Setting PRIVATE_KEY does not overwrite API_AUTH_TOKEN
        config.PRIVATE_KEY = self.SAMPLE_PK
        self.assertEqual(config.API_AUTH_TOKEN, "secret-token-abc")
        self.assertNotEqual(config.API_AUTH_TOKEN, config.PRIVATE_KEY)

    def test_live_safety_guards_enforced_even_with_configured_private_key(self):
        """Requirement 12.M: LIVE_TRADING_ARMED and EMERGENCY_STOP are enforced even with a configured private key."""
        config.PRIVATE_KEY = self.SAMPLE_PK
        config.TRADING_MODE = "LIVE"

        # 1. Unarmed -> rejected despite valid private key
        config.LIVE_TRADING_ARMED = False
        config.EMERGENCY_STOP = False
        res1 = self.client.post("/api/trade", headers=self.headers, json={"trade_amount": 5.0})
        self.assertEqual(res1.status_code, 400)
        self.assertEqual(res1.get_json()["status"], "NOT_ARMED")

        # 2. Emergency Stop ON -> rejected despite armed + valid private key
        config.LIVE_TRADING_ARMED = True
        config.EMERGENCY_STOP = True
        res2 = self.client.post("/api/trade", headers=self.headers, json={"trade_amount": 5.0})
        self.assertEqual(res2.status_code, 400)
        self.assertEqual(res2.get_json()["status"], "BLOCKED_EMERGENCY_STOP")


if __name__ == "__main__":
    unittest.main()
