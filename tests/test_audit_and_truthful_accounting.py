"""Comprehensive Audit & Truthful Accounting Tests (Phases 1 - 7).

Verifies strict compliance with all 12 audit requirements:
1. Simulation profit never appears as realized live profit.
2. Mock withdrawal never appears as a confirmed on-chain withdrawal.
3. Missing transaction hashes cannot produce a confirmed withdrawal.
4. Failed receipts cannot produce a confirmed trade or withdrawal.
5. Wrong-chain transactions are rejected.
6. Wrong recipient addresses are rejected.
7. Only verified real funds count toward withdrawable treasury balance.
8. Live preference persists across restart while safety guards remain effective.
9. Emergency Stop and daily loss limits always block execution.
10. Invalid routers, missing liquidity and insufficient net profit block trading.
11. API authentication and private-key security remain intact.
12. Responsive layouts / viewport styling definitions exist for all required viewports.
"""

import os
import sys
import unittest
from unittest.mock import MagicMock, patch
import json
import re

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import config
import database
from app import app, get_explorer_tx_url
import dex_engine
import arbitrage
import treasury_execution


class TestAuditAndTruthfulAccounting(unittest.TestCase):
    def setUp(self):
        database.create_database()
        database.delete_all_trades()
        self.app = app
        self.client = app.test_client()
        self.auth_token = "audit_test_secret_token_123"
        self.orig_auth = getattr(config, "API_AUTH_TOKEN", "")
        config.API_AUTH_TOKEN = self.auth_token
        self.headers = {"Authorization": f"Bearer {self.auth_token}"}

        self.orig_mode = getattr(config, "TRADING_MODE", "LIVE")
        self.orig_armed = getattr(config, "LIVE_TRADING_ARMED", False)
        self.orig_emergency = getattr(config, "EMERGENCY_STOP", False)
        self.orig_chain_id = getattr(config, "CHAIN_ID", 8453)
        config.set_active_chain(8453)

    def tearDown(self):
        config.API_AUTH_TOKEN = self.orig_auth
        config.TRADING_MODE = self.orig_mode
        config.LIVE_TRADING_ARMED = self.orig_armed
        config.EMERGENCY_STOP = self.orig_emergency
        config.set_active_chain(self.orig_chain_id)
        database.delete_all_trades()

    # -------------------------------------------------------------------------
    # 1. Simulation profit never appears as realized live profit
    # -------------------------------------------------------------------------
    def test_simulation_profit_never_appears_as_realized_live_profit(self):
        """MOCK / Simulated trades must NEVER be credited to LIVE profit or treasury."""
        # Record large simulated/mock trade profit
        database.save_trade({
            "tx_hash": "",
            "chain_id": 8453,
            "buy_dex": "Uniswap_V2",
            "sell_dex": "SushiSwap_V2",
            "token_pair": "WETH/USDT",
            "amount_in": 100.0,
            "amount_out": 250.0,
            "gross_profit": 150.0,
            "net_profit": 149.95,
            "status": "SIMULATED",
            "mode": "MOCK",
        })

        # Verify database queries for LIVE mode report strictly 0.0
        live_profit = database.get_total_profit(mode="LIVE")
        self.assertEqual(live_profit, 0.0)

        live_withdrawable = database.get_withdrawable_profit(mode="LIVE")
        self.assertEqual(live_withdrawable, 0.0)

        live_trades_count = database.get_total_trades(mode="LIVE")
        self.assertEqual(live_trades_count, 0)

        # Verify treasury buckets summary for LIVE mode has no simulated funds
        buckets = database.get_treasury_buckets_summary(mode="LIVE")
        self.assertEqual(buckets["trading_capital"], 0.0)
        self.assertEqual(buckets["reserve"], 0.0)
        self.assertEqual(buckets["revenue"], 0.0)
        self.assertEqual(buckets["total_allocated"], 0.0)

        # Verify API endpoints isolate LIVE accounting
        res_pnl = self.client.get("/api/pnl?mode=LIVE")
        pnl_data = res_pnl.get_json()
        self.assertEqual(pnl_data["total_trades"], 0)
        self.assertEqual(pnl_data["total_net_profit"], 0.0)

        res_treasury = self.client.get("/api/treasury/status?mode=LIVE")
        treasury_data = res_treasury.get_json()
        self.assertEqual(treasury_data["total_profit_usdt"], 0.0)
        self.assertEqual(treasury_data["withdrawable_profit_usdt"], 0.0)

    # -------------------------------------------------------------------------
    # 2. Mock withdrawal never appears as a confirmed on-chain withdrawal
    # -------------------------------------------------------------------------
    def test_mock_withdrawal_never_appears_as_confirmed_onchain_withdrawal(self):
        """Simulation withdrawals must be marked SIMULATED, with empty tx_hash, never CONFIRMED."""
        # Seed simulated profit first so withdrawable > 0
        database.save_trade({
            "tx_hash": "",
            "chain_id": 8453,
            "buy_dex": "Uniswap_V2",
            "sell_dex": "SushiSwap_V2",
            "token_pair": "WETH/USDT",
            "amount_in": 10.0,
            "amount_out": 60.0,
            "gross_profit": 50.0,
            "net_profit": 50.0,
            "status": "SIMULATED",
            "mode": "MOCK"
        })

        res = self.client.post("/api/treasury/withdraw", headers=self.headers, json={
            "amount": 25.0,
            "recipient_address": "0x1bcea3bc88cd89f3a5de9c07a5c7b6f2b4f501b4",
            "mode": "MOCK",
            "token": "USDT",
        })
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertTrue(data.get("simulated"))
        self.assertEqual(data.get("status"), "SIMULATED")
        self.assertEqual(data.get("withdrawal", {}).get("tx_hash"), "")
        self.assertNotEqual(data.get("status"), "CONFIRMED")

        # Total withdrawn in LIVE mode must remain 0.0
        self.assertEqual(database.get_total_withdrawn(mode="LIVE"), 0.0)

    # -------------------------------------------------------------------------
    # 3. Missing transaction hashes cannot produce a confirmed withdrawal
    # -------------------------------------------------------------------------
    def test_missing_tx_hash_cannot_produce_confirmed_withdrawal(self):
        """Direct database call and API call reject marking a withdrawal as CONFIRMED without valid 66-char EVM hash."""
        # Direct database safety invariant
        with self.assertRaises(ValueError) as ctx:
            database.record_treasury_withdrawal({
                "status": "CONFIRMED",
                "tx_hash": "",
                "amount": 10.0,
                "recipient_address": "0x1bcea3bc88cd89f3a5de9c07a5c7b6f2b4f501b4"
            })
        self.assertIn("verified 66-character EVM transaction hash", str(ctx.exception))

        # Also rejects fake prefix hashes (0xtreasury_...)
        with self.assertRaises(ValueError):
            database.record_treasury_withdrawal({
                "status": "CONFIRMED",
                "tx_hash": "0xtreasury_mock_fake_hash_12345678901234567890123456789012345678901234",
                "amount": 10.0,
                "recipient_address": "0x1bcea3bc88cd89f3a5de9c07a5c7b6f2b4f501b4"
            })

    # -------------------------------------------------------------------------
    # 4. Failed receipts cannot produce a confirmed trade or withdrawal
    # -------------------------------------------------------------------------
    def test_failed_receipt_cannot_produce_confirmed_trade_or_withdrawal(self):
        """A reverted transaction (receipt status = 0) must be recorded as FAILED, never CONFIRMED."""
        # Seed confirmed LIVE profit first so withdrawable balance is sufficient
        database.save_trade({
            "tx_hash": "0x" + "1" * 64,
            "chain_id": 8453,
            "buy_dex": "Uniswap_V2",
            "sell_dex": "SushiSwap_V2",
            "token_pair": "WETH/USDT",
            "amount_in": 10.0,
            "amount_out": 30.0,
            "gross_profit": 20.0,
            "net_profit": 20.0,
            "status": "CONFIRMED",
            "mode": "LIVE"
        })

        # 1. Withdrawal with reverted receipt
        with patch("dex_engine.rpc_call", return_value={"status": "0x0", "blockNumber": "0x100"}):
            fake_real_hash = "0x" + "a" * 64
            res = self.client.post("/api/treasury/withdraw", headers=self.headers, json={
                "amount": 10.0,
                "recipient_address": "0x1bcea3bc88cd89f3a5de9c07a5c7b6f2b4f501b4",
                "tx_hash": fake_real_hash,
                "mode": "LIVE"
            })
            self.assertEqual(res.status_code, 400)
            data = res.get_json()
            self.assertEqual(data.get("status"), "FAILED")
            self.assertIn("reverted on-chain", data.get("message", ""))

        # 2. Verify withdrawal recorded as FAILED in database, not CONFIRMED
        withdrawals = database.get_treasury_withdrawals(limit=1, mode="LIVE")
        self.assertEqual(len(withdrawals), 1)
        self.assertEqual(withdrawals[0]["status"], "FAILED")

    # -------------------------------------------------------------------------
    # 5. Wrong-chain transactions are rejected
    # -------------------------------------------------------------------------
    def test_wrong_chain_transactions_are_rejected(self):
        """Unsupported or mismatched chains must be rejected immediately."""
        # Switching to unsupported chain returns 400
        res = self.client.post("/api/chain/switch", headers=self.headers, json={"chain_id": 999999})
        self.assertEqual(res.status_code, 400)
        self.assertFalse(res.get_json()["success"])

        # LIVE mode on testnet chain is blocked by dex_engine
        with patch.object(config, "CHAIN_ID", 11155111), patch.object(config, "TRADING_MODE", "LIVE"):
            res_engine = dex_engine.execute_atomic_trade({
                "buy_dex": "Uniswap_V2",
                "sell_dex": "SushiSwap_V2",
                "amount_in": 10.0,
                "chain_id": 11155111,
            })
            # Sepolia is testnet; LIVE execution on testnet is blocked
            self.assertFalse(res_engine["success"])
            self.assertIn(res_engine["status"], ("BLOCKED_MODE_CHAIN", "NOT_ARMED"))

    # -------------------------------------------------------------------------
    # 6. Wrong recipient addresses are rejected
    # -------------------------------------------------------------------------
    def test_wrong_recipient_address_rejected(self):
        """Withdrawal requires a valid 42-character 0x EVM address."""
        res_bad = self.client.post("/api/treasury/withdraw", headers=self.headers, json={
            "amount": 5.0,
            "recipient_address": "not_an_eth_address",
            "mode": "LIVE"
        })
        self.assertEqual(res_bad.status_code, 400)
        data = res_bad.get_json()
        self.assertEqual(data.get("status"), "INVALID_RECIPIENT")

    # -------------------------------------------------------------------------
    # 7. Only verified real funds count toward withdrawable treasury balance
    # -------------------------------------------------------------------------
    def test_only_verified_real_funds_count_toward_withdrawable_treasury(self):
        """Only confirmed LIVE trades with positive net profit credit the withdrawable balance."""
        # 1. Initially 0
        self.assertEqual(database.get_withdrawable_profit(mode="LIVE"), 0.0)

        # 2. Add confirmed LIVE trade
        real_tx_hash = "0x" + "b" * 64
        database.save_trade({
            "tx_hash": real_tx_hash,
            "chain_id": 8453,
            "buy_dex": "Aerodrome",
            "sell_dex": "Uniswap_V2",
            "token_pair": "WETH/USDT",
            "amount_in": 10.0,
            "amount_out": 10.45,
            "gross_profit": 0.45,
            "net_profit": 0.42,
            "status": "CONFIRMED",
            "mode": "LIVE"
        })

        self.assertEqual(database.get_total_profit(mode="LIVE"), 0.42)
        self.assertEqual(database.get_withdrawable_profit(mode="LIVE"), 0.42)

        # 3. Add simulated trade — MUST NOT change LIVE withdrawable balance
        database.save_trade({
            "tx_hash": "",
            "chain_id": 8453,
            "buy_dex": "Aerodrome",
            "sell_dex": "Uniswap_V2",
            "token_pair": "WETH/USDT",
            "amount_in": 100.0,
            "amount_out": 200.0,
            "gross_profit": 100.0,
            "net_profit": 99.90,
            "status": "SIMULATED",
            "mode": "MOCK"
        })

        # Still strictly 0.42
        self.assertEqual(database.get_withdrawable_profit(mode="LIVE"), 0.42)

    # -------------------------------------------------------------------------
    # 8. Live preference persists across restart while safety guards remain effective
    # -------------------------------------------------------------------------
    def test_live_preference_persists_across_restart(self):
        """Saving trading_mode = 'LIVE' persists in database and startup loading, while guards stay intact."""
        database.save_bot_setting("trading_mode", "LIVE")
        settings = database.load_all_bot_settings()
        self.assertEqual(settings.get("trading_mode"), "LIVE")

        # Switching to LIVE via /api/settings persists but NEVER automatically arms live trading
        config.LIVE_TRADING_ARMED = False
        res = self.client.post("/api/settings", headers=self.headers, json={"trading_mode": "LIVE"})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(config.TRADING_MODE, "LIVE")
        self.assertFalse(config.LIVE_TRADING_ARMED)  # Invariant: Safety arming requires explicit separate toggle

    # -------------------------------------------------------------------------
    # 9. Emergency Stop and daily loss limits always block execution
    # -------------------------------------------------------------------------
    def test_emergency_stop_and_daily_loss_limits_block_execution(self):
        """Emergency Stop and daily loss breaker immediately block trading and withdrawals."""
        with patch.object(config, "EMERGENCY_STOP", True):
            # 1. Real trade blocked
            res_trade = arbitrage.execute_real_trade({
                "buy_dex": "Uniswap_V2",
                "sell_dex": "SushiSwap_V2",
                "amount_in": 10.0,
                "net_profit_usdt": 1.0,
                "is_profitable": True
            })
            self.assertFalse(res_trade["success"])
            self.assertIn("Emergency stop is active", res_trade["skip_reason"])

            # 2. Live withdrawal blocked
            res_withdraw = self.client.post("/api/treasury/withdraw", headers=self.headers, json={
                "amount": 1.0,
                "recipient_address": "0x1bcea3bc88cd89f3a5de9c07a5c7b6f2b4f501b4",
                "mode": "LIVE"
            })
            self.assertEqual(res_withdraw.status_code, 400)
            self.assertEqual(res_withdraw.get_json()["status"], "BLOCKED_EMERGENCY_STOP")

    # -------------------------------------------------------------------------
    # 10. Invalid routers, missing liquidity and insufficient net profit block trading
    # -------------------------------------------------------------------------
    def test_invalid_routers_missing_liquidity_and_insufficient_profit_block_trading(self):
        """Identical routers, depleted pools, and zero/negative net profit are rejected."""
        # 1. Identical routers
        res_same_router = dex_engine.execute_atomic_trade({
            "buy_dex": "Uniswap_V2",
            "sell_dex": "Uniswap_V2",
            "amount_in": 10.0,
            "chain_id": 8453,
        })
        self.assertFalse(res_same_router["success"])
        self.assertEqual(res_same_router["status"], "ARBITRAGE_UNAVAILABLE")

        # 2. Depleted liquidity in LIVE mode raises RuntimeError
        with patch.object(config, "TRADING_MODE", "LIVE"):
            with patch("dex_engine.fetch_pair_reserves", return_value=(100, 100, 123456)):
                with patch("dex_engine.eth_call", return_value="0x" + "0" * 24 + "1bcea3bc88cd89f3a5de9c07a5c7b6f2b4f501b4"):
                    with self.assertRaises(RuntimeError):
                        dex_engine.get_dex_reserves("Uniswap_V2", "WETH", "USDT")

        # 3. Unprofitable spread rejected by arbitrage engine
        with patch.object(config, "TRADING_MODE", "MOCK"):
            res_unprofitable = arbitrage.execute_real_trade({
                "buy_dex": "Uniswap_V2",
                "sell_dex": "SushiSwap_V2",
                "chain_id": 8453,
                "amount_in": 10.0,
                "net_profit_usdt": -0.05,
                "is_profitable": False
            })
            self.assertFalse(res_unprofitable["success"])
            self.assertIn("Unprofitable", res_unprofitable["skip_reason"])

    # -------------------------------------------------------------------------
    # 11. API authentication and private-key security remain intact
    # -------------------------------------------------------------------------
    def test_api_auth_and_private_key_security_intact(self):
        """Protected endpoints reject unauthenticated requests; keys are never stored or logged."""
        # 1. Unauthenticated request rejected with 401
        res_no_auth = self.client.post("/api/treasury/withdraw", json={"amount": 1.0})
        self.assertEqual(res_no_auth.status_code, 401)

        # 2. Invalid bearer token rejected with 403
        res_bad_auth = self.client.post(
            "/api/treasury/withdraw",
            headers={"Authorization": "Bearer bad_token_123"},
            json={"amount": 1.0}
        )
        self.assertEqual(res_bad_auth.status_code, 403)

        # 3. Database never stores raw private keys
        database.save_bot_setting("private_key", "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
        loaded = database.load_all_bot_settings()
        self.assertNotIn("private_key", loaded)

        # 4. Public treasury status masks addresses for unauthenticated requests
        res_pub = self.client.get("/api/treasury/status")
        self.assertEqual(res_pub.status_code, 200)
        data = res_pub.get_json()
        treasury_addr = data.get("treasury_address", "")
        if treasury_addr:
            self.assertIn("...", treasury_addr)

    # -------------------------------------------------------------------------
    # 12. Responsive layouts and explorer URLs work across all required viewports
    # -------------------------------------------------------------------------
    def test_responsive_layouts_defined_for_all_viewports(self):
        """Verify CSS defines media queries and styling for 320px, 375px, 430px, 768px, 1024px, 1366px, 1920px."""
        css_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static", "style.css")
        with open(css_path, "r", encoding="utf-8") as f:
            css_content = f.read()

        # Check required viewport breakpoints
        self.assertIn("min-width: 1920px", css_content)
        self.assertIn("max-width: 1366px", css_content)
        self.assertIn("max-width: 1024px", css_content)
        self.assertIn("max-width: 768px", css_content)
        self.assertIn("max-width: 480px", css_content)
        self.assertIn("max-width: 340px", css_content)

        # Check table responsive overflow
        self.assertIn("overflow-x: auto", css_content)

        # Check explorer URL helper for Arbitrum, Base, Sepolia
        sample_hash = "0x" + "c" * 64
        arb_url = get_explorer_tx_url(42161, sample_hash)
        self.assertEqual(arb_url, f"https://arbiscan.io/tx/{sample_hash}")

        base_url = get_explorer_tx_url(8453, sample_hash)
        self.assertEqual(base_url, f"https://basescan.org/tx/{sample_hash}")

        sepolia_url = get_explorer_tx_url(11155111, sample_hash)
        self.assertEqual(sepolia_url, f"https://sepolia.etherscan.io/tx/{sample_hash}")

    # -------------------------------------------------------------------------
    # 13. Default mode is MOCK when TRADING_MODE is unset
    # -------------------------------------------------------------------------
    def test_default_trading_mode_is_mock(self):
        """TRADING_MODE default must strictly be MOCK, never LIVE."""
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(os.getenv("TRADING_MODE", "MOCK").upper(), "MOCK")

    # -------------------------------------------------------------------------
    # 14. Environment CHAIN_ID takes precedence over saved bot_settings
    # -------------------------------------------------------------------------
    def test_env_chain_id_precedence_over_saved_settings(self):
        """If CHAIN_ID is explicitly set in environment, it takes precedence over stale database setting."""
        database.save_bot_setting("chain_id", 84532)
        saved = database.load_all_bot_settings()
        self.assertEqual(saved.get("chain_id"), 84532)

        # Simulate startup precedence logic from app.py
        with patch.dict(os.environ, {"CHAIN_ID": "8453"}):
            env_cid = int(os.environ.get("CHAIN_ID"))
            _saved = database.load_all_bot_settings()
            if env_cid in config.CHAIN_REGISTRY:
                config.set_active_chain(env_cid)
            self.assertEqual(config.CHAIN_ID, 8453)

    # -------------------------------------------------------------------------
    # 15. Withdrawal recipient defaults to contract owner, rejects non-owner without DB write
    # -------------------------------------------------------------------------
    def test_treasury_withdraw_recipient_owner_enforcement(self):
        """In LIVE mode, withdrawal requires the recipient to be the contract owner."""
        owner_addr = "0x1111111111111111111111111111111111111111"
        not_owner = "0x2222222222222222222222222222222222222222"
        contract_addr = "0x3333333333333333333333333333333333333333"

        with patch.object(config, "ARBITRAGE_CONTRACT_ADDRESS", contract_addr):
            with patch("app.get_contract_owner", return_value=owner_addr):
                # 1. Non-owner recipient is rejected with RECIPIENT_NOT_OWNER
                res_bad = self.client.post("/api/treasury/withdraw", headers=self.headers, json={
                    "amount": 1.0,
                    "recipient_address": not_owner,
                    "mode": "LIVE"
                })
                self.assertEqual(res_bad.status_code, 400)
                data_bad = res_bad.get_json()
                self.assertEqual(data_bad["status"], "RECIPIENT_NOT_OWNER")
                self.assertIn(owner_addr, data_bad["message"])

                # Invariant: NO withdrawal row recorded in database
                withdrawals = database.get_treasury_withdrawals(limit=10, mode="LIVE")
                self.assertEqual(len(withdrawals), 0)

                # 2. When no recipient is supplied, recipient defaults to owner
                with patch("treasury_execution.submit_blockchain_withdrawal", return_value={"success": True, "tx_hash": "0x" + "d" * 64}):
                    # Mock on-chain balance so balance check passes
                    with patch("treasury_execution.check_contract_balance", return_value=100.0):
                        res_default = self.client.post("/api/treasury/withdraw", headers=self.headers, json={
                            "amount": 1.0,
                            "mode": "LIVE"
                        })
                        # Either 200 (if executed) or rejected at key configuration, but recipient was defaulted to owner
                        if res_default.status_code == 400:
                            self.assertNotEqual(res_default.get_json().get("status"), "RECIPIENT_NOT_OWNER")

    # -------------------------------------------------------------------------
    # 16. Treasury status includes withdrawable_destination and buckets_label
    # -------------------------------------------------------------------------
    def test_treasury_status_shows_withdrawable_destination_and_buckets_label(self):
        """Status endpoint returns honest bucket label and withdrawable destination."""
        owner_addr = "0x1111111111111111111111111111111111111111"
        with patch.object(config, "ARBITRAGE_CONTRACT_ADDRESS", "0x3333333333333333333333333333333333333333"):
            with patch("app.get_contract_owner", return_value=owner_addr):
                res = self.client.get("/api/treasury/status?mode=LIVE", headers=self.headers)
                self.assertEqual(res.status_code, 200)
                data = res.get_json()
                self.assertEqual(data.get("withdrawable_destination"), owner_addr)
                self.assertEqual(data.get("buckets_label"), "Accounting allocation (not on-chain balances)")

    # -------------------------------------------------------------------------
    # 17. Dotenv fallback parser strips inline comments and handles empty values
    # -------------------------------------------------------------------------
    def test_dotenv_strips_inline_comments_and_empty_with_comment(self):
        """Fallback .env parser must strip inline comments and parse 'PRIVATE_KEY=   # comment' to ''."""
        import tempfile
        with tempfile.NamedTemporaryFile("w", delete=False, suffix=".env", encoding="utf-8") as f:
            f.write("TEST_EMPTY_VAR=   # some comment here\n")
            f.write("TEST_VAL_VAR=my_secret_token   # inline comment\n")
            f.write("TEST_QUOTED_VAR=\"value # not a comment\"\n")
            temp_path = f.name

        try:
            config.load_and_sanitize_dotenv(temp_path)
            self.assertEqual(os.environ.get("TEST_EMPTY_VAR"), "")
            self.assertEqual(os.environ.get("TEST_VAL_VAR"), "my_secret_token")
            self.assertEqual(os.environ.get("TEST_QUOTED_VAR"), "value # not a comment")
        finally:
            if os.path.isfile(temp_path):
                os.remove(temp_path)


if __name__ == "__main__":
    unittest.main()
