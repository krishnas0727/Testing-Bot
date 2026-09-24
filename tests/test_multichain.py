"""Multi-chain independent verification test suite.

Tests dynamic multi-chain configuration, chain switching, address isolation,
unsupported-chain rejection, and dynamic API endpoints for:
- Base L2 Mainnet (8453)
- Base Sepolia Testnet (84532)
- Sepolia Testnet (11155111)
- Arbitrum One (42161)
- Polygon PoS (137)
- Ethereum Mainnet (1)
"""
import unittest
import json
from unittest.mock import patch

import config
import dex_engine
from app import app


class MultiChainVerificationTests(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()
        # Always start from Base L2
        config.set_active_chain(8453)

    def tearDown(self):
        # Reset back to Base L2
        config.set_active_chain(8453)

    def test_base_mainnet_configuration(self):
        """Verify Base Mainnet (8453) configuration and address isolation."""
        chain_info = config.set_active_chain(8453)
        self.assertEqual(config.CHAIN_ID, 8453)
        self.assertEqual(config.DEFAULT_CHAIN, "base")
        self.assertEqual(config.SYMBOL, "WETH/USDC")
        self.assertEqual(chain_info["currency"], "ETH")
        self.assertIn("https://mainnet.base.org", chain_info["fallbacks"])

        # Token address isolation
        tokens = config.TOKEN_REGISTRY
        self.assertEqual(tokens["USDC"]["address"].lower(), "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913".lower())
        self.assertEqual(tokens["USDC"]["decimals"], 6)
        self.assertEqual(tokens["WETH"]["address"].lower(), "0x4200000000000000000000000000000000000006".lower())

        # Router isolation
        self.assertIn("Uniswap_V2", config.DEX_ROUTERS)
        self.assertIn("SushiSwap_V2", config.DEX_ROUTERS)
        self.assertEqual(config.DEX_ROUTERS["Uniswap_V2"].lower(), "0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24".lower())

        # Gas estimation
        gas_wei = dex_engine._default_gas_wei()
        self.assertEqual(gas_wei, 6_000_000)

    def test_base_sepolia_configuration(self):
        """Verify Base Sepolia (84532) configuration and address isolation."""
        chain_info = config.set_active_chain(84532)
        self.assertEqual(config.CHAIN_ID, 84532)
        self.assertEqual(config.DEFAULT_CHAIN, "base_sepolia")
        self.assertEqual(config.SYMBOL, "WETH/USDC")
        self.assertEqual(chain_info["currency"], "ETH")
        self.assertEqual(chain_info["explorer"], "https://sepolia.basescan.org")
        self.assertIn("https://sepolia.base.org", chain_info["fallbacks"])

        # Token address isolation - must NOT use Base mainnet USDC
        tokens = config.TOKEN_REGISTRY
        self.assertEqual(tokens["USDC"]["address"].lower(), "0x036cbd53842c5426634e7929541ec2318f3dcf7e".lower())
        self.assertEqual(tokens["USDC"]["decimals"], 6)
        self.assertEqual(tokens["WETH"]["address"].lower(), "0x4200000000000000000000000000000000000006".lower())

        # Router isolation - must use Base Sepolia V2 router
        self.assertIn("Uniswap_V2", config.DEX_ROUTERS)
        self.assertEqual(config.DEX_ROUTERS["Uniswap_V2"].lower(), "0x1662c4ca803b6d5d42c85d552318b7625038923d".lower())

        # Gas estimation
        gas_wei = dex_engine._default_gas_wei()
        self.assertEqual(gas_wei, 6_000_000)

    def test_sepolia_testnet_configuration(self):
        """Verify Sepolia (11155111) configuration and address isolation."""
        chain_info = config.set_active_chain(11155111)
        self.assertEqual(config.CHAIN_ID, 11155111)
        self.assertEqual(config.DEFAULT_CHAIN, "sepolia")
        self.assertEqual(config.SYMBOL, "WETH/USDT")
        self.assertEqual(chain_info["currency"], "SepoliaETH")
        self.assertEqual(chain_info["explorer"], "https://sepolia.etherscan.io")

        # Token address isolation - must use Sepolia canonical test tokens
        tokens = config.TOKEN_REGISTRY
        self.assertEqual(tokens["WETH"]["address"].lower(), "0x7b79995e5f793a07bc00c21412e50ecae098e7f9".lower())
        self.assertEqual(tokens["USDT"]["address"].lower(), "0xd077a400968890eacc75cdc901f0356c943e4fdb".lower())
        self.assertEqual(tokens["USDC"]["address"].lower(), "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238".lower())

        # Router isolation - must use Sepolia Uniswap V2 Router
        self.assertEqual(config.DEX_ROUTERS["Uniswap_V2"].lower(), "0xc532a74256d3db42d0bf7a0400fefdbad7694008".lower())

        # Gas estimation on Sepolia
        gas_wei = dex_engine._default_gas_wei()
        self.assertEqual(gas_wei, 2_000_000_000)

    def test_unsupported_chain_handling(self):
        """Verify that unsupported chain IDs are explicitly rejected without fallback."""
        with self.assertRaises(ValueError) as ctx:
            config.set_active_chain(999999)
        self.assertIn("Unsupported chain ID: 999999", str(ctx.exception))

        with self.assertRaises(ValueError):
            config.set_active_chain(0)

    def test_api_chains_list(self):
        """Verify /api/chains lists Base, Base Sepolia, Sepolia, Arbitrum, Polygon, Ethereum."""
        res = self.client.get("/api/chains")
        self.assertEqual(res.status_code, 200)
        data = json.loads(res.data)
        self.assertTrue(data["success"])
        chains = data["chains"]
        chain_ids = [int(k) for k in chains.keys()]
        self.assertIn(8453, chain_ids)
        self.assertIn(84532, chain_ids)
        self.assertIn(11155111, chain_ids)
        self.assertIn(42161, chain_ids)
        self.assertIn(137, chain_ids)
        self.assertIn(1, chain_ids)

    def test_api_chain_switch_success(self):
        """Verify /api/chain/switch switches configuration dynamically."""
        # Switch to Base Sepolia
        res = self.client.post("/api/chain/switch", json={"chain_id": 84532})
        self.assertEqual(res.status_code, 200)
        data = json.loads(res.data)
        self.assertTrue(data["success"])
        self.assertEqual(data["chain_id"], 84532)
        self.assertEqual(config.CHAIN_ID, 84532)
        self.assertEqual(config.DEFAULT_CHAIN, "base_sepolia")

        # Switch to Sepolia
        res = self.client.post("/api/chain/switch", json={"chain_id": 11155111})
        self.assertEqual(res.status_code, 200)
        data = json.loads(res.data)
        self.assertTrue(data["success"])
        self.assertEqual(data["chain_id"], 11155111)
        self.assertEqual(config.CHAIN_ID, 11155111)
        self.assertEqual(config.DEFAULT_CHAIN, "sepolia")

    def test_api_chain_switch_unsupported_returns_400(self):
        """Verify /api/chain/switch returns HTTP 400 for unsupported chains."""
        res = self.client.post("/api/chain/switch", json={"chain_id": 999999})
        self.assertEqual(res.status_code, 400)
        data = json.loads(res.data)
        self.assertFalse(data["success"])
        self.assertIn("Unsupported chain ID: 999999", data["message"])
        # Bot chain must remain unchanged
        self.assertEqual(config.CHAIN_ID, 8453)

    def test_api_wallet_connect_auto_switches_chain(self):
        """Verify connecting wallet with a supported chain_id automatically aligns config."""
        res = self.client.post("/api/wallet/connect", json={
            "address": "0x1bcea3bc88cd89f3a5de9c07a5c7b6f2b4f501b4",
            "chain_id": 84532
        })
        self.assertEqual(res.status_code, 200)
        data = json.loads(res.data)
        self.assertTrue(data["success"])
        self.assertEqual(config.CHAIN_ID, 84532)
        self.assertEqual(config.WALLET_ADDRESS, "0x1bcea3bc88cd89f3a5de9c07a5c7b6f2b4f501b4")

    def test_api_market_all_pairs_chain_context(self):
        """Verify /api/market/all-pairs respects chain_id parameter and isolates pairs."""
        # 1. Test Polygon (137)
        res_poly = self.client.get("/api/market/all-pairs?chain_id=137")
        self.assertEqual(res_poly.status_code, 200)
        data_poly = json.loads(res_poly.data)
        self.assertTrue(data_poly["success"])
        self.assertEqual(data_poly["chain_id"], 137)
        self.assertEqual(data_poly["chain_name"], "polygon")
        self.assertEqual(data_poly["chain_label"], "Polygon (PoS)")
        poly_pairs = [p["pair"] for p in data_poly["pairs"]]
        self.assertIn("WETH/USDT", poly_pairs)
        self.assertIn("WETH/USDC", poly_pairs)
        for p in data_poly["pairs"]:
            self.assertEqual(p["chain_id"], 137)
            self.assertEqual(p["chain_name"], "polygon")

        # 2. Test Base (8453)
        res_base = self.client.get("/api/market/all-pairs?chain_id=8453")
        self.assertEqual(res_base.status_code, 200)
        data_base = json.loads(res_base.data)
        self.assertTrue(data_base["success"])
        self.assertEqual(data_base["chain_id"], 8453)
        self.assertEqual(data_base["chain_name"], "base")
        self.assertEqual(data_base["chain_label"], "Base L2 Mainnet")
        base_pairs = [p["pair"] for p in data_base["pairs"]]
        self.assertIn("WETH/USDC", base_pairs)
        self.assertIn("WETH/USDT", base_pairs)
        self.assertIn("WETH/DAI", base_pairs)
        for p in data_base["pairs"]:
            self.assertEqual(p["chain_id"], 8453)
            self.assertEqual(p["chain_name"], "base")

        # 3. Test Arbitrum (42161)
        res_arb = self.client.get("/api/market/all-pairs?chain_id=42161")
        self.assertEqual(res_arb.status_code, 200)
        data_arb = json.loads(res_arb.data)
        self.assertTrue(data_arb["success"])
        self.assertEqual(data_arb["chain_id"], 42161)
        self.assertEqual(data_arb["chain_name"], "arbitrum")
        self.assertEqual(data_arb["chain_label"], "Arbitrum One")

    def test_api_prices_chain_context(self):
        """Verify /api/prices returns prices tagged with the requested chain_id."""
        res = self.client.get("/api/prices?chain_id=137")
        self.assertEqual(res.status_code, 200)
        data = json.loads(res.data)
        self.assertTrue(data["success"])
        self.assertEqual(data["chain_id"], 137)
        self.assertEqual(data["chain_name"], "polygon")
        self.assertEqual(data["chain_label"], "Polygon (PoS)")

    def test_arbitrage_market_analysis_chain_tagging(self):
        """Verify arbitrage.analyze_market tags opportunities with chain context."""
        import arbitrage
        analysis_poly = arbitrage.analyze_market(chain_id=137)
        self.assertEqual(analysis_poly["chain_id"], 137)
        self.assertEqual(analysis_poly["chain_name"], "polygon")
        self.assertEqual(analysis_poly["chain_label"], "Polygon (PoS)")
        if analysis_poly.get("opportunities"):
            for opp in analysis_poly["opportunities"]:
                self.assertEqual(opp["chain_id"], 137)
                self.assertEqual(opp["chain_name"], "polygon")


if __name__ == "__main__":
    unittest.main()

