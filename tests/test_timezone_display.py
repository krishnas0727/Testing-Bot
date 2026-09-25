import unittest
from datetime import datetime, timezone, timedelta
import config
from app import app
from database import (
    create_database,
    save_trade,
    get_all_trades,
    delete_all_trades,
    save_execution_log,
    get_recent_execution_logs,
)


class TimezoneDisplayTests(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()
        delete_all_trades()

    def tearDown(self):
        delete_all_trades()

    def test_stored_onchain_timestamp_remains_unchanged(self):
        """Verify on-chain/stored timestamps remain unchanged in database."""
        raw_utc_ts = "2026-09-25 04:27:04"
        trade_id = save_trade({
            "tx_hash": "0xutctest001",
            "chain_id": 8453,
            "buy_dex": "Uniswap_V2",
            "sell_dex": "SushiSwap_V2",
            "token_pair": "WETH/USDC",
            "amount_in": 10.0,
            "amount_out": 10.20,
            "net_profit": 0.20,
            "mode": "MOCK",
            "status": "CONFIRMED",
            "created_at": raw_utc_ts,
        })
        self.assertGreater(trade_id, 0)

        trades = get_all_trades(mode="ALL")
        self.assertEqual(len(trades), 1)
        # Stored timestamp in database must remain exactly unchanged
        self.assertEqual(trades[0]["created_at"], raw_utc_ts)

    def test_utc_to_ist_mathematical_conversion(self):
        """Verify UTC timestamp converts to IST (UTC+5:30) with exact accuracy."""
        # Example from user scenario: 04:27:04 UTC -> 09:57:04 IST (+5h 30m)
        utc_dt = datetime(2026, 9, 25, 4, 27, 4, tzinfo=timezone.utc)
        ist_tz = timezone(timedelta(hours=5, minutes=30), name="IST")
        ist_dt = utc_dt.astimezone(ist_tz)

        self.assertEqual(ist_dt.strftime("%Y-%m-%d %H:%M:%S"), "2026-09-25 09:57:04")
        self.assertEqual(ist_dt.tzname(), "IST")

        # Example 2: 02:56:10 UTC -> 08:26:10 IST
        utc_dt2 = datetime(2026, 9, 25, 2, 56, 10, tzinfo=timezone.utc)
        ist_dt2 = utc_dt2.astimezone(ist_tz)
        self.assertEqual(ist_dt2.strftime("%Y-%m-%d %H:%M:%S"), "2026-09-25 08:26:10")

    def test_execution_log_preserves_original_timestamp(self):
        """Verify execution logs store original timestamp without modification."""
        raw_log_ts = "2026-09-25 02:56:10"
        event = {
            "timestamp": raw_log_ts,
            "event_type": "TRADE_FILLED",
            "route": "Uniswap_V2->SushiSwap_V2",
            "amount_in": 100.0,
            "net_profit": 8.7913,
            "status": "FILLED",
            "reason": "Optimal spread",
            "tx_hash": "0xisttest123"
        }
        log_id = save_execution_log(event)
        self.assertGreater(log_id, 0)

        logs = get_recent_execution_logs(limit=5)
        self.assertTrue(len(logs) > 0)
        # Original timestamp is strictly preserved in stored data
        self.assertEqual(logs[0]["timestamp"], raw_log_ts)

    def test_api_trades_returns_stored_data_for_ui(self):
        """Verify /api/trades returns unmodified stored timestamps for client-side local timezone rendering."""
        save_trade({
            "tx_hash": "0xtestapi001",
            "chain_id": 8453,
            "buy_dex": "Uniswap_V2",
            "sell_dex": "SushiSwap_V2",
            "token_pair": "WETH/USDT",
            "amount_in": 5.0,
            "amount_out": 5.15,
            "net_profit": 0.15,
            "mode": "MOCK",
            "status": "CONFIRMED",
            "created_at": "2026-09-25 03:00:00",
        })
        res = self.client.get("/api/trades?mode=ALL")
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertTrue(data.get("success"))
        self.assertEqual(len(data["trades"]), 1)
        self.assertEqual(data["trades"][0]["created_at"], "2026-09-25 03:00:00")


if __name__ == "__main__":
    unittest.main()
