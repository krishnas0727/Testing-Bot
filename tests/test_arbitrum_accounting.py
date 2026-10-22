"""Tests for Arbitrum One (Chain ID 42161) targeted fixes, decimal arithmetic,
gas accounting with L1 calldata fee, and receipt-based P&L verification.
"""
import unittest
from decimal import Decimal
from unittest.mock import MagicMock, patch

import config
import dex_engine
import arbitrage
import live_executor


class TestArbitrumNetworkConfiguration(unittest.TestCase):
    def setUp(self):
        self.orig_chain_id = config.CHAIN_ID
        self.orig_mode = config.TRADING_MODE
        self.orig_armed = config.LIVE_TRADING_ARMED

    def tearDown(self):
        config.set_active_chain(self.orig_chain_id)
        config.TRADING_MODE = self.orig_mode
        config.LIVE_TRADING_ARMED = self.orig_armed

    def test_arbitrum_one_default_configuration(self):
        """Verify Arbitrum One (42161) default configuration and verified token registry."""
        chain_info = config.set_active_chain(42161)
        self.assertEqual(config.CHAIN_ID, 42161)
        self.assertEqual(config.DEFAULT_CHAIN, "arbitrum")
        self.assertEqual(chain_info["currency"], "ETH")
        self.assertEqual(chain_info["explorer"], "https://arbiscan.io")
        self.assertIn("https://arb1.arbitrum.io/rpc", chain_info["fallbacks"])

        # Verified Arbitrum One tokens
        tokens = config.TOKEN_REGISTRY
        self.assertEqual(tokens["WETH"]["address"].lower(), "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1".lower())
        self.assertEqual(tokens["WETH"]["decimals"], 18)
        self.assertEqual(tokens["USDT"]["address"].lower(), "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9".lower())
        self.assertEqual(tokens["USDT"]["decimals"], 6)
        self.assertEqual(tokens["USDC"]["address"].lower(), "0xaf88d065e77c8cC2239327C5EDb3A432268e5831".lower())
        self.assertEqual(tokens["USDC"]["decimals"], 6)
        self.assertEqual(tokens["USDC.e"]["address"].lower(), "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8".lower())
        self.assertEqual(tokens["USDC.e"]["decimals"], 6)
        self.assertEqual(tokens["DAI"]["address"].lower(), "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1".lower())
        self.assertEqual(tokens["DAI"]["decimals"], 18)
        self.assertEqual(tokens["WBTC"]["address"].lower(), "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f".lower())
        self.assertEqual(tokens["WBTC"]["decimals"], 8)
        self.assertEqual(tokens["ARB"]["address"].lower(), "0x912CE59144191C1204E64559FE8253a0e49E6548".lower())
        self.assertEqual(tokens["ARB"]["decimals"], 18)

        # Verified Arbitrum One routers
        routers = config.DEX_ROUTERS
        self.assertEqual(routers["Uniswap_V2"].lower(), "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24".lower())
        self.assertEqual(routers["SushiSwap_V2"].lower(), "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506".lower())

    def test_live_executor_network_mismatch_rejection(self):
        """Verify execute_live fails safely when RPC chain ID differs from trade/configured chain."""
        config.set_active_chain(42161)
        config.TRADING_MODE = "LIVE"
        config.LIVE_TRADING_ARMED = True
        config.EMERGENCY_STOP = False

        mock_w3 = MagicMock()
        mock_w3.eth.chain_id = 8453  # RPC is on Base (8453), but plan is for Arbitrum (42161)

        plan = {
            "chain_id": 42161,
            "buy_dex": "Uniswap_V2",
            "sell_dex": "SushiSwap_V2",
            "amount_in": 5.0,
            "token_pair": "WETH/USDT",
        }

        with patch("live_executor.get_w3", return_value=mock_w3), \
             patch("live_executor._cfg", side_effect=lambda k, d: "0x" + "1" * 64 if k == "PRIVATE_KEY" else ("0x" + "2" * 40 if k == "ARBITRAGE_CONTRACT_ADDRESS" else d)):
            res = live_executor.execute_live(plan)
            self.assertFalse(res["success"])
            self.assertEqual(res["status"], "NETWORK_MISMATCH")
            self.assertIn("does not match", res["message"])

    def test_live_executor_wallet_mismatch_rejection(self):
        """Verify execute_live fails safely when configured WALLET_ADDRESS differs from signer."""
        config.set_active_chain(42161)
        config.TRADING_MODE = "LIVE"
        config.LIVE_TRADING_ARMED = True
        config.EMERGENCY_STOP = False

        mock_w3 = MagicMock()
        mock_w3.eth.chain_id = 42161

        plan = {
            "chain_id": 42161,
            "buy_dex": "Uniswap_V2",
            "sell_dex": "SushiSwap_V2",
            "amount_in": 5.0,
            "token_pair": "WETH/USDT",
        }

        with patch("live_executor.get_w3", return_value=mock_w3), \
             patch("live_executor._cfg", side_effect=lambda k, d: "0x" + "1" * 64 if k == "PRIVATE_KEY" else ("0x" + "2" * 40 if k == "ARBITRAGE_CONTRACT_ADDRESS" else ("0x" + "9" * 40 if k == "WALLET_ADDRESS" else d))):
            res = live_executor.execute_live(plan)
            self.assertFalse(res["success"])
            self.assertEqual(res["status"], "WALLET_MISMATCH")
            self.assertIn("WALLET_ADDRESS", res["message"])

    def test_live_executor_empty_arbitrage_contract_address_blocks_execution(self):
        """Verify execute_live blocks execution when ARBITRAGE_CONTRACT_ADDRESS is empty."""
        config.set_active_chain(42161)
        config.TRADING_MODE = "LIVE"
        config.LIVE_TRADING_ARMED = True
        config.EMERGENCY_STOP = False

        plan = {
            "chain_id": 42161,
            "buy_dex": "Uniswap_V2",
            "sell_dex": "SushiSwap_V2",
            "amount_in": 5.0,
            "token_pair": "WETH/USDT",
        }

        with patch("live_executor._cfg", side_effect=lambda k, d: "0x" + "1" * 64 if k == "PRIVATE_KEY" else ("" if k == "ARBITRAGE_CONTRACT_ADDRESS" else d)):
            res = live_executor.execute_live(plan)
            self.assertFalse(res["success"])
            self.assertEqual(res["status"], "REQUIRES_DEPLOYED_CONTRACT")
            self.assertIn("ARBITRAGE_CONTRACT_ADDRESS", res["message"])

    def test_live_executor_empty_private_key_blocks_execution(self):
        """Verify execute_live blocks execution when PRIVATE_KEY is empty."""
        config.set_active_chain(42161)
        config.TRADING_MODE = "LIVE"
        config.LIVE_TRADING_ARMED = True
        config.EMERGENCY_STOP = False

        plan = {
            "chain_id": 42161,
            "buy_dex": "Uniswap_V2",
            "sell_dex": "SushiSwap_V2",
            "amount_in": 5.0,
            "token_pair": "WETH/USDT",
        }

        with patch("live_executor._cfg", side_effect=lambda k, d: "" if k == "PRIVATE_KEY" else d):
            res = live_executor.execute_live(plan)
            self.assertFalse(res["success"])
            self.assertEqual(res["status"], "LIVE_SIGNER_REQUIRED")
            self.assertIn("PRIVATE_KEY", res["message"])

    def test_real_market_spread_below_fee_threshold_blocks_profitability(self):
        """Verify that when real on-chain spread is below 0.60% DEX fees (as on Arbitrum), profitability gate rejects trade."""
        config.set_active_chain(42161)
        config.TRADING_MODE = "LIVE"

        # Realistic Arbitrum One reserves observed on-chain:
        # Uni: 5.938 WETH / 14427.18 USDT (spot = 2429.67)
        # Sushi: 7.327 WETH / 17790.59 USDT (spot = 2428.16)
        buy_q = {
            "chain_id": 42161,
            "spot_price": 2429.67,
            "base_reserve": 5.938,
            "quote_reserve": 14427.18,
        }
        sell_q = {
            "chain_id": 42161,
            "spot_price": 2428.16,
            "base_reserve": 7.327,
            "quote_reserve": 17790.59,
        }

        # $5 test trade
        result = arbitrage._calculate_net_profit(
            trade_amt=5.0,
            buy_q=buy_q,
            sell_q=sell_q,
            gas_price_gwei=0.02,
            eth_price_usdt=2429.0,
        )
        self.assertFalse(result["is_profitable"])
        self.assertLess(result["net_profit_usdt"], 0.0)
        self.assertIn("INSUFFICIENT_PROFIT", result["skip_reason"])


