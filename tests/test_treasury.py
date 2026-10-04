"""Unit Tests for Treasury Vault and Profit Withdrawal System.

Tests profit accumulation, withdrawable calculations, ledger recording,
and the /api/treasury/status & /api/treasury/withdraw endpoints.
"""
import os
import sys
import unittest
import tempfile
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import config
import database
from app import app


class TreasurySystemTests(unittest.TestCase):
    def setUp(self):
        self.tmp_dir = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self.tmp_dir.name, "test_trades.db")
        self.orig_db = config.DATABASE_NAME
        database.DATABASE_NAME = self.db_path
        config.DATABASE_NAME = self.db_path
        database.create_database()

        self.client = app.test_client()
        app.config["TESTING"] = True
        self.test_token = "treasury-test-token"
        self.orig_token = getattr(config, "API_AUTH_TOKEN", "")
        config.API_AUTH_TOKEN = self.test_token
        self.client.environ_base["HTTP_AUTHORIZATION"] = f"Bearer {self.test_token}"

        self.orig_mode = getattr(config, "TRADING_MODE", "MOCK")
        config.TRADING_MODE = "LIVE"
        self.orig_armed = getattr(config, "LIVE_TRADING_ARMED", False)
        config.LIVE_TRADING_ARMED = True
        self.orig_emergency = getattr(config, "EMERGENCY_STOP", False)
        config.EMERGENCY_STOP = False

    def tearDown(self):
        config.API_AUTH_TOKEN = self.orig_token
        config.TRADING_MODE = self.orig_mode
        config.LIVE_TRADING_ARMED = self.orig_armed
        config.EMERGENCY_STOP = self.orig_emergency
        database.DATABASE_NAME = self.orig_db
        config.DATABASE_NAME = self.orig_db
        self.tmp_dir.cleanup()

    def test_withdrawable_profit_calculation(self):
        # 0 profit initially
        self.assertEqual(database.get_total_profit(mode="LIVE"), 0.0)
        self.assertEqual(database.get_withdrawable_profit(mode="LIVE"), 0.0)

        # Save a confirmed live trade with 10.50 profit
        database.save_trade({
            "tx_hash": "0x111",
            "chain_id": 11155111,
            "buy_dex": "Uniswap_V2",
            "sell_dex": "SushiSwap_V2",
            "token_pair": "WETH/USDC",
            "amount_in": 100.0,
            "amount_out": 110.50,
            "gross_profit": 10.50,
            "net_profit": 10.50,
            "status": "CONFIRMED",
            "mode": "LIVE"
        })

        self.assertEqual(database.get_total_profit(mode="LIVE"), 10.50)
        self.assertEqual(database.get_withdrawable_profit(mode="LIVE"), 10.50)

        # Withdraw 4.00
        database.record_treasury_withdrawal({
            "tx_hash": "0x" + "a" * 64,
            "chain_id": 11155111,
            "token": "USDC",
            "amount": 4.0,
            "recipient_address": "0x9cb6b2c1205a16ba947b783ed99569234decfcc0",
            "status": "CONFIRMED",
            "mode": "LIVE"
        })

        self.assertEqual(database.get_total_withdrawn(mode="LIVE"), 4.0)
        self.assertEqual(database.get_withdrawable_profit(mode="LIVE"), 6.50)

    def test_treasury_status_api(self):
        # Add trade profit
        database.save_trade({
            "tx_hash": "0x222",
            "chain_id": 11155111,
            "buy_dex": "Uniswap_V2",
            "sell_dex": "SushiSwap_V2",
            "token_pair": "WETH/USDT",
            "amount_in": 50.0,
            "amount_out": 55.0,
            "gross_profit": 5.0,
            "net_profit": 5.0,
            "status": "CONFIRMED",
            "mode": "LIVE"
        })

        res = self.client.get("/api/treasury/status")
        self.assertEqual(res.status_code, 200)
        json_data = res.get_json()
        self.assertTrue(json_data["success"])
        self.assertEqual(json_data["total_profit_usdt"], 5.0)
        self.assertEqual(json_data["total_withdrawn_usdt"], 0.0)
        self.assertEqual(json_data["withdrawable_profit_usdt"], 5.0)

    def test_treasury_withdraw_api_validation(self):
        # Invalid amount
        res = self.client.post("/api/treasury/withdraw", json={
            "amount": -5.0,
            "recipient_address": "0x9cb6b2c1205a16ba947b783ed99569234decfcc0"
        })
        self.assertEqual(res.status_code, 400)
        self.assertIn("greater than 0", res.get_json()["message"])

        # Invalid recipient address
        res = self.client.post("/api/treasury/withdraw", json={
            "amount": 1.0,
            "recipient_address": "invalid_address"
        })
        self.assertEqual(res.status_code, 400)
        self.assertIn("0x address is required", res.get_json()["message"])

        # Exceeds withdrawable profit
        res = self.client.post("/api/treasury/withdraw", json={
            "amount": 100.0,
            "recipient_address": "0x9cb6b2c1205a16ba947b783ed99569234decfcc0"
        })
        self.assertEqual(res.status_code, 400)
        self.assertIn("exceeds available withdrawable profit", res.get_json()["message"])

    @patch("dex_engine.rpc_call")
    def test_treasury_withdraw_api_success(self, mock_rpc):
        mock_rpc.return_value = {"status": "0x1"}
        # Add 25.0 profit
        database.save_trade({
            "tx_hash": "0x333",
            "chain_id": 11155111,
            "buy_dex": "Uniswap_V2",
            "sell_dex": "SushiSwap_V2",
            "token_pair": "WETH/USDC",
            "amount_in": 100.0,
            "amount_out": 125.0,
            "gross_profit": 25.0,
            "net_profit": 25.0,
            "status": "CONFIRMED",
            "mode": "LIVE"
        })

        recipient = "0x9cb6b2c1205a16ba947b783ed99569234decfcc0"
        tx_hash = "0x" + "b" * 64
        res = self.client.post("/api/treasury/withdraw", json={
            "amount": 15.0,
            "token": "USDC",
            "recipient_address": recipient,
            "chain_id": 11155111,
            "tx_hash": tx_hash
        })
        self.assertEqual(res.status_code, 200)
        json_data = res.get_json()
        self.assertTrue(json_data["success"])
        self.assertEqual(json_data["withdrawal"]["status"], "CONFIRMED")
        self.assertEqual(json_data["withdrawal"]["tx_hash"], tx_hash)
        self.assertEqual(json_data["total_withdrawn_usdt"], 15.0)
        self.assertEqual(json_data["withdrawable_profit_usdt"], 10.0)

        # Check status endpoint reflects updated state
        status_res = self.client.get("/api/treasury/status")
        status_json = status_res.get_json()
        self.assertEqual(status_json["total_withdrawn_usdt"], 15.0)
        self.assertEqual(status_json["withdrawable_profit_usdt"], 10.0)
        self.assertEqual(len(status_json["recent_withdrawals"]), 1)
        self.assertEqual(status_json["recent_withdrawals"][0]["amount"], 15.0)


if __name__ == "__main__":
    unittest.main()
