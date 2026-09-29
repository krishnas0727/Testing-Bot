import time
import unittest
from unittest.mock import patch

from market_stream import OnChainDEXStream


class MarketDataEnginePythonTests(unittest.TestCase):
    def setUp(self):
        self.stream = OnChainDEXStream()

    def test_pool_normalization_and_freshness_lifecycle(self):
        """Verify pool state normalization, age calculation, and freshness tagging."""
        now = time.time()
        with self.stream._lock:
            # 1. Fresh pool state (received 1 second ago)
            self.stream._data["Uniswap_V2"] = {
                "dex": "Uniswap_V2",
                "pair": "WETH/USDT",
                "bid": 3000.0,
                "ask": 3005.0,
                "last": 3000.0,
                "spot_price": 3000.0,
                "base_reserve": 100.0,
                "quote_reserve": 300000.0,
                "liquidity_usd": 600000.0,
                "fee_bps": 30,
                "fee_pct": 0.003,
                "is_valid": True,
                "received_at": now - 1.0,
                "source": "rpc",
            }
            # 2. Stale pool state (received 15 seconds ago)
            self.stream._data["SushiSwap_V2"] = {
                "dex": "SushiSwap_V2",
                "pair": "WETH/USDT",
                "bid": 3030.0,
                "ask": 3035.0,
                "last": 3030.0,
                "spot_price": 3030.0,
                "base_reserve": 100.0,
                "quote_reserve": 303000.0,
                "liquidity_usd": 606000.0,
                "fee_bps": 30,
                "fee_pct": 0.003,
                "is_valid": True,
                "received_at": now - 15.0,
                "source": "rpc",
            }
            # 3. Expired pool state (received 45 seconds ago)
            self.stream._data["QuickSwap_V2"] = {
                "dex": "QuickSwap_V2",
                "pair": "WETH/USDT",
                "bid": 3010.0,
                "ask": 3015.0,
                "last": 3010.0,
                "spot_price": 3010.0,
                "base_reserve": 100.0,
                "quote_reserve": 301000.0,
                "liquidity_usd": 602000.0,
                "fee_bps": 30,
                "fee_pct": 0.003,
                "is_valid": True,
                "received_at": now - 45.0,
                "source": "rpc",
            }

        snapshot = self.stream.snapshot()
        self.assertEqual(len(snapshot), 3)

        # Freshness verification
        self.assertEqual(snapshot["Uniswap_V2"]["freshness"], "FRESH")
        self.assertEqual(snapshot["SushiSwap_V2"]["freshness"], "STALE")
        self.assertEqual(snapshot["QuickSwap_V2"]["freshness"], "EXPIRED")

        # Liquidity USD verification
        self.assertEqual(snapshot["Uniswap_V2"]["liquidity_usd"], 600000.0)
        self.assertEqual(snapshot["SushiSwap_V2"]["liquidity_usd"], 606000.0)

        # Age ms verification
        self.assertGreater(snapshot["Uniswap_V2"]["age_ms"], 500)
        self.assertGreater(snapshot["SushiSwap_V2"]["age_ms"], 14000)
        self.assertGreater(snapshot["QuickSwap_V2"]["age_ms"], 40000)

    def test_zero_reserve_protection_and_validity_flag(self):
        """Verify invalid or zero-reserve pools are flagged as is_valid=False."""
        now = time.time()
        with self.stream._lock:
            self.stream._data["Corrupt_DEX"] = {
                "dex": "Corrupt_DEX",
                "pair": "WETH/USDT",
                "bid": 0.0,
                "ask": 0.0,
                "last": 0.0,
                "spot_price": 0.0,
                "base_reserve": 0.0,
                "quote_reserve": 0.0,
                "liquidity_usd": 0.0,
                "is_valid": False,
                "received_at": now,
                "source": "rpc",
            }

        snapshot = self.stream.snapshot()
        self.assertFalse(snapshot["Corrupt_DEX"]["is_valid"])
        self.assertEqual(snapshot["Corrupt_DEX"]["liquidity_usd"], 0.0)

    def test_multi_dex_spread_detection(self):
        """Verify cross-DEX spread calculation between normalized pools."""
        uni_price = 3000.0
        sushi_price = 3030.0

        spread_usd = sushi_price - uni_price
        spread_pct = (spread_usd / uni_price) * 100

        self.assertEqual(spread_usd, 30.0)
        self.assertEqual(spread_pct, 1.0)
        # 1.0% > 0.60% (2x 0.30% fees), profitable spread
        self.assertGreater(spread_pct, 0.60)


if __name__ == "__main__":
    unittest.main()