class TestTokenDecimalPrecision(unittest.TestCase):
    def test_to_raw_units_standard_decimals(self):
        """Test conversion to raw units for 6, 8, and 18 decimal tokens with exact precision."""
        # 6 decimals (USDC / USDT)
        self.assertEqual(dex_engine.to_raw_units(5.0, 6), 5_000_000)
        self.assertEqual(dex_engine.to_raw_units("5.123456", 6), 5_123_456)
        self.assertEqual(dex_engine.to_raw_units(0.000001, 6), 1)

        # 8 decimals (WBTC)
        self.assertEqual(dex_engine.to_raw_units(1.0, 8), 100_000_000)
        self.assertEqual(dex_engine.to_raw_units("0.00000001", 8), 1)

        # 18 decimals (WETH / DAI)
        self.assertEqual(dex_engine.to_raw_units(1.0, 18), 1_000_000_000_000_000_000)
        self.assertEqual(dex_engine.to_raw_units("0.5", 18), 500_000_000_000_000_000)

    def test_to_raw_units_rounding_down(self):
        """Test that sub-unit fractions are safely truncated (ROUND_DOWN) to prevent balance exhaustion."""
        # 6 decimals with 8 decimal fraction -> truncate to 6
        self.assertEqual(dex_engine.to_raw_units("5.12345678", 6), 5_123_456)
        # Empty/zero/negative amounts
        self.assertEqual(dex_engine.to_raw_units(0, 6), 0)
        self.assertEqual(dex_engine.to_raw_units(-10, 6), 0)
        self.assertEqual(dex_engine.to_raw_units(None, 6), 0)

    def test_from_raw_units_precision(self):
        """Test conversion from raw units to Decimal without float loss."""
        # 6 decimals
        d6 = dex_engine.from_raw_units(5_123_456, 6)
        self.assertEqual(d6, Decimal("5.123456"))

        # 18 decimals
        d18 = dex_engine.from_raw_units(1_000_000_000_000_000_000, 18)
        self.assertEqual(d18, Decimal("1"))

        # 8 decimals
        d8 = dex_engine.from_raw_units(12345678, 8)
        self.assertEqual(d8, Decimal("0.12345678"))


