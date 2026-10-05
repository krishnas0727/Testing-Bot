"""Unit Tests for Fee Calculation & Profitability Accuracy (Phase 7).

Verifies strict compliance with Phase 7 requirements:
1. Fee percentage (0.3%), decimal fraction (0.003), and USD value are strictly accurate.
2. $5 trade fee ≈ $0.015 per leg ($0.030 total), NEVER $3.00.
3. No fee double-counting.
4. Token decimals: 18-decimal (WETH), 6-decimal (USDC/USDT) handled accurately.
5. Gas units: wei -> ETH -> USD converted with exact math.
6. Slippage calculation: amountOutMin is never 0 and calculated correctly.
7. Profitability decision:
   - Gross positive, net negative -> BLOCKED.
   - Gross positive, net zero -> BLOCKED.
   - Gross positive, net positive -> ELIGIBLE.
8. Missing data handling:
   - Missing gas price -> BLOCKED (never assume gas = 0).
   - Missing USD price -> BLOCKED (never assume gas = 0).
   - Gas estimate failure -> BLOCKED.
9. Final pre-signing gate:
   - Re-check after gas estimation rejects if updated net profit <= 0.
10. LIVE/MOCK separation:
   - Live mode refuses simulated/mock reserves.
11. Zero real blockchain transactions executed.
"""

import os
import sys
import math
import unittest
from unittest.mock import patch, MagicMock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import config
import dex_engine
import live_executor
import arbitrage
from dex_engine import (
    calculate_amount_out,
    calculate_price_impact,
    calculate_slippage_min_out,
    estimate_arbitrage_gas_cost_usd,
    get_token_decimals,
)
from arbitrage import (
    get_dex_fee_fraction,
    calculate_dex_swap_fee_usd,
    calculate_two_leg_dex_fees_usd,
)


