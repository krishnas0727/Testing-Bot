"""Unit Tests for Truthful Blockchain Treasury Withdrawal System (Phase 5).

Verifies strict compliance with Phase 5 requirements:
1. Fake transaction hashes (e.g. 0xtreasury_...) are never generated or saved.
2. Withdrawals are NEVER marked CONFIRMED unless an actual blockchain transaction is confirmed.
3. Flow validates token, recipient, amount, and contract token balance.
4. Failed transactions are marked FAILED and never claim success.
5. Missing wallet private key or contract returns 'Real blockchain withdrawal is not configured.'
6. Mock/simulation mode is strictly separated (status = 'SIMULATED', tx_hash = '').
7. Successful withdrawal exclusively uses the verified on-chain receipt hash.
"""

import os
import sys
import unittest
import tempfile
from unittest.mock import patch, MagicMock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import config
import database
from app import app


class TestTruthfulTreasuryWithdrawal(unittest.TestCase):
    SAMPLE_RECIPIENT = "0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1"
    SAMPLE_CONTRACT = "0x000000000000000000000000000000000000dEaD"
    SAMPLE_REAL_HASH = "0x" + "c" * 64

    def setUp(self):
        self.tmp_dir = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self.tmp_dir.name, "test_truthful_treasury.db")
        self.orig_db = config.DATABASE_NAME
        config.DATABASE_NAME = self.db_path
        database.DATABASE_NAME = self.db_path
        database.create_database()

        self.client = app.test_client()
        app.config["TESTING"] = True

        self.test_token = "test-auth-token-treasury-phase5"
        self.orig_token = getattr(config, "API_AUTH_TOKEN", "")
        config.API_AUTH_TOKEN = self.test_token
        self.headers = {"Authorization": f"Bearer {self.test_token}"}

        self.orig_mode = getattr(config, "TRADING_MODE", "MOCK")
        config.TRADING_MODE = "LIVE"
        self.orig_armed = getattr(config, "LIVE_TRADING_ARMED", False)
        config.LIVE_TRADING_ARMED = True
        self.orig_emergency = getattr(config, "EMERGENCY_STOP", False)
        config.EMERGENCY_STOP = False

        self.orig_pk = getattr(config, "PRIVATE_KEY", "")
        config.PRIVATE_KEY = ""
        self.orig_contract = getattr(config, "TREASURY_CONTRACT_ADDRESS", "")
        config.TREASURY_CONTRACT_ADDRESS = ""
        self.orig_arb_contract = getattr(config, "ARBITRAGE_CONTRACT_ADDRESS", "")
        config.ARBITRAGE_CONTRACT_ADDRESS = ""

    def tearDown(self):
        config.API_AUTH_TOKEN = self.orig_token
        config.TRADING_MODE = self.orig_mode
        config.LIVE_TRADING_ARMED = self.orig_armed
        config.EMERGENCY_STOP = self.orig_emergency
        config.PRIVATE_KEY = self.orig_pk
        config.TREASURY_CONTRACT_ADDRESS = self.orig_contract
        config.ARBITRAGE_CONTRACT_ADDRESS = self.orig_arb_contract
        database.DATABASE_NAME = self.orig_db
        config.DATABASE_NAME = self.orig_db
        self.tmp_dir.cleanup()

    def _seed_live_profit(self, profit: float = 100.0):
        """Helper to seed confirmed live profit in the test database."""
        database.save_trade({
            "tx_hash": "0x" + "f" * 64,
            "chain_id": 11155111,
            "buy_dex": "Uniswap_V2",
            "sell_dex": "SushiSwap_V2",
            "token_pair": "WETH/USDC",
            "amount_in": 500.0,
            "amount_out": 500.0 + profit,
            "gross_profit": profit,
            "net_profit": profit,
            "status": "CONFIRMED",
            "mode": "LIVE"
        })

    def test_missing_wallet_or_contract_returns_not_configured_error(self):
        """Requirement 5: If real blockchain withdrawal cannot be performed, return clear error."""
        self._seed_live_profit(50.0)

        # Neither contract nor private key configured
        config.TREASURY_CONTRACT_ADDRESS = ""
        config.ARBITRAGE_CONTRACT_ADDRESS = ""
        config.PRIVATE_KEY = ""

        res = self.client.post(
            "/api/treasury/withdraw",
            headers=self.headers,
            json={
                "amount": 10.0,
                "token": "USDT",
                "recipient_address": self.SAMPLE_RECIPIENT,
                "chain_id": 11155111
            }
        )
        self.assertEqual(res.status_code, 400)
        data = res.get_json()
        self.assertFalse(data["success"])
        self.assertEqual(data["status"], "NOT_CONFIGURED")
        self.assertIn("Real blockchain withdrawal is not configured", data["message"])
        self.assertIn("Smart contract address", data["message"])
        self.assertIn("Wallet signing private key", data["message"])

    def test_invalid_amount_or_recipient_rejected(self):
        """Requirement 3: Validate token, recipient, and amount."""
        self._seed_live_profit(50.0)

        # Negative amount
        res = self.client.post(
            "/api/treasury/withdraw",
            headers=self.headers,
            json={"amount": -5.0, "recipient_address": self.SAMPLE_RECIPIENT}
        )
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.get_json()["status"], "INVALID_AMOUNT")

        # Zero amount
        res = self.client.post(
            "/api/treasury/withdraw",
            headers=self.headers,
            json={"amount": 0.0, "recipient_address": self.SAMPLE_RECIPIENT}
        )
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.get_json()["status"], "INVALID_AMOUNT")

        # Malformed recipient address
        res = self.client.post(
            "/api/treasury/withdraw",
            headers=self.headers,
            json={"amount": 10.0, "recipient_address": "not_an_eth_address"}
        )
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.get_json()["status"], "INVALID_RECIPIENT")

    def test_fake_hash_cannot_be_generated_or_persisted_as_confirmed(self):
        """Requirement 1, 2, & 8: Fake hashes cannot be generated, submitted, or saved as CONFIRMED."""
        # 1. Database level guard: attempting to record CONFIRMED with a fake hash must raise ValueError
        with self.assertRaises(ValueError) as ctx:
            database.record_treasury_withdrawal({
                "tx_hash": "0xtreasury_1690000000_abcd1234",
                "chain_id": 11155111,
                "token": "USDT",
                "amount": 25.0,
                "recipient_address": self.SAMPLE_RECIPIENT,
                "status": "CONFIRMED",
                "mode": "LIVE"
            })
        self.assertIn("Cannot record withdrawal as CONFIRMED without a verified 66-character EVM transaction hash", str(ctx.exception))

        # 2. Database level guard: empty hash cannot be marked CONFIRMED
        with self.assertRaises(ValueError):
            database.record_treasury_withdrawal({
                "tx_hash": "",
                "amount": 10.0,
                "recipient_address": self.SAMPLE_RECIPIENT,
                "status": "CONFIRMED",
                "mode": "LIVE"
            })

        # 3. API level guard: passing a fake hash format is rejected with INVALID_TX_HASH
        res = self.client.post(
            "/api/treasury/withdraw",
            headers=self.headers,
            json={
                "amount": 10.0,
                "token": "USDT",
                "recipient_address": self.SAMPLE_RECIPIENT,
                "tx_hash": "0xtreasury_fake_hash_1234"
            }
        )
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.get_json()["status"], "INVALID_TX_HASH")

        # Verify zero fake hashes exist in the database
        conn = database.get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) FROM treasury_withdrawals WHERE tx_hash LIKE '0xtreasury_%'")
        fake_count = cursor.fetchone()[0]
        conn.close()
        self.assertEqual(fake_count, 0)

    @patch("treasury_execution.submit_blockchain_withdrawal")
    def test_successful_withdrawal_only_uses_actual_receipt_hash(self, mock_submit):
        """Requirement 2, 3, & 8: Successful withdrawal only uses verified actual receipt hash."""
        self._seed_live_profit(100.0)

        config.TREASURY_CONTRACT_ADDRESS = self.SAMPLE_CONTRACT
        config.PRIVATE_KEY = "0x" + "1" * 64

        verified_hash = self.SAMPLE_REAL_HASH
        mock_submit.return_value = {
            "success": True,
            "status": "CONFIRMED",
            "tx_hash": verified_hash,
            "block_number": 5123456,
            "gas_used": 65000
        }

        res = self.client.post(
            "/api/treasury/withdraw",
            headers=self.headers,
            json={
                "amount": 40.0,
                "token": "USDT",
                "recipient_address": self.SAMPLE_RECIPIENT,
                "chain_id": 11155111
            }
        )
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertTrue(data["success"])
        self.assertEqual(data["status"], "CONFIRMED")
        self.assertEqual(data["withdrawal"]["tx_hash"], verified_hash)
        self.assertEqual(data["withdrawal"]["status"], "CONFIRMED")
        self.assertEqual(data["total_withdrawn_usdt"], 40.0)
        self.assertEqual(data["withdrawable_profit_usdt"], 60.0)

        # Verify database record
        withdrawals = database.get_treasury_withdrawals(limit=1, mode="LIVE")
        self.assertEqual(len(withdrawals), 1)
        self.assertEqual(withdrawals[0]["tx_hash"], verified_hash)
        self.assertEqual(withdrawals[0]["status"], "CONFIRMED")
        self.assertEqual(withdrawals[0]["amount"], 40.0)

    @patch("treasury_execution.submit_blockchain_withdrawal")
    def test_failed_withdrawal_marked_failed_and_does_not_claim_success(self, mock_submit):
        """Requirement 4: If transaction fails, mark FAILED, do not claim success, do not invent a hash."""
        self._seed_live_profit(100.0)

        config.TREASURY_CONTRACT_ADDRESS = self.SAMPLE_CONTRACT
        config.PRIVATE_KEY = "0x" + "1" * 64

        failed_tx_hash = "0x" + "e" * 64
        mock_submit.return_value = {
            "success": False,
            "status": "FAILED",
            "tx_hash": failed_tx_hash,
            "message": f"Withdrawal transaction {failed_tx_hash} reverted on-chain (status 0x0)."
        }

        res = self.client.post(
            "/api/treasury/withdraw",
            headers=self.headers,
            json={
                "amount": 20.0,
                "token": "USDT",
                "recipient_address": self.SAMPLE_RECIPIENT,
                "chain_id": 11155111
            }
        )
        self.assertEqual(res.status_code, 400)
        data = res.get_json()
        self.assertFalse(data["success"])
        self.assertEqual(data["status"], "FAILED")
        self.assertEqual(data["tx_hash"], failed_tx_hash)
        self.assertIn("reverted on-chain", data["message"])

        # Check database: status is FAILED and total_withdrawn is NOT deducted
        self.assertEqual(database.get_total_withdrawn(mode="LIVE"), 0.0)
        self.assertEqual(database.get_withdrawable_profit(mode="LIVE"), 100.0)

        withdrawals = database.get_treasury_withdrawals(limit=5, mode="LIVE")
        failed_records = [w for w in withdrawals if w["status"] == "FAILED"]
        self.assertEqual(len(failed_records), 1)
        self.assertEqual(failed_records[0]["tx_hash"], failed_tx_hash)

    def test_simulation_mode_is_clearly_separate_and_truthful(self):
        """Requirement 6 & 7: Keep simulation/paper mode separate, do not claim real execution or invent hash."""
        # Seed mock profit for paper trading withdrawal
        database.save_trade({
            "tx_hash": "0x" + "d" * 64,
            "chain_id": 11155111,
            "buy_dex": "Uniswap_V2",
            "sell_dex": "SushiSwap_V2",
            "token_pair": "WETH/USDC",
            "amount_in": 100.0,
            "amount_out": 150.0,
            "gross_profit": 50.0,
            "net_profit": 50.0,
            "status": "CONFIRMED",
            "mode": "MOCK"
        })

        res = self.client.post(
            "/api/treasury/withdraw",
            headers=self.headers,
            json={
                "amount": 15.0,
                "token": "USDT",
                "recipient_address": self.SAMPLE_RECIPIENT,
                "simulation": True
            }
        )
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertTrue(data["success"])
        self.assertTrue(data.get("simulated", False))
        self.assertEqual(data["status"], "SIMULATED")
        # No fake hash! Empty hash for simulation
        self.assertEqual(data["withdrawal"]["tx_hash"], "")
        self.assertEqual(data["withdrawal"]["status"], "SIMULATED")
        self.assertEqual(data["withdrawal"]["mode"], "MOCK")

        # Verify live withdrawable profit is NOT affected by simulation
        self.assertEqual(database.get_total_withdrawn(mode="LIVE"), 0.0)

    def test_emergency_stop_blocks_live_withdrawal(self):
        """Emergency stop must block treasury withdrawal execution."""
        self._seed_live_profit(50.0)
        config.EMERGENCY_STOP = True

        res = self.client.post(
            "/api/treasury/withdraw",
            headers=self.headers,
            json={
                "amount": 10.0,
                "token": "USDT",
                "recipient_address": self.SAMPLE_RECIPIENT,
                "mode": "LIVE"
            }
        )
        self.assertEqual(res.status_code, 400)
        data = res.get_json()
        self.assertFalse(data["success"])
        self.assertEqual(data["status"], "BLOCKED_EMERGENCY_STOP")
        self.assertIn("Emergency Stop is active", data["message"])

    @patch("treasury_execution.submit_blockchain_withdrawal")
    def test_insufficient_contract_balance_fails_before_broadcast(self, mock_submit):
        """Requirement 3: Check contract balance before broadcast, fail if insufficient."""
        self._seed_live_profit(100.0)
        config.TREASURY_CONTRACT_ADDRESS = self.SAMPLE_CONTRACT
        config.PRIVATE_KEY = "0x" + "1" * 64

        mock_submit.return_value = {
            "success": False,
            "status": "INSUFFICIENT_CONTRACT_BALANCE",
            "message": "Contract token balance (5.0000 USDT) is less than requested withdrawal amount (40.0000 USDT)."
        }

        res = self.client.post(
            "/api/treasury/withdraw",
            headers=self.headers,
            json={
                "amount": 40.0,
                "token": "USDT",
                "recipient_address": self.SAMPLE_RECIPIENT,
                "chain_id": 11155111
            }
        )
        self.assertEqual(res.status_code, 400)
        data = res.get_json()
        self.assertFalse(data["success"])
        self.assertEqual(data["status"], "INSUFFICIENT_CONTRACT_BALANCE")
        self.assertIn("Contract token balance", data["message"])
        # No withdrawal recorded, total withdrawn remains 0
        self.assertEqual(database.get_total_withdrawn(mode="LIVE"), 0.0)


if __name__ == "__main__":
    unittest.main()