class TestFeeAndGasAccounting(unittest.TestCase):
    def setUp(self):
        config.set_active_chain(42161)

    def test_dex_swap_fee_not_double_counted(self):
        """Verify that DEX fees are already reflected in pool output and not subtracted twice."""
        # In dex_engine.calculate_amount_out: 0.3% fee is applied (multiplier = 0.997)
        # Input 1000 USDT into a pool with 1,000,000 USDT and 1,000,000 USDT
        out = dex_engine.calculate_amount_out(
            amount_in=1000.0,
            reserve_in=1_000_000.0,
            reserve_out=1_000_000.0,
            fee_pct=0.30
        )
        self.assertAlmostEqual(out, 996.00698, places=4)

        # In arbitrage._calculate_net_profit, gross profit = usdt_out - trade_amt
        # Verify net profit = gross profit - gas_cost (does NOT deduct dex_fees_usdt again)
        buy_q = {
            "chain_id": 42161,
            "spot_price": 3000.0,
            "base_reserve": 5000.0,
            "quote_reserve": 15_000_000.0,
        }
        sell_q = {
            "chain_id": 42161,
            "spot_price": 3060.0,  # 2% spread
            "base_reserve": 5000.0,
            "quote_reserve": 15_300_000.0,
        }

        res = arbitrage._calculate_net_profit(
            trade_amt=100.0,
            buy_q=buy_q,
            sell_q=sell_q,
            gas_price_gwei=0.02,
            eth_price_usdt=3000.0,
        )

        expected_net = res["gross_profit_usdt"] - res["gas_cost_usdt"]
        self.assertAlmostEqual(res["net_profit_usdt"], expected_net, places=5)
        # Verify fee is separately reported but not subtracted again from net profit
        self.assertGreater(res["dex_fees_usdt"], 0)
        self.assertNotEqual(res["net_profit_usdt"], res["gross_profit_usdt"] - res["gas_cost_usdt"] - res["dex_fees_usdt"])

    def test_arbitrum_gas_cost_includes_l1_rollup_fee(self):
        """Verify that estimate_arbitrage_gas_cost_usd on Arbitrum One (42161) includes L1 data cost."""
        gas_info_arb = dex_engine.estimate_arbitrage_gas_cost_usd(
            eth_price_usd=3000.0,
            gas_units=250000,
            gas_price_wei=10_000_000,  # 0.01 Gwei
            chain_id=42161,
            include_l1=True,
        )
        self.assertTrue(gas_info_arb["is_gas_acceptable"])
        # L2 execution gas: 250,000 * 10,000,000 / 1e18 = 0.0000025 ETH * 3000 = $0.0075
        self.assertAlmostEqual(gas_info_arb["l2_gas_cost_usd"], 0.0075, places=4)
        # L1 calldata fee should be positive on Arbitrum One
        self.assertGreater(gas_info_arb["l1_fee_usd"], 0.0)
        # Total cost = L2 + L1
        self.assertAlmostEqual(gas_info_arb["gas_cost_usd"], gas_info_arb["l2_gas_cost_usd"] + gas_info_arb["l1_fee_usd"], places=4)
        self.assertAlmostEqual(gas_info_arb["total_gas_cost_usd"], gas_info_arb["l2_gas_cost_usd"] + gas_info_arb["l1_fee_usd"], places=4)

    def test_missing_price_data_rejects_gas_and_trade(self):
        """Verify trade rejection when ETH price is missing, zero, or negative."""
        gas_info_missing = dex_engine.estimate_arbitrage_gas_cost_usd(
            eth_price_usd=0.0,
            chain_id=42161
        )
        self.assertFalse(gas_info_missing["is_gas_acceptable"])
        self.assertEqual(gas_info_missing["error"], "MISSING_PRICE_DATA")

        # In _calculate_net_profit
        buy_q = {"chain_id": 42161, "spot_price": 3000.0, "base_reserve": 5000.0, "quote_reserve": 15_000_000.0}
        sell_q = {"chain_id": 42161, "spot_price": 3060.0, "base_reserve": 5000.0, "quote_reserve": 15_300_000.0}
        profit_res = arbitrage._calculate_net_profit(
            trade_amt=100.0,
            buy_q=buy_q,
            sell_q=sell_q,
            gas_price_gwei=0.02,
            eth_price_usdt=0.0,  # Missing price!
        )
        self.assertFalse(profit_res["is_profitable"])
        self.assertIn("MISSING_PRICE_DATA", profit_res["skip_reason"])