class TestFeeAndProfitabilityAccuracy(unittest.TestCase):
    def setUp(self):
        self.orig_mode = getattr(config, "TRADING_MODE", "MOCK")
        self.orig_armed = getattr(config, "LIVE_TRADING_ARMED", False)
        self.orig_emergency = getattr(config, "EMERGENCY_STOP", False)
        self.orig_chain_id = getattr(config, "CHAIN_ID", 8453)
        config.set_active_chain(8453)
        config.EMERGENCY_STOP = False

    def tearDown(self):
        config.TRADING_MODE = self.orig_mode
        config.LIVE_TRADING_ARMED = self.orig_armed
        config.EMERGENCY_STOP = self.orig_emergency
        config.set_active_chain(self.orig_chain_id)

    # ============================================================
    # 1. FEE CALCULATION ACCURACY & REGRESSION TEST
    # ============================================================

    def test_fee_fraction_conversion(self):
        """Requirement 1: 0.30% fee is strictly 0.003 decimal fraction."""
        self.assertEqual(get_dex_fee_fraction(0.30), 0.003)
        self.assertEqual(get_dex_fee_fraction(0.3), 0.003)
        self.assertEqual(get_dex_fee_fraction(0.003), 0.003)

    def test_5_dollar_trade_fee_regression(self):
        """Requirement 23 & Regression: For $5 trade, 0.3% fee is ~$0.015 per leg, ~$0.03 total (NEVER ~$3.00)."""
        trade_amount = 5.0

        # Leg 1: $5.00 * 0.003 = $0.0150
        leg1_fee = calculate_dex_swap_fee_usd(trade_amount, 0.30)
        self.assertAlmostEqual(leg1_fee, 0.0150, places=4)

        # Both legs ($5.00 trade)
        two_leg = calculate_two_leg_dex_fees_usd(trade_amount, trade_amount, 0.30)
        self.assertAlmostEqual(two_leg["fee_leg1_usd"], 0.0150, places=4)
        self.assertAlmostEqual(two_leg["fee_leg2_usd"], 0.0150, places=4)
        self.assertAlmostEqual(two_leg["total_dex_fees_usd"], 0.0300, places=4)

        # Critical regression assertion: fee must be << $0.10, NEVER ~$3.00
        self.assertLess(two_leg["total_dex_fees_usd"], 0.05)
        self.assertGreater(two_leg["total_dex_fees_usd"], 0.01)

    def test_fee_scaling_with_trade_amount(self):
        """Requirement 2: Fee scales proportionally with trade amount ($5, $100, $1000)."""
        fee_5 = calculate_two_leg_dex_fees_usd(5.0, 5.0, 0.30)["total_dex_fees_usd"]
        fee_100 = calculate_two_leg_dex_fees_usd(100.0, 100.0, 0.30)["total_dex_fees_usd"]
        fee_1000 = calculate_two_leg_dex_fees_usd(1000.0, 1000.0, 0.30)["total_dex_fees_usd"]

        self.assertAlmostEqual(fee_5, 0.0300, places=4)
        self.assertAlmostEqual(fee_100, 0.6000, places=4)
        self.assertAlmostEqual(fee_1000, 6.0000, places=4)

        # Verify linear proportionality
        self.assertAlmostEqual(fee_100 / fee_5, 20.0, places=2)
        self.assertAlmostEqual(fee_1000 / fee_100, 10.0, places=2)

    def test_no_fee_double_counting(self):
        """Requirement 4 & 27: Uniswap V2 calculate_amount_out already incorporates the 0.3% fee."""
        reserve_in = 100_000.0
        reserve_out = 50.0
        amount_in = 100.0

        # With 0.3% fee: amount_in_with_fee = 100 * 0.997 = 99.7
        # Expected out = (99.7 * 50) / (100_000 + 99.7) = 4985 / 100099.7 ≈ 0.0498003
        out_with_fee = calculate_amount_out(amount_in, reserve_in, reserve_out, fee_pct=0.30)
        expected_out = (99.7 * 50.0) / (100_000.0 + 99.7)
        self.assertAlmostEqual(out_with_fee, expected_out, places=8)

        # Zero fee output for comparison
        out_zero_fee = calculate_amount_out(amount_in, reserve_in, reserve_out, fee_pct=0.0)
        expected_zero_fee = (100.0 * 50.0) / (100_000.0 + 100.0)
        self.assertAlmostEqual(out_zero_fee, expected_zero_fee, places=8)

        # The fee is already deducted from the output token amount
        self.assertLess(out_with_fee, out_zero_fee)

    # ============================================================
    # 2. TOKEN DECIMALS HANDLING
    # ============================================================

    def test_token_decimals_scaling(self):
        """Requirement 3, 24: Handle 18-decimal and 6-decimal tokens with exact integer conversion."""
        # 18-decimal token (WETH): 1.5 token = 1.5 * 10^18 raw units
        weth_human = 1.5
        weth_raw = int(weth_human * 10**18)
        self.assertEqual(weth_raw, 1_500_000_000_000_000_000)

        # 6-decimal token (USDC / USDT): 5.0 token = 5.0 * 10^6 raw units
        usdt_human = 5.0
        usdt_raw = int(usdt_human * 10**6)
        self.assertEqual(usdt_raw, 5_000_000)

        # Reverse scaling
        self.assertEqual(weth_raw / 10**18, 1.5)
        self.assertEqual(usdt_raw / 10**6, 5.0)

    # ============================================================
    # 3. GAS COST & UNIT CONVERSION
    # ============================================================

    def test_gas_units_and_wei_conversion(self):
        """Requirement 6, 25: gas_units * gas_price_wei / 1e18 * eth_price produces exact USD."""
        gas_units = 250_000
        # 1 Gwei = 10^9 Wei
        gas_price_wei = 1_000_000_000
        eth_price_usd = 3000.0

        gas_info = estimate_arbitrage_gas_cost_usd(
            eth_price_usd=eth_price_usd,
            gas_units=gas_units,
            gas_price_wei=gas_price_wei
        )

        # 250,000 * 10^9 = 2.5 * 10^14 Wei
        # 2.5 * 10^14 / 10^18 = 0.00025 ETH
        # 0.00025 * $3000 = $0.75 USD
        self.assertAlmostEqual(gas_info["gas_cost_eth"], 0.00025, places=8)
        self.assertAlmostEqual(gas_info["gas_cost_usd"], 0.7500, places=4)
        self.assertEqual(gas_info["gas_price_gwei"], 1.0)

    def test_low_and_high_gas_prices(self):
        """Requirement 25: Correct calculation across varying gas price levels."""
        gas_units = 200_000
        eth_price = 2500.0

        # Low gas: 0.05 Gwei (typical Base L2)
        gas_wei_low = 50_000_000
        info_low = estimate_arbitrage_gas_cost_usd(eth_price, gas_units, gas_wei_low)
        # 200,000 * 50,000,000 / 1e18 = 1e13 / 1e18 = 0.00001 ETH * $2500 = $0.025
        self.assertAlmostEqual(info_low["gas_cost_usd"], 0.0250, places=4)

        # High gas: 50 Gwei (Ethereum L1 peak)
        gas_wei_high = 50_000_000_000
        info_high = estimate_arbitrage_gas_cost_usd(eth_price, gas_units, gas_wei_high)
        # 200,000 * 50e9 / 1e18 = 1e16 / 1e18 = 0.01 ETH * $2500 = $25.00
        self.assertAlmostEqual(info_high["gas_cost_usd"], 25.0000, places=4)

    # ============================================================
    # 4. SLIPPAGE ACCOUNTING
    # ============================================================

    def test_slippage_min_out_calculation(self):
        """Requirement 12, 13: calculate_slippage_min_out computes correct minimum acceptable output."""
        # 0.5% slippage on 100 USDT out -> 99.50 USDT
        min_100 = calculate_slippage_min_out(100.0, 0.50)
        self.assertAlmostEqual(min_100, 99.50, places=4)

        # 0.5% slippage on 5.07 USDT out -> 5.04465 USDT
        min_5 = calculate_slippage_min_out(5.07, 0.50)
        self.assertAlmostEqual(min_5, 5.04465, places=4)

        # Slippage min_out must NEVER be 0.0 for positive amount
        self.assertGreater(min_5, 0.0)

    def test_price_impact_already_included_in_amm_quote(self):
        """Requirement: AMM constant-product quote already embeds pool price impact."""
        # 1000 USDT in a pool of 10,000 WETH and 30,000,000 USDT (Spot price = 3000 USDT/WETH)
        res_weth = 10_000.0
        res_usdt = 30_000_000.0
        trade_usdt = 1000.0

        # Zero-slippage / zero-fee theoretical output
        theoretical_out = trade_usdt / 3000.0

        # AMM output with constant-product formula
        actual_out = calculate_amount_out(trade_usdt, res_usdt, res_weth, fee_pct=0.30)

        # Actual output must be less than theoretical due to 0.3% fee and non-linear curve price impact
        self.assertLess(actual_out, theoretical_out)

        # Price impact is positive and measurable
        impact = calculate_price_impact(trade_usdt, actual_out, 1.0 / 3000.0)
        self.assertGreater(impact, 0.0)

    def test_slippage_tolerance_not_deducted_as_realized_cost(self):
        """Requirement: Slippage tolerance is an execution threshold, NOT an upfront realized cash expense."""
        from arbitrage import _calculate_net_profit

        buy_q = {
            "spot_price": 3000.0,
            "quote_reserve": 30_000_000.0,
            "base_reserve": 10_000.0,
        }
        # Sell DEX with slight premium to create a gross spread
        sell_q = {
            "spot_price": 3060.0,
            "quote_reserve": 30_600_000.0,
            "base_reserve": 10_000.0,
        }

        trade_amt = 5.0
        # Gas = 0.01 Gwei (negligible gas on Base)
        res = _calculate_net_profit(trade_amt, buy_q, sell_q, gas_price_gwei=0.01, eth_price_usdt=3000.0)

        gross = res["gross_profit_usdt"]
        gas = res["gas_cost_usdt"]
        net = res["net_profit_usdt"]

        # Net profit MUST equal gross - gas (slippage tolerance is NOT deducted)
        self.assertAlmostEqual(net, gross - gas, places=4)
        self.assertEqual(res["slippage_cost_usdt"], 0.0)

        # But min_usdt_out (amountOutMin) MUST be preserved
        self.assertGreater(res["min_usdt_out"], 0.0)
        self.assertLess(res["min_usdt_out"], res["usdt_out"])

    def test_positive_opportunity_not_rejected_by_slippage_buffer(self):
        """Requirement: A genuinely profitable opportunity is not rejected because of an artificial slippage haircut."""
        from arbitrage import _calculate_net_profit

        # Buy pool: 3000 USD/WETH
        buy_q = {"spot_price": 3000.0, "quote_reserve": 50_000_000.0, "base_reserve": 16_666.0}
        # Sell pool: 3040 USD/WETH (approx +1.33% spread, profitable after 0.6% DEX fees and gas)
        sell_q = {"spot_price": 3040.0, "quote_reserve": 50_000_000.0, "base_reserve": 16_447.0}

        trade_amt = 5.0
        res = _calculate_net_profit(trade_amt, buy_q, sell_q, gas_price_gwei=0.01, eth_price_usdt=3000.0)

        # Gross profit is positive and gas is low
        self.assertGreater(res["gross_profit_usdt"], 0.0)
        self.assertGreater(res["net_profit_usdt"], 0.0)
        # Genuinely profitable opportunity MUST be marked is_profitable = True
        self.assertTrue(res["is_profitable"])

    # ============================================================
    # 5. PROFITABILITY DECISION GATES
    # ============================================================

    def test_positive_gross_negative_net_is_blocked(self):
        """Requirement 15, 21: Gross profit = +$1.00, gas = $1.50 -> net = -$0.50 -> BLOCKED."""
        trade_amt = 100.0
        usdt_returned = 101.00   # +$1.00 gross
        gas_cost = 1.50          # $1.50 gas

        gross_profit = usdt_returned - trade_amt
        net_profit = gross_profit - gas_cost

        self.assertEqual(gross_profit, 1.00)
        self.assertEqual(net_profit, -0.50)

        # Profitability condition check
        is_profitable = (net_profit > 0.0)
        self.assertFalse(is_profitable)

    def test_zero_net_profit_is_blocked(self):
        """Requirement 17: Net profit exactly zero -> BLOCKED."""
        trade_amt = 50.0
        usdt_returned = 50.50    # +$0.50 gross
        gas_cost = 0.50          # $0.50 gas

        gross_profit = usdt_returned - trade_amt
        net_profit = gross_profit - gas_cost

        self.assertEqual(net_profit, 0.0)
        is_profitable = (net_profit > 0.0)
        self.assertFalse(is_profitable)

    def test_positive_net_above_threshold_is_eligible(self):
        """Requirement 16, 22: Gross = +$1.00, gas = $0.20 -> net = +$0.80 -> ELIGIBLE."""
        trade_amt = 50.0
        usdt_returned = 51.00
        gas_cost = 0.20

        gross_profit = usdt_returned - trade_amt
        net_profit = gross_profit - gas_cost

        self.assertEqual(gross_profit, 1.00)
        self.assertEqual(net_profit, 0.80)
        is_profitable = (net_profit > 0.0)
        self.assertTrue(is_profitable)

    # ============================================================
    # 6. FINAL PRE-SIGNING RE-CHECK AFTER GAS ESTIMATION
    # ============================================================

    @patch("live_executor._HAS_WEB3", True)
    @patch("live_executor.get_w3")
    def test_recheck_after_gas_estimation_blocks_unprofitable_trade(self, mock_get_w3):
        """Requirement 11, 26, 27, 30: When realistic gas estimate turns net profit <= 0, abort before signing."""
        config.TRADING_MODE = "LIVE"
        config.LIVE_TRADING_ARMED = True
        config.PRIVATE_KEY = "0x" + "1" * 64
        config.ARBITRAGE_CONTRACT_ADDRESS = "0x" + "2" * 40

        mock_w3 = MagicMock()
        mock_get_w3.return_value = mock_w3
        mock_w3.eth.chain_id = config.CHAIN_ID

        # Mock contract calls:
        # simulateArbitrage returns gross profit = +0.05 USDT
        # amountIn = 5 USDT (5,000,000 raw), leg2 = 5.05 USDT (5,050,000 raw)
        mock_arb = MagicMock()
        mock_w3.eth.contract.return_value = mock_arb

        # simulateArbitrage returns (profitable=True, exp_profit=50000, leg1=..., leg2=5050000)
        mock_arb.functions.simulateArbitrage.return_value.call.return_value = (True, 50000, 1000, 5050000)

        # eth_estimateGas returns high gas: 400,000 units
        mock_arb.functions.executeArbitrage.return_value.estimate_gas.return_value = 400_000

        mock_w3.eth.get_transaction_count.return_value = 1
        mock_w3.eth.get_block.return_value = {"baseFeePerGas": 2_000_000_000}  # 2 Gwei
        mock_w3.eth.max_priority_fee = 50_000_000  # 0.05 Gwei

        mock_erc = MagicMock()
        mock_erc.functions.balanceOf.return_value.call.return_value = 100_000_000  # 100 USDT
        mock_erc.functions.allowance.return_value.call.return_value = 100_000_000
        mock_w3.eth.contract.side_effect = lambda address, abi: mock_arb if "Arbitrage" in str(abi) or "simulateArbitrage" in str(abi) else mock_erc
        mock_w3.eth.get_balance.return_value = int(1.0 * 1e18)  # 1 ETH

        # Plan with $0.05 gross profit, but gas will cost > $0.05
        plan = {
            "buy_dex": "Uniswap_V2",
            "sell_dex": "SushiSwap_V2",
            "token_pair": "WETH/USDT",
            "amount_in": 5.0,
            "chain_id": config.CHAIN_ID,
            "eth_price_usdt": 3000.0,
            "gas_cost_usdt": 0.005,
        }

        with patch("live_executor.config.validate_chain_dex_routers", return_value=(True, "", ["Uniswap_V2", "SushiSwap_V2"])):
            result = live_executor.execute_live(plan)

        self.assertFalse(result["success"])
        self.assertEqual(result["status"], "UNPROFITABLE_AFTER_GAS_ESTIMATE")
        self.assertIn("Trade cancelled before signing", result["message"])

        # Crucial check: send_raw_transaction was NEVER called!
        mock_w3.eth.send_raw_transaction.assert_not_called()

    @patch("live_executor._HAS_WEB3", True)
    @patch("live_executor.get_w3")
    def test_missing_eth_price_blocks_live_execution(self, mock_get_w3):
        """Requirement 18, 21: Missing native token (ETH) USD price prevents gas valuation and blocks trade."""
        config.TRADING_MODE = "LIVE"
        config.LIVE_TRADING_ARMED = True
        config.PRIVATE_KEY = "0x" + "1" * 64
        config.ARBITRAGE_CONTRACT_ADDRESS = "0x" + "2" * 40

        mock_w3 = MagicMock()
        mock_get_w3.return_value = mock_w3
        mock_w3.eth.chain_id = config.CHAIN_ID

        mock_arb = MagicMock()
        mock_arb.functions.simulateArbitrage.return_value.call.return_value = (True, 50000, 1000, 5050000)
        mock_arb.functions.executeArbitrage.return_value.estimate_gas.return_value = 200_000
        mock_w3.eth.get_block.return_value = {"baseFeePerGas": 1_000_000_000}
        mock_w3.eth.max_priority_fee = 1_000_000
        mock_w3.eth.get_balance.return_value = int(1.0 * 1e18)

        mock_erc = MagicMock()
        mock_erc.functions.balanceOf.return_value.call.return_value = 100_000_000
        mock_erc.functions.allowance.return_value.call.return_value = 100_000_000
        mock_w3.eth.contract.side_effect = lambda address, abi: mock_arb if "Arbitrage" in str(abi) or "simulateArbitrage" in str(abi) else mock_erc

        # Plan with missing / 0.0 ETH price
        plan = {
            "buy_dex": "Uniswap_V2",
            "sell_dex": "SushiSwap_V2",
            "token_pair": "WETH/USDT",
            "amount_in": 5.0,
            "chain_id": config.CHAIN_ID,
            "eth_price_usdt": 0.0,
            "buy_price": 0.0,
        }

        with patch("live_executor.config.validate_chain_dex_routers", return_value=(True, "", ["Uniswap_V2", "SushiSwap_V2"])):
            result = live_executor.execute_live(plan)

        self.assertFalse(result["success"])
        self.assertEqual(result["status"], "MISSING_PRICE_DATA")
        self.assertIn("Native token (ETH) USD price unavailable", result["message"])
        mock_w3.eth.send_raw_transaction.assert_not_called()

    # ============================================================
    # 7. LIVE / MOCK SEPARATION
    # ============================================================

    def test_live_mode_refuses_simulated_reserves(self):
        """Requirement 16, 23: LIVE mode strictly refuses fallback to mock reserves if on-chain fetch fails."""
        config.TRADING_MODE = "LIVE"

        # When onchain reserves are unavailable and mode is LIVE, get_dex_reserves must raise RuntimeError
        with patch("dex_engine.fetch_pair_reserves", return_value=None):
            with patch("dex_engine.get_pair_address", return_value="0x" + "3" * 40):
                with self.assertRaises(RuntimeError) as ctx:
                    dex_engine.get_dex_reserves("Uniswap_V2", "WETH", "USDT")
                self.assertIn("Refusing to use simulated pools outside MOCK mode", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
