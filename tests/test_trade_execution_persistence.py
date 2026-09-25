import unittest
import time
from datetime import datetime
import config
from app import app, record_execution_event, execution_audit_logs
from database import (
    create_database,
    save_trade,
    get_all_trades,
    get_latest_trade,
    save_execution_log,
    get_recent_execution_logs,
    delete_all_trades,
    get_live_pnl_summary,
)
from dex_engine import execute_atomic_trade


class TradeExecutionPersistenceTests(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()
        delete_all_trades()
        config.set_active_chain(8453)
        config.TRADING_MODE = "MOCK"
        config.EMERGENCY_STOP = False

    def tearDown(self):
        delete_all_trades()
        config.TRADING_MODE = "MOCK"
        config.EMERGENCY_STOP = False

    def test_mock_trade_execution_zero_error(self):
        """Verify execute_atomic_trade succeeds in MOCK mode with zero errors and valid local timestamp."""
        plan = {
            "buy_dex": "Uniswap_V2",
            "sell_dex": "SushiSwap_V2",
            "amount_in": 10.0,
            "gross_return_usdt": 10.50,
            "net_profit_usdt": 0.35,
            "gross_profit_usdt": 0.50,
            "gas_cost_usdt": 0.15,
        }
        res = execute_atomic_trade(plan)
        self.assertTrue(res["success"], f"Execution failed: {res.get('message')}")
        self.assertEqual(res["status"], "MOCK_TRADE_EXECUTED")
        self.assertIn("trade", res)
        trade = res["trade"]
        self.assertEqual(trade["status"], "CONFIRMED")
        self.assertEqual(trade["mode"], "MOCK")
        self.assertIn("created_at", trade)

        # Verify timestamp matches today's date
        today_prefix = datetime.now().astimezone().strftime("%Y-%m-%d")
        self.assertTrue(trade["created_at"].startswith(today_prefix))

    def test_execution_log_sqlite_persistence_24_7(self):
        """Verify execution audit logs are saved to SQLite and survive retrieval."""
        event_data = {
            "timestamp": datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S"),
            "event_type": "SWAP_SIMULATED",
            "route": "Uniswap_V2->SushiSwap_V2",
            "amount_in": 50.0,
            "net_profit": 1.25,
            "status": "FILLED",
            "reason": "Optimal spread detected",
            "tx_hash": "0xmocktest123"
        }
        log_id = save_execution_log(event_data)
        self.assertGreater(log_id, 0)

        logs = get_recent_execution_logs(limit=10)
        self.assertTrue(len(logs) > 0)
        latest = logs[0]
        self.assertEqual(latest["event_type"], "SWAP_SIMULATED")
        self.assertEqual(latest["status"], "FILLED")
        self.assertAlmostEqual(latest["amount_in"], 50.0)
        self.assertAlmostEqual(latest["net_profit"], 1.25)
        self.assertEqual(latest["tx_hash"], "0xmocktest123")

    def test_record_execution_event_integration(self):
        """Verify record_execution_event persists events to database and in-memory list."""
        record_execution_event(
            event_type="AUTO_ARBITRAGE_TEST",
            route="Uniswap_V2->SushiSwap_V2",
            amount_in=25.0,
            net_profit=0.45,
            status="FILLED",
            reason="Automated trigger verified",
            tx_hash="0xautotest"
        )
        logs = get_recent_execution_logs(limit=5)
        self.assertTrue(any(l["event_type"] == "AUTO_ARBITRAGE_TEST" for l in logs))

    def test_trade_database_mode_filtering(self):
        """Verify get_all_trades properly handles LIVE, SIMULATION, and ALL filters."""
        # 1. Save a MOCK trade
        save_trade({
            "tx_hash": "0xmock001",
            "chain_id": 8453,
            "buy_dex": "Uniswap_V2",
            "sell_dex": "SushiSwap_V2",
            "token_pair": "WETH/USDC",
            "amount_in": 10.0,
            "amount_out": 10.20,
            "net_profit": 0.20,
            "mode": "MOCK",
            "status": "CONFIRMED"
        })

        # 2. Save a TESTNET trade
        save_trade({
            "tx_hash": "0xtestnet002",
            "chain_id": 11155111,
            "buy_dex": "Uniswap_V2",
            "sell_dex": "SushiSwap_V2",
            "token_pair": "WETH/USDT",
            "amount_in": 20.0,
            "amount_out": 20.50,
            "net_profit": 0.50,
            "mode": "TESTNET",
            "status": "CONFIRMED"
        })

        # 3. Save a LIVE trade
        save_trade({
            "tx_hash": "0xlive003",
            "chain_id": 8453,
            "buy_dex": "Uniswap_V2",
            "sell_dex": "SushiSwap_V2",
            "token_pair": "WETH/USDC",
            "amount_in": 100.0,
            "amount_out": 102.50,
            "net_profit": 2.50,
            "mode": "LIVE",
            "status": "CONFIRMED"
        })

        # Filter: ALL
        all_trades = get_all_trades(mode="ALL")
        self.assertEqual(len(all_trades), 3)

        # Filter: SIMULATION (should match MOCK)
        sim_trades = get_all_trades(mode="SIMULATION")
        self.assertEqual(len(sim_trades), 1)
        self.assertEqual(sim_trades[0]["tx_hash"], "0xmock001")

        # Filter: LIVE (should match both LIVE and TESTNET)
        live_trades = get_all_trades(mode="LIVE")
        self.assertEqual(len(live_trades), 2)
        tx_hashes = [t["tx_hash"] for t in live_trades]
        self.assertIn("0xtestnet002", tx_hashes)
        self.assertIn("0xlive003", tx_hashes)

    def test_api_trade_execution_endpoint(self):
        """Verify POST /api/trade executes cleanly without error and returns trade data."""
        res = self.client.post("/api/trade", json={
            "trade_amount": 5.0,
            "wallet_address": "0x9cb6b2c1205a16ba947b783ed99569234decfcc0"
        })
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertTrue(data.get("success"))
        self.assertIn("trade", data)
        self.assertEqual(data["trade"]["status"], "CONFIRMED")


if __name__ == "__main__":
    unittest.main()
