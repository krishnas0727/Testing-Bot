import os
import tempfile
import unittest
from unittest.mock import patch

import config
import database
from dex_contract import TREASURY_ABI, ARBITRAGE_EXECUTOR_ABI, DEX_ARBITRAGE_ABI


class TreasuryAndArbitrageSystemTests(unittest.TestCase):
    def setUp(self):
        self._temp_dir = tempfile.TemporaryDirectory()
        self._db_path = os.path.join(self._temp_dir.name, "test_treasury.db")
        self._orig_db = database.DATABASE_NAME
        self._orig_config_db = config.DATABASE_NAME
        database.DATABASE_NAME = self._db_path
        config.DATABASE_NAME = self._db_path
        database.create_database()

    def tearDown(self):
        database.DATABASE_NAME = self._orig_db
        config.DATABASE_NAME = self._orig_config_db
        self._temp_dir.cleanup()

    def test_treasury_contract_abi_contains_required_functions(self):
        """Module 8: Verify Treasury.sol ABI exposes all specified functions."""
        function_names = [item["name"] for item in TREASURY_ABI if item.get("type") == "function"]
        required_functions = [
            "depositProfit",
            "withdraw",
            "emergencyWithdraw",
            "emergencyWithdrawETH",
            "setAllocationBps",
            "setArbitrageExecutor",
            "getBucketBalances",
            "admin",
            "arbitrageExecutor",
            "tradingCapitalBps",
            "reserveBps",
            "revenueBps",
            "paused",
        ]
        for fn in required_functions:
            self.assertIn(fn, function_names, f"Treasury ABI missing function: {fn}")

    def test_arbitrage_executor_abi_contains_required_functions(self):
        """Module 7: Verify ArbitrageExecutor.sol ABI exposes all specified functions."""
        function_names = [item["name"] for item in ARBITRAGE_EXECUTOR_ABI if item.get("type") == "function"]
        required_functions = [
            "executeArbitrage",
            "simulateArbitrage",
            "admin",
            "treasury",
            "paused",
            "togglePause",
            "setRouterWhitelist",
            "setTokenWhitelist",
            "setExecutor",
            "setTreasury",
            "routerWhitelist",
            "tokenWhitelist",
        ]
        for fn in required_functions:
            self.assertIn(fn, function_names, f"ArbitrageExecutor ABI missing function: {fn}")

    def test_revenue_allocation_60_20_20_calculation(self):
        """Module 9: Verify 60% Trading Capital, 20% Reserve, 20% Revenue allocation math."""
        net_profit = 10.00
        trading_capital = round(net_profit * 0.60, 4)
        reserve = round(net_profit * 0.20, 4)
        revenue = round(net_profit * 0.20, 4)

        self.assertEqual(trading_capital, 6.00)
        self.assertEqual(reserve, 2.00)
        self.assertEqual(revenue, 2.00)
        self.assertEqual(trading_capital + reserve + revenue, net_profit)

        # Test database persistence of allocation
        alloc_id = database.record_treasury_allocation({
            "trade_id": 1,
            "tx_hash": "0xtest_hash_1",
            "chain_id": 8453,
            "token": "USDC",
            "gross_profit": 10.50,
            "net_profit": net_profit,
            "trading_capital": trading_capital,
            "reserve": reserve,
            "revenue": revenue
        })
        self.assertGreater(alloc_id, 0)

        # Query summary
        summary = database.get_treasury_buckets_summary()
        self.assertEqual(summary["trading_capital"], 6.00)
        self.assertEqual(summary["reserve"], 2.00)
        self.assertEqual(summary["revenue"], 2.00)
        self.assertEqual(summary["total_allocated"], 10.00)

    def test_save_trade_computes_roi_and_allocates_treasury(self):
        """Module 3 & 9: Verify save_trade accurately computes ROI% and records treasury allocation."""
        trade_data = {
            "tx_hash": "0xtest_trade_roi",
            "chain_id": 8453,
            "buy_dex": "Uniswap_V2",
            "sell_dex": "SushiSwap_V2",
            "token_pair": "WETH/USDC",
            "amount_in": 50.0,
            "amount_out": 52.5,
            "gross_profit": 2.50,
            "net_profit": 2.00,
            "gas_cost_usdt": 0.50,
            "status": "CONFIRMED",
            "mode": "LIVE"
        }
        trade_id = database.save_trade(trade_data)
        self.assertGreater(trade_id, 0)

        # Retrieve saved trade
        trades = database.get_all_trades(mode="LIVE")
        self.assertEqual(len(trades), 1)
        saved = trades[0]

        # ROI = (2.00 / 50.0) * 100 = 4.0%
        self.assertAlmostEqual(saved.get("roi", 0.0), 4.0, places=2)
        self.assertEqual(saved.get("initial_capital", 0.0), 50.0)

        # Verify automatic treasury allocation was created
        allocations = database.get_treasury_allocations()
        self.assertEqual(len(allocations), 1)
        alloc = allocations[0]
        self.assertEqual(alloc["net_profit"], 2.00)
        self.assertEqual(alloc["trading_capital"], 1.20)  # 60%
        self.assertEqual(alloc["reserve"], 0.40)          # 20%
        self.assertEqual(alloc["revenue"], 0.40)          # 20%

    def test_treasury_withdrawals_and_withdrawable_profit(self):
        """Module 8: Verify total realized profit, withdrawals, and withdrawable balance."""
        # 1. Save two profitable trades: $3.00 + $2.00 = $5.00 net profit
        database.save_trade({
            "tx_hash": "0xtrade_1",
            "chain_id": 8453,
            "amount_in": 10.0,
            "net_profit": 3.00,
            "status": "CONFIRMED",
            "mode": "LIVE"
        })
        database.save_trade({
            "tx_hash": "0xtrade_2",
            "chain_id": 8453,
            "amount_in": 10.0,
            "net_profit": 2.00,
            "status": "CONFIRMED",
            "mode": "LIVE"
        })

        self.assertEqual(database.get_total_profit(mode="LIVE"), 5.00)
        self.assertEqual(database.get_total_withdrawn(mode="LIVE"), 0.00)
        self.assertEqual(database.get_withdrawable_profit(mode="LIVE"), 5.00)

        # 2. Record a withdrawal of $1.50
        withdrawn_id = database.record_treasury_withdrawal({
            "tx_hash": "0x" + "a" * 64,
            "chain_id": 8453,
            "token": "USDC",
            "amount": 1.50,
            "recipient_address": "0x1234567890123456789012345678901234567890",
            "status": "CONFIRMED",
            "mode": "LIVE"
        })
        self.assertGreater(withdrawn_id, 0)

        # 3. Check updated withdrawable profit: $5.00 - $1.50 = $3.50
        self.assertEqual(database.get_total_withdrawn(mode="LIVE"), 1.50)
        self.assertEqual(database.get_withdrawable_profit(mode="LIVE"), 3.50)

    def test_pnl_summary_win_rate_and_roi(self):
        """Module 12: Verify get_live_pnl_summary correctly calculates win_rate and overall ROI."""
        database.save_trade({
            "tx_hash": "0xtrade_w1",
            "chain_id": 8453,
            "amount_in": 20.0,
            "net_profit": 2.00,
            "status": "CONFIRMED",
            "mode": "LIVE"
        })
        database.save_trade({
            "tx_hash": "0xtrade_w2",
            "chain_id": 8453,
            "amount_in": 20.0,
            "net_profit": 4.00,
            "status": "CONFIRMED",
            "mode": "LIVE"
        })

        summary = database.get_live_pnl_summary(mode="LIVE")
        self.assertEqual(summary["total_trades"], 2)
        self.assertEqual(summary["winning_trades"], 2)
        self.assertEqual(summary["win_rate"], 100.0)
        # Total profit: 6.00 on 40.00 capital -> ROI = 15.0%
        self.assertEqual(summary["roi"], 15.0)
        self.assertEqual(summary["total_net_profit"], 6.00)


if __name__ == "__main__":
    unittest.main()
