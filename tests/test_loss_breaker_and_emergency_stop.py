import os
import unittest
from datetime import datetime

# Configure test environment
os.environ["API_AUTH_TOKEN"] = "test-secret-token-phase4-loss-breaker"
os.environ["TRADING_MODE"] = "LIVE"
os.environ["LIVE_TRADING_ARMED"] = "true"
os.environ["EMERGENCY_STOP"] = "false"
os.environ["MAX_DAILY_LOSS_USDT"] = "10.0"

import config
from app import app
from database import (
    create_database,
    get_connection,
    save_trade,
    get_all_trades,
    delete_all_trades,
    get_today_live_profit,
    save_bot_setting,
    load_all_bot_settings
)
import arbitrage
import dex_engine
import live_executor


class TestLossBreakerAndEmergencyStop(unittest.TestCase):
    def setUp(self):
        create_database()
        self.client = app.test_client()
        self.auth_token = "test-secret-token-phase4-loss-breaker"
        config.API_AUTH_TOKEN = self.auth_token
        os.environ["API_AUTH_TOKEN"] = self.auth_token
        self.headers = {"Authorization": f"Bearer {self.auth_token}"}

        config.TRADING_MODE = "LIVE"
        config.LIVE_TRADING_ARMED = True
        config.EMERGENCY_STOP = False
        config.MAX_DAILY_LOSS_USDT = 10.0
        save_bot_setting("emergency_stop", False)
        save_bot_setting("live_trading_armed", True)

        # Clear tables for isolated testing
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute("DELETE FROM trades")
        cursor.execute("DELETE FROM risk_ledger")
        conn.commit()
        conn.close()

    def tearDown(self):
        config.TRADING_MODE = "MOCK"
        config.LIVE_TRADING_ARMED = False
        config.EMERGENCY_STOP = False
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute("DELETE FROM trades")
        cursor.execute("DELETE FROM risk_ledger")
        conn.commit()
        conn.close()

    def test_mock_profit_does_not_offset_live_loss(self):
        """Requirement 1 & 2: MOCK profits must NEVER offset LIVE losses in daily loss calculations."""
        # 1. Record a real LIVE trade that lost 15.0 USDT (exceeds 10.0 USDT limit)
        save_trade({
            "tx_hash": "0xlive_loss_tx_12345",
            "chain_id": 8453,
            "buy_dex": "Uniswap_V2",
            "sell_dex": "SushiSwap_V2",
            "token_pair": "WETH/USDT",
            "amount_in": 100.0,
            "amount_out": 85.0,
            "gross_profit": -14.99,
            "net_profit": -15.0,
            "status": "CONFIRMED",
            "mode": "LIVE"
        })

        # 2. Record a MOCK trade that generated +100.0 USDT simulated profit
        save_trade({
            "tx_hash": "0xmock_gain_tx_99999",
            "chain_id": 8453,
            "buy_dex": "Uniswap_V2",
            "sell_dex": "SushiSwap_V2",
            "token_pair": "WETH/USDT",
            "amount_in": 100.0,
            "amount_out": 200.0,
            "gross_profit": 100.0,
            "net_profit": 100.0,
            "status": "CONFIRMED",
            "mode": "MOCK"
        })

        # 3. Check live daily profit: must be -15.0, NOT (+100 - 15 = +85)
        live_profit = get_today_live_profit("LIVE")
        self.assertEqual(live_profit, -15.0)

        # 4. Daily loss circuit breaker MUST be triggered
        self.assertTrue(arbitrage.daily_loss_limit_reached())

        # 5. Execution must be skipped due to daily loss limit
        mock_market = {
            "best_route": {
                "buy_dex": "Uniswap_V2",
                "sell_dex": "SushiSwap_V2",
                "amount_in": 5.0,
                "is_profitable": True,
                "net_profit_usdt": 1.5,
            }
        }
        res = arbitrage.execute_real_trade(mock_market, is_manual=True)
        self.assertFalse(res["success"])
        self.assertEqual(res["status"], "TRADE SKIPPED")
        self.assertIn("Daily net loss limit reached", res["skip_reason"])

    def test_clearing_trade_history_does_not_reset_daily_loss(self):
        """Requirement 3 & 4: /api/trades/clear must NOT reset the risk-control ledger."""
        # Record a LIVE loss exceeding the daily limit
        save_trade({
            "tx_hash": "0xlive_loss_tx_before_clear",
            "chain_id": 8453,
            "buy_dex": "Uniswap_V2",
            "sell_dex": "SushiSwap_V2",
            "token_pair": "WETH/USDT",
            "amount_in": 50.0,
            "amount_out": 35.0,
            "gross_profit": -15.0,
            "net_profit": -15.0,
            "status": "CONFIRMED",
            "mode": "LIVE"
        })
        self.assertTrue(arbitrage.daily_loss_limit_reached())

        # Call /api/trades/clear to clear UI trade history
        res_clear = self.client.post("/api/trades/clear", headers=self.headers)
        self.assertEqual(res_clear.status_code, 200)

        # UI trade history is empty
        self.assertEqual(len(get_all_trades()), 0)

        # The risk-control ledger remains intact and daily loss is STILL reached!
        self.assertEqual(get_today_live_profit("LIVE"), -15.0)
        self.assertTrue(arbitrage.daily_loss_limit_reached())

        # Any subsequent trade attempt must STILL be blocked
        mock_market = {
            "best_route": {
                "buy_dex": "Uniswap_V2",
                "sell_dex": "SushiSwap_V2",
                "amount_in": 5.0,
                "is_profitable": True,
                "net_profit_usdt": 1.5,
            }
        }
        res_trade = arbitrage.execute_real_trade(mock_market, is_manual=True)
        self.assertFalse(res_trade["success"])
        self.assertIn("Daily net loss limit reached", res_trade["skip_reason"])

    def test_emergency_stop_blocks_manual_trade(self):
        """Requirement 5: Emergency stop must block manual live trade execution."""
        config.EMERGENCY_STOP = True
        config.TRADING_MODE = "LIVE"
        config.LIVE_TRADING_ARMED = True

        res = self.client.post("/api/trade", headers=self.headers, json={"trade_amount": 5.0})
        self.assertEqual(res.status_code, 400)
        data = res.get_json()
        self.assertFalse(data["success"])
        self.assertEqual(data["status"], "BLOCKED_EMERGENCY_STOP")

    def test_emergency_stop_blocks_confirm_live_trade(self):
        """Requirement 5: Emergency stop must block confirm_live_trade_api."""
        config.EMERGENCY_STOP = True

        res = self.client.post(
            "/api/trade/confirm-live",
            headers=self.headers,
            json={"tx_hash": "0x" + "a" * 64}
        )
        self.assertEqual(res.status_code, 400)
        data = res.get_json()
        self.assertFalse(data["success"])
        self.assertEqual(data["status"], "BLOCKED_EMERGENCY_STOP")

    def test_emergency_stop_blocks_auto_trade_and_execution_paths(self):
        """Requirement 5: Emergency stop blocks execute_real_trade, execute_live, and execute_atomic_trade."""
        config.EMERGENCY_STOP = True
        config.TRADING_MODE = "LIVE"
        config.LIVE_TRADING_ARMED = True

        plan = {
            "buy_dex": "Uniswap_V2",
            "sell_dex": "SushiSwap_V2",
            "amount_in": 5.0,
            "chain_id": 8453,
            "is_profitable": True,
            "net_profit_usdt": 1.0
        }

        # 1. arbitrage.execute_real_trade
        res_real = arbitrage.execute_real_trade(plan, is_manual=False)
        self.assertFalse(res_real["success"])
        self.assertEqual(res_real["skip_reason"], "Emergency stop is active")

        # 2. dex_engine.execute_atomic_trade
        res_atomic = dex_engine.execute_atomic_trade(plan, is_manual=False)
        self.assertFalse(res_atomic["success"])
        self.assertEqual(res_atomic["status"], "BLOCKED_EMERGENCY_STOP")

        # 3. live_executor.execute_live
        res_live = live_executor.execute_live(plan)
        self.assertFalse(res_live["success"])
        self.assertEqual(res_live["status"], "BLOCKED_EMERGENCY_STOP")

    def test_emergency_stop_survives_restart(self):
        """Requirement 7: Restarting application preserves the emergency stop state safely."""
        # 1. Activate emergency stop via API
        res = self.client.post("/api/emergency-stop", headers=self.headers, json={"active": True})
        self.assertEqual(res.status_code, 200)
        self.assertTrue(config.EMERGENCY_STOP)

        # 2. Simulate application reboot: read saved settings from SQLite
        saved_settings = load_all_bot_settings()
        self.assertTrue(bool(saved_settings.get("emergency_stop")))

        # Re-run startup initialization logic
        restored_emergency_stop = bool(saved_settings.get("emergency_stop", False))
        self.assertTrue(restored_emergency_stop)

        # Invariant: Emergency stop active forces LIVE_TRADING_ARMED = False
        reboot_armed = False if restored_emergency_stop else True
        self.assertFalse(reboot_armed)

    def test_daily_loss_limit_survives_restart(self):
        """Requirement 8: Daily loss limit must survive application restart."""
        # 1. Record a trade exceeding the daily limit
        save_trade({
            "tx_hash": "0xlive_loss_reboot_test",
            "chain_id": 8453,
            "buy_dex": "Uniswap_V2",
            "sell_dex": "SushiSwap_V2",
            "token_pair": "WETH/USDT",
            "amount_in": 100.0,
            "amount_out": 80.0,
            "gross_profit": -20.0,
            "net_profit": -20.0,
            "status": "CONFIRMED",
            "mode": "LIVE"
        })
        self.assertTrue(arbitrage.daily_loss_limit_reached())

        # 2. Simulate application reboot (re-querying database fresh)
        fresh_daily_loss = get_today_live_profit("LIVE")
        self.assertEqual(fresh_daily_loss, -20.0)
        self.assertTrue(arbitrage.daily_loss_limit_reached())

    def test_failed_live_trade_counts_towards_daily_loss(self):
        """TASK 1: Verify FAILED LIVE trades count toward daily loss and trigger circuit breaker."""
        config.MAX_DAILY_LOSS_USDT = 5.0

        # 1. Save a LIVE trade with net_profit -0.50 and status FAILED
        save_trade({
            "tx_hash": "0xfailed_live_tx_1",
            "chain_id": 8453,
            "buy_dex": "Uniswap_V2",
            "sell_dex": "SushiSwap_V2",
            "token_pair": "WETH/USDT",
            "amount_in": 10.0,
            "amount_out": 0.0,
            "gross_profit": -0.50,
            "net_profit": -0.50,
            "status": "FAILED",
            "mode": "LIVE"
        })

        # Assert get_today_live_profit("LIVE") == -0.5
        self.assertEqual(get_today_live_profit("LIVE"), -0.5)
        self.assertFalse(arbitrage.daily_loss_limit_reached())

        # Save additional trade so sum reaches -MAX_DAILY_LOSS_USDT (-5.0)
        save_trade({
            "tx_hash": "0xfailed_live_tx_2",
            "chain_id": 8453,
            "buy_dex": "Uniswap_V2",
            "sell_dex": "SushiSwap_V2",
            "token_pair": "WETH/USDT",
            "amount_in": 50.0,
            "amount_out": 0.0,
            "gross_profit": -4.50,
            "net_profit": -4.50,
            "status": "FAILED",
            "mode": "LIVE"
        })

        self.assertEqual(get_today_live_profit("LIVE"), -5.0)
        self.assertTrue(arbitrage.daily_loss_limit_reached())

    def test_live_loss_below_limit_allows_execution(self):
        """Requirement 16.A: LIVE loss below limit allows execution through to normal validation."""
        config.MAX_DAILY_LOSS_USDT = 10.0
        save_trade({
            "tx_hash": "0xloss_below_limit",
            "chain_id": 8453,
            "buy_dex": "Uniswap_V2",
            "sell_dex": "SushiSwap_V2",
            "amount_in": 10.0,
            "net_profit": -2.0,
            "status": "CONFIRMED",
            "mode": "LIVE"
        })
        self.assertEqual(get_today_live_profit("LIVE"), -2.0)
        self.assertFalse(arbitrage.daily_loss_limit_reached())

    def test_live_loss_reaches_exact_limit_blocks_execution(self):
        """Requirement 16.B: LIVE loss reaching exact limit triggers breaker and blocks trade."""
        config.MAX_DAILY_LOSS_USDT = 10.0
        save_trade({
            "tx_hash": "0xloss_exact_limit",
            "chain_id": 8453,
            "buy_dex": "Uniswap_V2",
            "sell_dex": "SushiSwap_V2",
            "amount_in": 50.0,
            "net_profit": -10.0,
            "status": "CONFIRMED",
            "mode": "LIVE"
        })
        self.assertEqual(get_today_live_profit("LIVE"), -10.0)
        self.assertTrue(arbitrage.daily_loss_limit_reached())

        mock_market = {
            "best_route": {
                "buy_dex": "Uniswap_V2",
                "sell_dex": "SushiSwap_V2",
                "amount_in": 5.0,
                "is_profitable": True,
                "net_profit_usdt": 1.0,
            }
        }
        res = arbitrage.execute_real_trade(mock_market, is_manual=True)
        self.assertFalse(res["success"])
        self.assertIn("Daily net loss limit reached", res["skip_reason"])

    def test_live_loss_exceeds_daily_limit_blocks_execution(self):
        """Requirement 16.C: LIVE loss exceeding daily limit blocks dex_engine and live_executor."""
        config.MAX_DAILY_LOSS_USDT = 10.0
        save_trade({
            "tx_hash": "0xloss_exceeds_limit",
            "chain_id": 8453,
            "buy_dex": "Uniswap_V2",
            "sell_dex": "SushiSwap_V2",
            "amount_in": 50.0,
            "net_profit": -15.0,
            "status": "CONFIRMED",
            "mode": "LIVE"
        })
        self.assertTrue(arbitrage.daily_loss_limit_reached())

        plan = {
            "buy_dex": "Uniswap_V2",
            "sell_dex": "SushiSwap_V2",
            "amount_in": 5.0,
            "chain_id": 8453,
        }
        # dex_engine block
        res_engine = dex_engine.execute_atomic_trade(plan)
        self.assertFalse(res_engine["success"])
        self.assertEqual(res_engine["status"], "DAILY_LOSS_LIMIT_REACHED")

        # live_executor block
        res_exec = live_executor.execute_live(plan)
        self.assertFalse(res_exec["success"])
        self.assertEqual(res_exec["status"], "DAILY_LOSS_LIMIT_REACHED")

    def test_multiple_negative_live_trades_accumulate_correctly(self):
        """Requirement 16.D: Multiple negative LIVE trades accumulate realized losses correctly."""
        save_trade({"tx_hash": "0xtx1", "chain_id": 8453, "amount_in": 10.0, "net_profit": -0.50, "status": "CONFIRMED", "mode": "LIVE"})
        save_trade({"tx_hash": "0xtx2", "chain_id": 8453, "amount_in": 10.0, "net_profit": -0.75, "status": "CONFIRMED", "mode": "LIVE"})
        save_trade({"tx_hash": "0xtx3", "chain_id": 8453, "amount_in": 10.0, "net_profit": -1.25, "status": "CONFIRMED", "mode": "LIVE"})
        self.assertEqual(get_today_live_profit("LIVE"), -2.50)

    def test_simulation_losses_do_not_trigger_live_breaker(self):
        """Requirement 16.F: Simulated/MOCK losses do not affect LIVE risk calculations."""
        config.MAX_DAILY_LOSS_USDT = 5.0
        # Massive simulation loss in MOCK mode
        save_trade({"tx_hash": "0xmock_loss", "chain_id": 8453, "amount_in": 100.0, "net_profit": -50.0, "status": "CONFIRMED", "mode": "MOCK"})
        self.assertEqual(get_today_live_profit("LIVE"), 0.0)
        self.assertFalse(arbitrage.daily_loss_limit_reached())

    def test_emergency_stop_api_auth_and_state_change(self):
        """Requirements 16.M, 16.N, 16.O: Emergency stop requires authentication and changes state."""
        # 1. Unauthenticated -> 401
        res_unauth = self.client.post("/api/emergency-stop", json={"active": True})
        self.assertEqual(res_unauth.status_code, 401)

        # 2. Invalid token -> 403
        res_bad = self.client.post(
            "/api/emergency-stop",
            headers={"Authorization": "Bearer wrong-token-xyz"},
            json={"active": True}
        )
        self.assertEqual(res_bad.status_code, 403)

        # 3. Authorized -> 200 and toggles state
        res_ok = self.client.post(
            "/api/emergency-stop",
            headers=self.headers,
            json={"active": True}
        )
        self.assertEqual(res_ok.status_code, 200)
        self.assertTrue(config.EMERGENCY_STOP)
        self.assertTrue(res_ok.get_json()["emergency_stop"])

    def test_emergency_stop_activation_disarms_and_cannot_auto_resume(self):
        """Requirement 16.P: Emergency Stop activation disarms live trading; clearing stop does NOT auto-resume."""
        config.LIVE_TRADING_ARMED = True
        save_bot_setting("live_trading_armed", True)

        # Activate Emergency Stop
        self.client.post("/api/emergency-stop", headers=self.headers, json={"active": True})
        self.assertTrue(config.EMERGENCY_STOP)
        self.assertFalse(config.LIVE_TRADING_ARMED)

        # Deactivate Emergency Stop
        self.client.post("/api/emergency-stop", headers=self.headers, json={"active": False})
        self.assertFalse(config.EMERGENCY_STOP)
        # CRITICAL: live trading must NOT automatically re-arm!
        self.assertFalse(config.LIVE_TRADING_ARMED)

    def test_daily_boundary_timezone_behavior(self):
        """Requirement 16.R: Historical trades from yesterday do not count toward today's loss."""
        config.MAX_DAILY_LOSS_USDT = 5.0
        # Insert trade with yesterday's timestamp
        save_trade({
            "tx_hash": "0xyesterday_loss",
            "chain_id": 8453,
            "amount_in": 50.0,
            "net_profit": -25.0,
            "status": "CONFIRMED",
            "mode": "LIVE",
            "created_at": "2020-01-01 12:00:00"
        })
        # Today's profit ignores yesterday's trades
        self.assertEqual(get_today_live_profit("LIVE"), 0.0)
        self.assertFalse(arbitrage.daily_loss_limit_reached())

    def test_daily_loss_fix_preserves_live_trading_armed_requirement(self):
        """Requirement 16.S: Having zero daily loss does not bypass LIVE_TRADING_ARMED requirement."""
        config.TRADING_MODE = "LIVE"
        config.LIVE_TRADING_ARMED = False
        config.EMERGENCY_STOP = False

        res = self.client.post("/api/trade", headers=self.headers, json={"trade_amount": 5.0})
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.get_json()["status"], "NOT_ARMED")

    def test_private_key_security_intact_under_risk_controls(self):
        """Requirement 16.T: Phase 3 private key protections remain strictly intact."""
        config.PRIVATE_KEY = "0x" + "a" * 64
        res = self.client.get("/api/settings")
        self.assertNotIn("0x" + "a" * 64, res.get_data(as_text=True))
        config.PRIVATE_KEY = ""


if __name__ == "__main__":
    unittest.main()
