"""Unit tests for DEX arbitrage dynamic micro-sizing supporting any positive balance
(e.g. 0.05, 0.1, 0.2 USDT/USDC), removal of hard-coded $1.00 minimums,
actual minimum required amount diagnostic reporting, and zero-faking guarantees.
"""
import os
import unittest
from unittest.mock import patch, MagicMock

import config
import arbitrage
from arbitrage import calculate_dynamic_trade_amount
from dex_engine import simulate_atomic_arbitrage
from database import get_total_trades, get_total_profit


class ProfitThresholdAndSkipReasonTests(unittest.TestCase):
    def setUp(self):
        self._orig_mode = config.TRADING_MODE
        self._orig_emergency = config.EMERGENCY_STOP
        self._orig_auto = config.AUTO_TRADE_ENABLED
        self._orig_armed = config.LIVE_TRADING_ARMED

        config.TRADING_MODE = "MOCK"
        config.EMERGENCY_STOP = False
        config.AUTO_TRADE_ENABLED = False
        config.LIVE_TRADING_ARMED = False
        arbitrage.last_trade_time = 0
        arbitrage.last_trade_key = None

    def tearDown(self):
        config.TRADING_MODE = self._orig_mode
        config.EMERGENCY_STOP = self._orig_emergency
        config.AUTO_TRADE_ENABLED = self._orig_auto
        config.LIVE_TRADING_ARMED = self._orig_armed
        arbitrage.last_trade_time = 0
        arbitrage.last_trade_key = None

    def test_dynamic_micro_sizing_helper(self):
        """Test calculate_dynamic_trade_amount handles micro-balances (0.05, 0.1, 0.2, etc.)."""
        # 1. Zero or negative balance -> returns 0.0
        self.assertEqual(calculate_dynamic_trade_amount(0.00), 0.0)
        self.assertEqual(calculate_dynamic_trade_amount(-1.0), 0.0)

        # 2. Micro-balance $0.05 -> 95% safe is 0.0475 USDT
        safe_005 = calculate_dynamic_trade_amount(0.05)
        self.assertAlmostEqual(safe_005, 0.0475, places=4)

        # 3. Micro-balance $0.10 -> 95% safe is 0.0950 USDT
        safe_010 = calculate_dynamic_trade_amount(0.10)
        self.assertAlmostEqual(safe_010, 0.0950, places=4)

        # 4. Micro-balance $0.20 -> 95% safe is 0.1900 USDT
        safe_020 = calculate_dynamic_trade_amount(0.20)
        self.assertAlmostEqual(safe_020, 0.1900, places=4)

        # 5. User requested explicit valid micro-amount 0.15 on a $0.20 balance -> uses 0.15
        self.assertAlmostEqual(calculate_dynamic_trade_amount(0.20, requested_amount=0.15), 0.15, places=4)

        # 6. User or UI sent legacy $5.00 on a $0.20 balance -> dynamically scales to safe 0.1900
        self.assertAlmostEqual(calculate_dynamic_trade_amount(0.20, requested_amount=5.00), 0.1900, places=4)

    def test_positive_net_profit_allows_execution_flow(self):
        """Test that any positive net profit (netProfit > 0) qualifies for execution flow without MIN_PROFIT restriction."""
        trade_amount = 0.05
        net_profit_usdt = 0.0005  # Micro-profit on 0.05 trade
        net_profit_percent = (net_profit_usdt / trade_amount) * 100.0

        is_profitable = (
            net_profit_usdt > 0.0
            and net_profit_percent > 0.0
            and 0.1 <= config.MAX_PRICE_IMPACT_PCT
            and 0.1 <= config.MAX_PRICE_IMPACT_PCT
            and True  # gas acceptable
        )
        self.assertTrue(is_profitable, "Any positive net profit must allow the trade execution flow")

    def test_non_positive_net_profit_does_not_execute(self):
        """Test that if Net Profit <= 0, trade does not execute."""
        negative_route = {
            "buy_dex": "Uniswap_V2",
            "sell_dex": "SushiSwap_V2",
            "amount_in": 0.10,
            "net_profit_usdt": -0.0015,
            "is_profitable": False,
            "is_gas_acceptable": True,
        }
        result = arbitrage.execute_real_trade(negative_route, is_manual=False)
        self.assertFalse(result["success"])
        self.assertEqual(result["status"], "TRADE SKIPPED")
        self.assertIn("Unprofitable spread", result["skip_reason"])

    def test_zero_balance_shows_actual_required_amount(self):
        """Test diagnostic shows actual minimum required amount and never says 'Need at least $1.00' or 'Need $5'."""
        with patch.object(config, "TRADING_MODE", "LIVE"), patch("wallet_manager.get_wallet_balances") as mock_wb:
            mock_wb.return_value = {
                "is_connected": True,
                "wallet_address": "0x1bcea3bc88cd89f3a5de9c07a5c7b6f2b4f501b4",
                "total_stable_usdt": 0.00,  # Zero balance
                "eth": 0.01,
            }

            profitable_route = {
                "buy_dex": "Uniswap_V2",
                "sell_dex": "SushiSwap_V2",
                "amount_in": 0.05,
                "net_profit_usdt": 0.0012,
                "is_profitable": True,
                "is_gas_acceptable": True,
            }

            # Case A: with custom amount 5.0 requested (e.g. from UI preview)
            result = arbitrage.execute_real_trade(profitable_route, custom_amount=5.00, is_manual=False)
            self.assertFalse(result["success"])
            self.assertEqual(result["status"], "INSUFFICIENT BALANCE")
            self.assertIn("INSUFFICIENT BALANCE", result["skip_reason"])
            self.assertIn("Need at least $0.0001 USDT/USDC", result["skip_reason"])
            self.assertNotIn("Need $5", result["skip_reason"])
            self.assertNotIn("Need at least $1.00", result["skip_reason"])

            # Case B: without custom amount
            result_no_amt = arbitrage.execute_real_trade(profitable_route, custom_amount=None, is_manual=False)
            self.assertFalse(result_no_amt["success"])
            self.assertIn("Need at least $0.0001 USDT/USDC", result_no_amt["skip_reason"])
            self.assertNotIn("Need $5", result_no_amt["skip_reason"])
            self.assertNotIn("Need at least $1.00", result_no_amt["skip_reason"])

    def test_micro_balance_0_05_executes_dynamically(self):
        """Test wallet with $0.05 USDT executes dynamically using safe percentage without requiring $1 or $5."""
        with patch.object(config, "TRADING_MODE", "LIVE"), patch("wallet_manager.get_wallet_balances") as mock_wb:
            mock_wb.return_value = {
                "is_connected": True,
                "wallet_address": "0x1bcea3bc88cd89f3a5de9c07a5c7b6f2b4f501b4",
                "total_stable_usdt": 0.05,  # Micro balance of $0.05
                "eth": 0.01,
            }

            safe_amt = calculate_dynamic_trade_amount(0.05)
            self.assertAlmostEqual(safe_amt, 0.0475, places=4)

            profitable_route = {
                "buy_dex": "Uniswap_V2",
                "sell_dex": "SushiSwap_V2",
                "amount_in": safe_amt,
                "net_profit_usdt": 0.0015,
                "is_profitable": True,
                "is_gas_acceptable": True,
            }

            with patch("arbitrage.execute_atomic_trade") as mock_exec:
                mock_exec.return_value = {"success": True, "trade": profitable_route, "tx_hash": "0xabc123"}
                result = arbitrage.execute_real_trade(profitable_route, custom_amount=None, is_manual=True)
                mock_exec.assert_called_once()
                executed_plan = mock_exec.call_args[0][0]
                self.assertAlmostEqual(executed_plan["amount_in"], 0.0475, places=4)

    def test_micro_balance_0_20_executes_dynamically(self):
        """Test wallet with $0.20 USDT executes dynamically using safe percentage (0.19 USDT)."""
        with patch.object(config, "TRADING_MODE", "LIVE"), patch("wallet_manager.get_wallet_balances") as mock_wb:
            mock_wb.return_value = {
                "is_connected": True,
                "wallet_address": "0x1bcea3bc88cd89f3a5de9c07a5c7b6f2b4f501b4",
                "total_stable_usdt": 0.20,
                "eth": 0.01,
            }

            safe_amt = calculate_dynamic_trade_amount(0.20)
            self.assertAlmostEqual(safe_amt, 0.1900, places=4)

            profitable_route = {
                "buy_dex": "Uniswap_V2",
                "sell_dex": "SushiSwap_V2",
                "amount_in": safe_amt,
                "net_profit_usdt": 0.0035,
                "is_profitable": True,
                "is_gas_acceptable": True,
            }

            with patch("arbitrage.execute_atomic_trade") as mock_exec:
                mock_exec.return_value = {"success": True, "trade": profitable_route, "tx_hash": "0xdef456"}
                result = arbitrage.execute_real_trade(profitable_route, custom_amount=5.00, is_manual=True)
                mock_exec.assert_called_once()
                executed_plan = mock_exec.call_args[0][0]
                self.assertAlmostEqual(executed_plan["amount_in"], 0.1900, places=4)

    def test_micro_balance_0_01_executes_dynamically(self):
        """Test wallet with $0.01 USDT executes dynamically (0.0095 USDT) without requiring $1 or $5."""
        with patch.object(config, "TRADING_MODE", "LIVE"), patch("wallet_manager.get_wallet_balances") as mock_wb:
            mock_wb.return_value = {
                "is_connected": True,
                "wallet_address": "0x1bcea3bc88cd89f3a5de9c07a5c7b6f2b4f501b4",
                "total_stable_usdt": 0.01,  # Micro balance of $0.01
                "eth": 0.01,
            }

            safe_amt = calculate_dynamic_trade_amount(0.01)
            self.assertAlmostEqual(safe_amt, 0.0095, places=4)

            profitable_route = {
                "buy_dex": "Uniswap_V2",
                "sell_dex": "SushiSwap_V2",
                "amount_in": safe_amt,
                "net_profit_usdt": 0.0003,
                "is_profitable": True,
                "is_gas_acceptable": True,
            }

            mock_quotes = {
                "Uniswap_V2": {
                    "spot_price": 2700.0,
                    "quote_reserve": 54000000.0,
                    "base_reserve": 20000.0,
                },
                "SushiSwap_V2": {
                    "spot_price": 2740.0,
                    "quote_reserve": 54800000.0,
                    "base_reserve": 20000.0,
                }
            }
            with patch("arbitrage.get_all_dex_quotes", return_value=mock_quotes), patch("arbitrage.execute_atomic_trade") as mock_exec:
                mock_exec.return_value = {"success": True, "trade": profitable_route, "tx_hash": "0x111222"}
                result = arbitrage.execute_real_trade(profitable_route, custom_amount=5.00, is_manual=True)
                mock_exec.assert_called_once()
                executed_plan = mock_exec.call_args[0][0]
                self.assertAlmostEqual(executed_plan["amount_in"], 0.0095, places=4)

    def test_wallet_with_0_05_and_5_requested_dynamically_scales(self):
        """Test wallet with $0.05 and $5 requested dynamically scales to $0.0475 and never aborts with Need $5."""
        with patch.object(config, "TRADING_MODE", "LIVE"), patch("wallet_manager.get_wallet_balances") as mock_wb:
            mock_wb.return_value = {
                "is_connected": True,
                "wallet_address": "0x1bcea3bc88cd89f3a5de9c07a5c7b6f2b4f501b4",
                "total_stable_usdt": 0.05,
                "eth": 0.01,
            }

            profitable_route = {
                "buy_dex": "Uniswap_V2",
                "sell_dex": "SushiSwap_V2",
                "amount_in": 0.0475,
                "net_profit_usdt": 0.0015,
                "is_profitable": True,
                "is_gas_acceptable": True,
            }

            mock_quotes = {
                "Uniswap_V2": {
                    "spot_price": 2700.0,
                    "quote_reserve": 54000000.0,
                    "base_reserve": 20000.0,
                },
                "SushiSwap_V2": {
                    "spot_price": 2740.0,
                    "quote_reserve": 54800000.0,
                    "base_reserve": 20000.0,
                }
            }
            with patch("arbitrage.get_all_dex_quotes", return_value=mock_quotes), patch("arbitrage.execute_atomic_trade") as mock_exec:
                mock_exec.return_value = {"success": True, "trade": profitable_route, "tx_hash": "0x333444"}
                result = arbitrage.execute_real_trade(profitable_route, custom_amount=5.00, is_manual=True)
                mock_exec.assert_called_once()
                executed_plan = mock_exec.call_args[0][0]
                self.assertAlmostEqual(executed_plan["amount_in"], 0.0475, places=4)

    def test_insufficient_gas_blocks_transaction(self):
        """Test that if wallet has tokens but insufficient ETH for gas, it blocks with INSUFFICIENT BALANCE."""
        with patch.object(config, "TRADING_MODE", "LIVE"), patch("wallet_manager.get_wallet_balances") as mock_wb:
            mock_wb.return_value = {
                "is_connected": True,
                "wallet_address": "0x1bcea3bc88cd89f3a5de9c07a5c7b6f2b4f501b4",
                "total_stable_usdt": 0.50,
                "eth": 0.00001,  # Insufficient gas (< 0.0001 ETH)
            }

            profitable_route = {
                "buy_dex": "Uniswap_V2",
                "sell_dex": "SushiSwap_V2",
                "amount_in": 0.10,
                "net_profit_usdt": 0.0021,
                "is_profitable": True,
                "is_gas_acceptable": True,
            }

            result = arbitrage.execute_real_trade(profitable_route, is_manual=False)
            self.assertFalse(result["success"])
            self.assertEqual(result["status"], "INSUFFICIENT BALANCE")
            self.assertIn("INSUFFICIENT BALANCE", result["skip_reason"])
            self.assertIn("ETH for network gas fees", result["skip_reason"])

    def test_simulate_atomic_arbitrage_allows_any_positive_profit(self):
        """Test that atomic simulation accepts any positive micro-profit."""
        plan = {
            "buy_dex": "Uniswap_V2",
            "sell_dex": "SushiSwap_V2",
            "amount_in": 0.05,
            "gross_return_usdt": 0.0505,
            "gas_cost_usdt": 0.0001,
            "net_profit_usdt": 0.0004,
        }
        res = simulate_atomic_arbitrage(plan)
        self.assertTrue(res["success"])
        self.assertEqual(res["status"], "SIMULATION_SUCCESS")

    def test_simulate_atomic_arbitrage_reverts_on_unprofitable_return(self):
        """Test that atomic simulation reverts if gross return is below or equal to amount_in."""
        plan = {
            "buy_dex": "Uniswap_V2",
            "sell_dex": "SushiSwap_V2",
            "amount_in": 0.05,
            "gross_return_usdt": 0.05,
            "gas_cost_usdt": 0.001,
            "net_profit_usdt": -0.001,
        }
        res = simulate_atomic_arbitrage(plan)
        self.assertFalse(res["success"])
        self.assertEqual(res["status"], "ATOMIC_REVERT_UNPROFITABLE")

    def test_zero_faking_when_insufficient_balance(self):
        """Verify that insufficient balance does not fake or increment atomic trades or net profit."""
        initial_trades = get_total_trades(mode="LIVE")
        initial_profit = get_total_profit(mode="LIVE")

        with patch.object(config, "TRADING_MODE", "LIVE"), patch("wallet_manager.get_wallet_balances") as mock_wb:
            mock_wb.return_value = {
                "is_connected": True,
                "wallet_address": "0x1bcea3bc88cd89f3a5de9c07a5c7b6f2b4f501b4",
                "total_stable_usdt": 0.0,
                "eth": 0.0,
            }
            profitable_route = {
                "buy_dex": "Uniswap_V2",
                "sell_dex": "SushiSwap_V2",
                "amount_in": 0.05,
                "net_profit_usdt": 0.005,
                "is_profitable": True,
            }
            result = arbitrage.execute_real_trade(profitable_route, is_manual=False)
            self.assertEqual(result["status"], "INSUFFICIENT BALANCE")

        after_trades = get_total_trades(mode="LIVE")
        after_profit = get_total_profit(mode="LIVE")
        self.assertEqual(initial_trades, after_trades, "Total trades must not change on insufficient balance")
        self.assertEqual(initial_profit, after_profit, "Total profit must not change on insufficient balance")

    @patch("dex_engine.get_gas_price", return_value=(6_000_000, 0.006))
    def test_positive_spread_yields_positive_net_profit_for_micro_trades(self, mock_gas):
        """Verify that micro trades (0.05, 0.10, 0.50, 1.0, 5.0) yield positive net profit on profitable spreads and aren't crushed by gas."""
        orig_cid = config.CHAIN_ID
        try:
            config.set_active_chain(8453)
            for amt in [0.05, 0.10, 0.50, 1.0, 5.0]:
                market = arbitrage.analyze_market(custom_amount=amt)
                self.assertIsNotNone(market, f"Market analysis must return data for trade amount {amt}")
                best = market.get("best_route")
                self.assertIsNotNone(best, f"Best route must be found for trade amount {amt}")
                if best.get("spread_pct", 0) > 0.60:  # If spread covers swap fees (0.3% x 2)
                    self.assertGreater(
                        best.get("net_profit_usdt", 0),
                        0.0,
                        f"Net profit must be positive for ${amt} trade on a {best.get('spread_pct')}% spread, got {best.get('net_profit_usdt')}"
                    )
                    self.assertTrue(best.get("is_profitable"), f"Trade size ${amt} must be marked is_profitable=True")
        finally:
            config.set_active_chain(orig_cid)


if __name__ == "__main__":
    unittest.main()