class TestArbitrageOpportunityGates(unittest.TestCase):
    def test_unprofitable_trade_rejected(self):
        """Verify that borderline or unprofitable spreads (gross <= gas) are rejected."""
        buy_q = {"chain_id": 42161, "spot_price": 3000.0, "base_reserve": 5000.0, "quote_reserve": 15_000_000.0}
        # Inverted spread: sell price lower than buy price
        sell_q = {"chain_id": 42161, "spot_price": 2990.0, "base_reserve": 5000.0, "quote_reserve": 14_950_000.0}

        profit_res = arbitrage._calculate_net_profit(
            trade_amt=10.0,
            buy_q=buy_q,
            sell_q=sell_q,
            gas_price_gwei=0.02,
            eth_price_usdt=3000.0,
        )
        self.assertFalse(profit_res["is_profitable"])
        self.assertLess(profit_res["net_profit_usdt"], 0)

    def test_emergency_stop_blocks_execution(self):
        """Verify emergency stop freezes execution."""
        config.EMERGENCY_STOP = True
        self.assertTrue(arbitrage.emergency_stop_active())
        res = arbitrage.execute_real_trade({"buy_dex": "Uniswap_V2", "sell_dex": "SushiSwap_V2"})
        self.assertFalse(res["success"])
        self.assertIn("Emergency stop is active", res["message"])
        config.EMERGENCY_STOP = False


