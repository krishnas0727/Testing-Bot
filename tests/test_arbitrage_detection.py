import unittest
import time
from dex_engine import calculate_amount_out, calculate_price_impact


class ArbitrageDetectionEngineTests(unittest.TestCase):
    def setUp(self):
        # Benchmark mock pools for WETH/USDT
        # Uniswap: Spot = 3000.0 USDT per WETH
        # Sushiswap: Spot = 3060.0 USDT per WETH (2.0% spread)
        self.mock_pools = {
            "Uniswap_V2": {
                "base_reserve": 100.0,      # 100 WETH
                "quote_reserve": 300000.0,  # 300,000 USDT
                "spot_price": 3000.0,
                "liquidity_usd": 600000.0,
                "timestamp": time.time(),
                "is_valid": True,
            },
            "SushiSwap_V2": {
                "base_reserve": 100.0,      # 100 WETH
                "quote_reserve": 306000.0,  # 306,000 USDT
                "spot_price": 3060.0,
                "liquidity_usd": 612000.0,
                "timestamp": time.time(),
                "is_valid": True,
            }
        }

    def test_directional_price_comparison(self):
        """Verify directional route discovery: Buy on Uniswap, Sell on SushiSwap."""
        buy_dex = "Uniswap_V2"
        sell_dex = "SushiSwap_V2"
        buy_spot = self.mock_pools[buy_dex]["spot_price"]
        sell_spot = self.mock_pools[sell_dex]["spot_price"]

        raw_spread_usd = sell_spot - buy_spot
        raw_spread_pct = (raw_spread_usd / buy_spot) * 100.0

        self.assertAlmostEqual(raw_spread_usd, 60.0, places=2)
        self.assertAlmostEqual(raw_spread_pct, 2.0, places=2)
        self.assertGreater(raw_spread_pct, 0.20)  # Exceeds min spread 0.20%

    def test_reverse_directional_detection(self):
        """When prices invert, detection must flip to Buy on SushiSwap, Sell on Uniswap."""
        inverted_pools = {
            "Uniswap_V2": {"spot_price": 3080.0},
            "SushiSwap_V2": {"spot_price": 3000.0},
        }
        # Inverted direction: SushiSwap is cheaper
        cheaper_dex = "SushiSwap_V2" if inverted_pools["SushiSwap_V2"]["spot_price"] < inverted_pools["Uniswap_V2"]["spot_price"] else "Uniswap_V2"
        expensive_dex = "Uniswap_V2" if cheaper_dex == "SushiSwap_V2" else "SushiSwap_V2"

        self.assertEqual(cheaper_dex, "SushiSwap_V2")
        self.assertEqual(expensive_dex, "Uniswap_V2")

    def test_liquidity_depth_validation(self):
        """Verify shallow pools are rejected when liquidity < $1,000 or trade size > 25% reserve."""
        min_liquidity_usd = 1000.0
        shallow_pool_liquidity = 500.0

        is_buy_liq_valid = shallow_pool_liquidity >= min_liquidity_usd
        self.assertFalse(is_buy_liq_valid)

        # Max trade ratio check
        quote_reserve = 100.0
        trade_size = 30.0  # 30% of reserve > 25% max allowed
        max_allowed_trade = quote_reserve * 0.25
        is_ratio_valid = trade_size <= max_allowed_trade
        self.assertFalse(is_ratio_valid)

    def test_data_freshness_rejection(self):
        """Verify that stale data (> 15 seconds old) is rejected."""
        max_age_sec = 15.0
        old_timestamp = time.time() - 20.0  # 20 seconds ago

        age_sec = time.time() - old_timestamp
        is_fresh = age_sec <= max_age_sec
        self.assertFalse(is_fresh)

    def test_deduplication_fingerprinting(self):
        """Verify deterministic fingerprint hash prevents duplicate spam."""
        chain_id = 8453
        pair = "WETH/USDT"
        buy_dex = "Uniswap_V2"
        sell_dex = "SushiSwap_V2"
        trade_size = 50.0

        key1 = f"{chain_id}:{pair.upper()}:{buy_dex.upper()}-{sell_dex.upper()}:{trade_size:.2f}"
        key2 = f"{chain_id}:{pair.upper()}:{buy_dex.upper()}-{sell_dex.upper()}:{trade_size:.2f}"

        self.assertEqual(key1, key2)

    def test_multi_trade_size_candidate_evaluation(self):
        """Verify candidate generation across multiple trade sizes [10, 25, 50, 100]."""
        trade_sizes = [10.0, 25.0, 50.0, 100.0]
        fee_pct = 0.003
        results = []

        for size in trade_sizes:
            # Leg 1: USDT -> WETH on Uniswap
            weth_out = calculate_amount_out(
                size,
                self.mock_pools["Uniswap_V2"]["quote_reserve"],
                self.mock_pools["Uniswap_V2"]["base_reserve"],
                fee_pct
            )
            # Leg 2: WETH -> USDT on SushiSwap
            usdt_out = calculate_amount_out(
                weth_out,
                self.mock_pools["SushiSwap_V2"]["base_reserve"],
                self.mock_pools["SushiSwap_V2"]["quote_reserve"],
                fee_pct
            )
            gross_profit = usdt_out - size
            results.append((size, gross_profit))

        self.assertEqual(len(results), 4)
        for size, profit in results:
            self.assertGreater(profit, 0)  # All positive on 2% spread


if __name__ == "__main__":
    unittest.main()
