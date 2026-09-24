import os
import tempfile
import unittest
from unittest.mock import patch

import config
import arbitrage
import database
from dex_engine import execute_atomic_trade


class DEXSafetyGuardTests(unittest.TestCase):
    def setUp(self):
        self._orig_mode = config.TRADING_MODE
        self._orig_armed = config.LIVE_TRADING_ARMED
        config.TRADING_MODE = "MOCK"
        config.AUTO_TRADE_ENABLED = False
        config.LIVE_TRADING_ARMED = False
        config.EMERGENCY_STOP = False

    def tearDown(self):
        config.TRADING_MODE = self._orig_mode
        config.LIVE_TRADING_ARMED = self._orig_armed

    def test_emergency_stop_blocks_execution(self):
        with tempfile.TemporaryDirectory() as data_dir:
            with patch.dict(os.environ, {"DATA_DIR": data_dir}, clear=False):
                with patch.object(config, "EMERGENCY_STOP", True):
                    result = arbitrage.execute_real_trade({
                        "buy_dex": "Uniswap_V2",
                        "sell_dex": "SushiSwap_V2",
                        "amount_in": 100.0,
                        "net_profit_usdt": 2.50,
                        "is_profitable": True,
                    })
                    self.assertFalse(result["success"])
                    self.assertEqual(result["skip_reason"], "Emergency stop is active")

    def test_mock_mode_is_safe_by_default(self):
        # MOCK mode does not broadcast real transactions
        self.assertEqual(config.TRADING_MODE, "MOCK")
        self.assertFalse(config.LIVE_TRADING_ARMED)
        self.assertFalse(config.AUTO_TRADE_ENABLED)
        self.assertFalse(config.EMERGENCY_STOP)

    def test_live_trading_refuses_execution_when_not_armed(self):
        with patch.object(config, "TRADING_MODE", "LIVE"), patch.object(config, "LIVE_TRADING_ARMED", False), patch.object(config, "EMERGENCY_STOP", False):
            plan = {
                "buy_dex": "Uniswap_V2",
                "sell_dex": "SushiSwap_V2",
                "amount_in": 100.0,
                "net_profit_usdt": 1.0,
            }
            res = execute_atomic_trade(plan)
            self.assertFalse(res["success"])
            self.assertEqual(res["status"], "NOT_ARMED")

    def test_price_impact_limit_blocks_excessive_impact(self):
        with patch.object(config, "EMERGENCY_STOP", False), patch.object(config, "MAX_PRICE_IMPACT_PCT", 1.0):
            result = arbitrage.execute_real_trade({
                "buy_dex": "Uniswap_V2",
                "sell_dex": "SushiSwap_V2",
                "amount_in": 100.0,
                "net_profit_usdt": 2.50,
                "max_price_impact_pct": 3.5,  # Exceeds 1.0% limit
                "is_profitable": True,
            })
            self.assertFalse(result["success"])
            self.assertIn("Price impact", result["skip_reason"])

    def test_daily_loss_limit_blocks_execution(self):
        with tempfile.TemporaryDirectory() as data_dir:
            with patch.dict(os.environ, {"DATA_DIR": data_dir}, clear=False):
                with patch("arbitrage.get_today_live_profit", return_value=-15.0), patch.object(config, "MAX_DAILY_LOSS_USDT", 10.0), patch.object(config, "EMERGENCY_STOP", False):
                    result = arbitrage.execute_real_trade({
                        "buy_dex": "Uniswap_V2",
                        "sell_dex": "SushiSwap_V2",
                        "amount_in": 100.0,
                        "net_profit_usdt": 1.5,
                        "is_profitable": True,
                    })
                    self.assertFalse(result["success"])
                    self.assertIn("Daily net loss", result["skip_reason"])


if __name__ == "__main__":
    unittest.main()
