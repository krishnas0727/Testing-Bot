"""Final Live Trade Safety Verification Tests (Phase 9).

Verifies strict compliance with Phase 9 requirements:
1. Profitable opportunity execution condition.
2. Negative-profit opportunity blocked (expected net profit <= 0).
3. Insufficient gas balance blocked (native ETH balance < gas cost).
4. Insufficient token balance blocked (ERC20 token balance < trade amount).
5. Failed simulation blocked (eth_call revert or unprofitable simulation).
6. Failed gas estimation blocked (eth_estimateGas revert).
7. Emergency stop takes precedence and blocks execution.
8. Unarmed live mode blocks execution (trading_mode=LIVE requires live_trading_armed=true).
9. Identical routers blocked.
10. Transaction revert recorded as FAILED with actual gas cost lost.
11. Successful transaction confirmed only after receipt confirms status == 1.
12. Truthful hash & profit verification (no fake transaction hashes or invented profit).
"""

import os
import sys
import unittest
from unittest.mock import MagicMock, patch
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import config
from arbitrage import execute_real_trade, _calculate_net_profit, analyze_market
from dex_engine import execute_atomic_trade, simulate_atomic_arbitrage
import live_executor
from app import app
from database import create_database, delete_all_trades, get_all_trades, get_live_pnl_summary


