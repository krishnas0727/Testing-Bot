import json
import unittest
from app import app
import database

class TestBackupRestore(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()
        database.create_database()

    def test_export_and_restore_full_backup(self):
        # 1. Export database backup
        backup_data = database.export_full_database_backup()
        self.assertIn("trades", backup_data)
        self.assertIn("settings", backup_data)
        self.assertIn("exported_at", backup_data)
        self.assertIn("version", backup_data)

        # 2. Test restore with a sample trade
        import time
        unique_tx = f"0xtest_backup_hash_{time.time()}"
        test_trade = {
            "tx_hash": unique_tx,
            "chain_id": 8453,
            "buy_dex": "Uniswap_V2",
            "sell_dex": "SushiSwap_V2",
            "token_pair": "WETH/USDT",
            "amount_in": 1.0,
            "amount_out": 1.05,
            "gross_profit": 0.05,
            "net_profit": 0.04,
            "mode": "TESTNET",
            "status": "CONFIRMED"
        }
        res = database.restore_full_database_backup({
            "trades": [test_trade],
            "settings": {"test_backup_key": "active"}
        })
        self.assertTrue(res["success"])
        self.assertGreaterEqual(res["restored_trades"], 1)

        # 3. Test API endpoint /api/backup/download
        resp = self.client.get("/api/backup/download")
        self.assertEqual(resp.status_code, 200)
        self.assertIn("attachment; filename=", resp.headers.get("Content-Disposition", ""))
        downloaded_json = json.loads(resp.data)
        self.assertIn("trades", downloaded_json)

        # 4. Test API endpoint /api/backup/restore
        restore_resp = self.client.post("/api/backup/restore", json={
            "trades": [test_trade],
            "settings": {"auto_trade": True}
        })
        self.assertEqual(restore_resp.status_code, 200)
        restore_json = restore_resp.get_json()
        self.assertTrue(restore_json["success"])

if __name__ == "__main__":
    unittest.main()