class TestReceiptBasedProfitAccounting(unittest.TestCase):
    def test_unverified_profit_fails_when_event_missing(self):
        """Verify that execute_live fails with UNVERIFIED_PROFIT if receipt has no event and balance unchanged."""
        config.set_active_chain(42161)
        config.TRADING_MODE = "LIVE"
        config.LIVE_TRADING_ARMED = True
        config.EMERGENCY_STOP = False

        mock_w3 = MagicMock()
        mock_w3.eth.chain_id = 42161

        plan = {
            "chain_id": 42161,
            "buy_dex": "Uniswap_V2",
            "sell_dex": "SushiSwap_V2",
            "amount_in": 5.0,
            "token_pair": "WETH/USDT",
            "eth_price_usdt": 3000.0,
            "gas_cost_usdt": 0.01,
            "gross_profit_usdt": 0.05,
        }

        # Mock contract calls: simulation passes, gas passes
        mock_arb = MagicMock()
        mock_arb.functions.simulateArbitrage.return_value.call.return_value = (True, 50000, 100000, 105000)
        mock_arb.functions.executeArbitrage.return_value.estimate_gas.return_value = 200000
        acct_addr = "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A"
        mock_arb.functions.executeArbitrage.return_value.build_transaction.return_value = {
            "from": acct_addr, "nonce": 0, "chainId": 42161, "gas": 260000, "maxFeePerGas": 10000000, "maxPriorityFeePerGas": 1000000, "type": 2
        }

        mock_erc = MagicMock()
        mock_erc.functions.balanceOf.return_value.call.return_value = 10_000_000  # 10 USDT
        mock_erc.functions.allowance.return_value.call.return_value = 10_000_000

        mock_w3.eth.contract.side_effect = lambda address, abi: mock_arb if "executeArbitrage" in str(abi) else mock_erc
        mock_w3.eth.get_balance.return_value = 10**18  # 1 ETH
        mock_w3.eth.get_block.return_value = {"baseFeePerGas": 10_000_000}
        mock_w3.eth.send_raw_transaction.return_value = b"\x12" * 32

        # Receipt status = 1 (mined), but NO event returned
        mock_receipt = {
            "status": 1,
            "gasUsed": 150000,
            "effectiveGasPrice": 10_000_000,
            "blockNumber": 123456,
            "logs": [],
        }
        mock_w3.eth.get_transaction_receipt.return_value = mock_receipt

        # Event parser returns empty list
        mock_arb.events.ArbitrageExecuted.return_value.process_receipt.return_value = []

        with patch("live_executor.get_w3", return_value=mock_w3), \
             patch("live_executor._cfg", side_effect=lambda k, d: "0x" + "1" * 64 if k == "PRIVATE_KEY" else ("0x" + "2" * 40 if k == "ARBITRAGE_CONTRACT_ADDRESS" else d)):
            res = live_executor.execute_live(plan)
            # Must NOT report exp_profit as realized profit; must fail safely
            self.assertFalse(res["success"])
            self.assertEqual(res["status"], "UNVERIFIED_PROFIT")


if __name__ == "__main__":
    unittest.main()