class TestFinalLiveTradeSafety(unittest.TestCase):
    def setUp(self):
        create_database()
        delete_all_trades()
        self.app = app
        self.client = app.test_client()
        self.orig_token = getattr(config, "API_AUTH_TOKEN", "")
        self.orig_env_token = os.environ.get("API_AUTH_TOKEN", "")
        self.auth_token = "local_dev_token_12345"
        config.API_AUTH_TOKEN = self.auth_token
        os.environ["API_AUTH_TOKEN"] = self.auth_token
        self.headers = {"Authorization": f"Bearer {self.auth_token}"}

        self.orig_chain_id = config.CHAIN_ID
        self.orig_trading_mode = config.TRADING_MODE
        self.orig_armed = config.LIVE_TRADING_ARMED
        self.orig_emergency_stop = config.EMERGENCY_STOP
        self.orig_min_profit = config.MIN_PROFIT_USDT
        self.orig_pk = config.PRIVATE_KEY
        self.orig_contract = config.ARBITRAGE_CONTRACT_ADDRESS

        # Safe default test environment: Sepolia testnet with 2 valid routers
        config.set_active_chain(11155111)
        config.TRADING_MODE = "LIVE"
        config.LIVE_TRADING_ARMED = True
        config.EMERGENCY_STOP = False
        config.MIN_PROFIT_USDT = 0.01
        # Set dummy 64-char private key for testing key validation
        config.PRIVATE_KEY = "0x" + "1" * 64
        config.ARBITRAGE_CONTRACT_ADDRESS = "0x0000000000000000000000000000000000000001"

    def tearDown(self):
        config.API_AUTH_TOKEN = self.orig_token
        if self.orig_env_token:
            os.environ["API_AUTH_TOKEN"] = self.orig_env_token
        else:
            os.environ.pop("API_AUTH_TOKEN", None)
        config.set_active_chain(self.orig_chain_id)
        config.TRADING_MODE = self.orig_trading_mode
        config.LIVE_TRADING_ARMED = self.orig_armed
        config.EMERGENCY_STOP = self.orig_emergency_stop
        config.MIN_PROFIT_USDT = self.orig_min_profit
        config.PRIVATE_KEY = self.orig_pk
        config.ARBITRAGE_CONTRACT_ADDRESS = self.orig_contract

    # ------------------------------------------------------------------
    # 1. Negative-Profit Opportunity Blocked
    # ------------------------------------------------------------------
    def test_negative_profit_opportunity_blocked(self):
        """Requirement 5 & 6: If expected net profit is <= 0 or below threshold, trade is SKIPPED."""
        buy_q = {
            "spot_price": 3000.0,
            "quote_reserve": 300000.0,
            "base_reserve": 100.0,
        }
        sell_q = {
            "spot_price": 2990.0,  # Inverted spread: sell price < buy price
            "base_reserve": 100.0,
            "quote_reserve": 299000.0,
        }
        # Recalculate profit server-side
        profit_info = _calculate_net_profit(
            trade_amt=10.0,
            buy_q=buy_q,
            sell_q=sell_q,
            gas_price_gwei=10.0,
            eth_price_usdt=3000.0
        )
        self.assertFalse(profit_info["is_profitable"])
        self.assertLessEqual(profit_info["net_profit_usdt"], 0.0)

        # execute_real_trade must reject negative or zero profit
        mock_market = {
            "best_route": {
                "buy_dex": "Uniswap_V2",
                "sell_dex": "SushiSwap_V2",
                "chain_id": 11155111,
                "amount_in": 10.0,
                "is_profitable": False,
                "net_profit_usdt": -0.05,
            }
        }
        res = execute_real_trade(mock_market, is_manual=True)
        self.assertFalse(res.get("success", False))
        self.assertIn(res.get("status"), ("TRADE SKIPPED", "INSUFFICIENT_PROFIT"))

    # ------------------------------------------------------------------
    # 2. Emergency Stop Gating
    # ------------------------------------------------------------------
    def test_emergency_stop_blocks_execution(self):
        """Requirement 5 & 7: Emergency stop takes absolute precedence and halts execution."""
        config.EMERGENCY_STOP = True
        mock_market = {
            "best_route": {
                "buy_dex": "Uniswap_V2",
                "sell_dex": "SushiSwap_V2",
                "chain_id": 11155111,
                "amount_in": 10.0,
                "is_profitable": True,
                "net_profit_usdt": 5.0,
            }
        }
        res = execute_real_trade(mock_market, is_manual=True)
        self.assertFalse(res.get("success", False))
        self.assertEqual(res.get("skip_reason"), "Emergency stop is active")

        # Also direct live_executor call is blocked
        live_res = live_executor.execute_live({"buy_dex": "Uniswap_V2", "sell_dex": "SushiSwap_V2", "amount_in": 10.0})
        self.assertFalse(live_res.get("success", False))
        self.assertEqual(live_res.get("status"), "BLOCKED_EMERGENCY_STOP")

    # ------------------------------------------------------------------
    # 3. Unarmed Live Mode Blocked
    # ------------------------------------------------------------------
    def test_unarmed_live_mode_blocks_execution(self):
        """Requirement 5: TRADING_MODE=LIVE requires LIVE_TRADING_ARMED=True."""
        config.LIVE_TRADING_ARMED = False
        mock_market = {
            "best_route": {
                "buy_dex": "Uniswap_V2",
                "sell_dex": "SushiSwap_V2",
                "chain_id": 11155111,
                "amount_in": 10.0,
                "is_profitable": True,
                "net_profit_usdt": 5.0,
            }
        }
        res = execute_real_trade(mock_market, is_manual=True)
        self.assertFalse(res.get("success", False))
        self.assertIn("LIVE trading is not armed", res.get("skip_reason", ""))

        exec_res = execute_atomic_trade({"buy_dex": "Uniswap_V2", "sell_dex": "SushiSwap_V2", "amount_in": 10.0, "chain_id": 11155111})
        self.assertFalse(exec_res.get("success", False))
        self.assertEqual(exec_res.get("status"), "NOT_ARMED")

    # ------------------------------------------------------------------
    # 4. Identical Routers Blocked
    # ------------------------------------------------------------------
    def test_identical_routers_blocked(self):
        """Requirement 15: Identical routers blocked from trade execution."""
        mock_market = {
            "best_route": {
                "buy_dex": "Uniswap_V2",
                "sell_dex": "Uniswap_V2",  # Identical
                "chain_id": 11155111,
                "amount_in": 10.0,
                "is_profitable": True,
                "net_profit_usdt": 5.0,
            }
        }
        res = execute_real_trade(mock_market, is_manual=True)
        self.assertFalse(res.get("success", False))
        self.assertIn("Arbitrage unavailable: fewer than two valid DEX routers configured.", res.get("skip_reason", ""))

    # ------------------------------------------------------------------
    # 5. Insufficient Token Balance Blocked
    # ------------------------------------------------------------------
    @patch("live_executor.get_w3")
    def test_insufficient_token_balance_blocked(self, mock_w3_getter):
        """Requirement 5 & 15: Signer lacking required token balance is blocked."""
        mock_w3 = MagicMock()
        mock_w3_getter.return_value = mock_w3

        # Return token balance 0
        mock_contract = MagicMock()
        mock_contract.functions.balanceOf.return_value.call.return_value = 0
        mock_contract.functions.allowance.return_value.call.return_value = 0
        mock_w3.eth.contract.return_value = mock_contract
        mock_w3.eth.get_balance.return_value = 10**18  # plenty of gas

        plan = {
            "buy_dex": "Uniswap_V2",
            "sell_dex": "SushiSwap_V2",
            "chain_id": 11155111,
            "amount_in": 100.0,
        }
        res = live_executor.execute_live(plan)
        self.assertFalse(res.get("success", False))
        self.assertIn(res.get("status"), ("INSUFFICIENT_TOKEN_BALANCE", "INSUFFICIENT BALANCE"))

    # ------------------------------------------------------------------
    # 6. Insufficient Gas Balance Blocked
    # ------------------------------------------------------------------
    @patch("live_executor.get_w3")
    def test_insufficient_gas_balance_blocked(self, mock_w3_getter):
        """Requirement 5 & 15: Signer lacking native ETH for gas is blocked."""
        mock_w3 = MagicMock()
        mock_w3_getter.return_value = mock_w3

        # Token balance is plenty, but native ETH balance is zero
        mock_contract = MagicMock()
        mock_contract.functions.balanceOf.return_value.call.return_value = 1000 * 10**6
        mock_contract.functions.allowance.return_value.call.return_value = 1000 * 10**6
        # Simulate succeeds
        mock_contract.functions.simulateArbitrage.return_value.call.return_value = (True, 500000, 100000, 500000)
        mock_contract.functions.executeArbitrage.return_value.estimate_gas.return_value = 250000
        mock_w3.eth.contract.return_value = mock_contract

        mock_w3.eth.get_block.return_value = {"baseFeePerGas": 20 * 10**9}
        mock_w3.eth.get_balance.return_value = 100  # negligible wei, far below gas requirement

        plan = {
            "buy_dex": "Uniswap_V2",
            "sell_dex": "SushiSwap_V2",
            "chain_id": 11155111,
            "amount_in": 10.0,
        }
        res = live_executor.execute_live(plan)
        self.assertFalse(res.get("success", False))
        self.assertEqual(res.get("status"), "INSUFFICIENT_GAS_BALANCE")

    # ------------------------------------------------------------------
    # 7. Failed Simulation Blocked
    # ------------------------------------------------------------------
    @patch("live_executor.get_w3")
    def test_failed_simulation_blocked(self, mock_w3_getter):
        """Requirement 5 & 15: If on-chain simulation reverts or returns unprofitable, execution aborts."""
        mock_w3 = MagicMock()
        mock_w3_getter.return_value = mock_w3

        mock_contract = MagicMock()
        mock_contract.functions.balanceOf.return_value.call.return_value = 1000 * 10**6
        mock_contract.functions.allowance.return_value.call.return_value = 1000 * 10**6
        # Simulation call reverts
        mock_contract.functions.simulateArbitrage.return_value.call.side_effect = Exception("execution reverted: InsufficientOutput")
        mock_w3.eth.contract.return_value = mock_contract
        mock_w3.eth.get_balance.return_value = 10**18

        plan = {
            "buy_dex": "Uniswap_V2",
            "sell_dex": "SushiSwap_V2",
            "chain_id": 11155111,
            "amount_in": 10.0,
        }
        res = live_executor.execute_live(plan)
        self.assertFalse(res.get("success", False))
        self.assertEqual(res.get("status"), "SIMULATION_FAILED")

    # ------------------------------------------------------------------
    # 8. Failed Gas Estimation Blocked
    # ------------------------------------------------------------------
    @patch("live_executor.get_w3")
    def test_failed_gas_estimation_blocked(self, mock_w3_getter):
        """Requirement 5 & 15: If gas estimation reverts, execution aborts before signing/sending."""
        mock_w3 = MagicMock()
        mock_w3_getter.return_value = mock_w3

        mock_contract = MagicMock()
        mock_contract.functions.balanceOf.return_value.call.return_value = 1000 * 10**6
        mock_contract.functions.allowance.return_value.call.return_value = 1000 * 10**6
        mock_contract.functions.simulateArbitrage.return_value.call.return_value = (True, 500000, 100000, 500000)
        # Gas estimation reverts
        mock_contract.functions.executeArbitrage.return_value.estimate_gas.side_effect = Exception("execution reverted")
        mock_w3.eth.contract.return_value = mock_contract
        mock_w3.eth.get_balance.return_value = 10**18

        plan = {
            "buy_dex": "Uniswap_V2",
            "sell_dex": "SushiSwap_V2",
            "chain_id": 11155111,
            "amount_in": 10.0,
        }
        res = live_executor.execute_live(plan)
        self.assertFalse(res.get("success", False))
        self.assertEqual(res.get("status"), "GAS_ESTIMATION_FAILED")

    # ------------------------------------------------------------------
    # 9. Transaction Revert Recorded as FAILED with Gas Loss
    # ------------------------------------------------------------------
    @patch("live_executor.get_w3")
    def test_transaction_revert_recorded_as_failed_with_gas_loss(self, mock_w3_getter):
        """Requirement 10 & 11: Reverted transaction receipt status == 0 is recorded as FAILED."""
        mock_w3 = MagicMock()
        mock_w3_getter.return_value = mock_w3

        mock_contract = MagicMock()
        mock_contract.functions.balanceOf.return_value.call.return_value = 1000 * 10**6
        mock_contract.functions.allowance.return_value.call.return_value = 1000 * 10**6
        mock_contract.functions.simulateArbitrage.return_value.call.return_value = (True, 500000, 100000, 500000)
        mock_contract.functions.executeArbitrage.return_value.estimate_gas.return_value = 200000
        mock_contract.functions.executeArbitrage.return_value.build_transaction.return_value = {
            "to": "0x0000000000000000000000000000000000000001",
            "gas": 250000,
            "maxFeePerGas": 20 * 10**9,
            "maxPriorityFeePerGas": 10**9,
            "nonce": 1,
            "chainId": 11155111,
            "value": 0,
            "type": 2,
        }
        mock_w3.eth.contract.return_value = mock_contract

        mock_w3.eth.get_block.return_value = {"baseFeePerGas": 10 * 10**9}
        mock_w3.eth.get_balance.return_value = 10**18
        mock_w3.eth.get_transaction_count.return_value = 1
        
        # Mock transaction broadcast
        dummy_hash = os.urandom(32)
        mock_w3.eth.send_raw_transaction.return_value = dummy_hash

        # Reverted receipt (status == 0)
        mock_w3.eth.get_transaction_receipt.return_value = {
            "status": 0,
            "gasUsed": 150000,
            "effectiveGasPrice": 10 * 10**9,
            "blockNumber": 1234567,
        }

        plan = {
            "buy_dex": "Uniswap_V2",
            "sell_dex": "SushiSwap_V2",
            "chain_id": 11155111,
            "amount_in": 10.0,
            "eth_price_usdt": 3000.0,
        }
        res = live_executor.execute_live(plan)
        self.assertFalse(res.get("success", False))
        self.assertEqual(res.get("status"), "REVERTED")
        self.assertGreater(float(res.get("gas_cost_usdt", 0.0)), 0.0)

    # ------------------------------------------------------------------
    # 10. Successful Confirmed Transaction Only on Receipt
    # ------------------------------------------------------------------
    @patch("live_executor.get_w3")
    def test_successful_confirmed_transaction_only_on_receipt(self, mock_w3_getter):
        """Requirement 10 & 16: Trade marked CONFIRMED only upon receipt confirmation with positive net profit."""
        mock_w3 = MagicMock()
        mock_w3_getter.return_value = mock_w3

        mock_contract = MagicMock()
        mock_contract.functions.balanceOf.return_value.call.return_value = 1000 * 10**6
        mock_contract.functions.allowance.return_value.call.return_value = 1000 * 10**6
        # Expected profit $10.00 (10,000,000 raw)
        mock_contract.functions.simulateArbitrage.return_value.call.return_value = (True, 10000000, 100000, 10000000)
        mock_contract.functions.executeArbitrage.return_value.estimate_gas.return_value = 200000
        mock_contract.functions.executeArbitrage.return_value.build_transaction.return_value = {
            "to": "0x0000000000000000000000000000000000000001",
            "gas": 250000,
            "maxFeePerGas": 20 * 10**9,
            "maxPriorityFeePerGas": 10**9,
            "nonce": 2,
            "chainId": 11155111,
            "value": 0,
            "type": 2,
        }
        
        # Mock on-chain event log
        mock_event = MagicMock()
        mock_event.process_receipt.return_value = [{
            "args": {
                "netProfit": 10000000,  # $10.00 gross profit
                "finalBalance": 20000000,
            }
        }]
        mock_contract.events.ArbitrageExecuted.return_value = mock_event
        mock_w3.eth.contract.return_value = mock_contract

        mock_w3.eth.get_block.return_value = {"baseFeePerGas": 10 * 10**9}
        mock_w3.eth.get_balance.return_value = 10**18
        mock_w3.eth.get_transaction_count.return_value = 2

        dummy_hash = os.urandom(32)
        mock_w3.eth.send_raw_transaction.return_value = dummy_hash

        # Mined successfully (status == 1)
        mock_w3.eth.get_transaction_receipt.return_value = {
            "status": 1,
            "gasUsed": 150000,
            "effectiveGasPrice": 10 * 10**9,
            "blockNumber": 1234568,
        }

        plan = {
            "buy_dex": "Uniswap_V2",
            "sell_dex": "SushiSwap_V2",
            "chain_id": 11155111,
            "amount_in": 10.0,
            "eth_price_usdt": 3000.0,
        }
        res = live_executor.execute_live(plan)
        self.assertTrue(res.get("success", False))
        self.assertEqual(res.get("status"), "CONFIRMED")
        self.assertGreater(float(res.get("net_profit", 0.0)), 0.0)
        self.assertEqual(res.get("tx_hash"), "0x" + dummy_hash.hex())

    # ------------------------------------------------------------------
    # 11. MOCK Mode Separate from LIVE Mode
    # ------------------------------------------------------------------
    def test_mock_mode_separate_from_live(self):
        """Requirement 13 & 14: /api/pnl separates MOCK trades from LIVE on-chain trades."""
        from database import save_trade
        # Record a MOCK trade
        save_trade({
            "tx_hash": "0xmock_profit_tx_1",
            "chain_id": 11155111,
            "buy_dex": "Uniswap_V2",
            "sell_dex": "SushiSwap_V2",
            "token_pair": "WETH/USDT",
            "amount_in": 10.0,
            "amount_out": 12.0,
            "gross_profit": 2.0,
            "net_profit": 1.95,
            "status": "CONFIRMED",
            "mode": "MOCK"
        })

        # Record a LIVE trade
        save_trade({
            "tx_hash": "0xlive_profit_tx_real",
            "chain_id": 11155111,
            "buy_dex": "Uniswap_V2",
            "sell_dex": "SushiSwap_V2",
            "token_pair": "WETH/USDT",
            "amount_in": 10.0,
            "amount_out": 10.5,
            "gross_profit": 0.5,
            "net_profit": 0.45,
            "status": "CONFIRMED",
            "mode": "LIVE"
        })

        # Query LIVE pnl
        res_live = self.client.get("/api/pnl?mode=LIVE")
        data_live = res_live.get_json()
        self.assertEqual(data_live["total_trades"], 1)
        self.assertEqual(data_live["total_net_profit"], 0.45)

        # Query MOCK pnl
        res_mock = self.client.get("/api/pnl?mode=MOCK")
        data_mock = res_mock.get_json()
        self.assertEqual(data_mock["total_trades"], 1)
        self.assertEqual(data_mock["total_net_profit"], 1.95)


if __name__ == "__main__":
    unittest.main()
