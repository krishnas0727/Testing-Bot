"""Unit Tests for DEX Router Configuration & Validation (Phase 8).

Verifies strict compliance with Phase 8 requirements:
1. Rejection of identical router addresses under different DEX names.
2. Rejection / graceful handling of missing routers (< 2 routers).
3. Rejection / filtration of invalid (malformed) router addresses.
4. Acceptance of two valid, different router addresses.
5. Base Sepolia (84532) behavior: truthful report of fewer than two valid routers,
   blocking trade execution with exact message:
   "Arbitrage unavailable: fewer than two valid DEX routers configured."
6. Strict separation between Base mainnet (8453) and Base Sepolia (84532).
7. Execution and simulation layers block when routers are identical or insufficient.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import config
from config import (
    is_valid_ethereum_address,
    validate_chain_dex_routers,
    validate_all_chain_configurations,
    CHAIN_REGISTRY,
)
from arbitrage import analyze_market, execute_real_trade
from dex_engine import simulate_atomic_arbitrage, execute_atomic_trade
from app import app


class TestRouterConfiguration(unittest.TestCase):
    def setUp(self):
        self.app = app
        self.client = app.test_client()
        self.orig_chain_id = config.CHAIN_ID
        self.orig_routers = dict(config.DEX_ROUTERS)
        self.orig_dexes = list(config.SUPPORTED_DEXES)
        self.orig_trading_mode = config.TRADING_MODE
        self.orig_emergency_stop = config.EMERGENCY_STOP
        self.orig_armed = config.LIVE_TRADING_ARMED
        config.EMERGENCY_STOP = False
        config.LIVE_TRADING_ARMED = False
        config.TRADING_MODE = "MOCK"
        self.orig_token = getattr(config, "API_AUTH_TOKEN", "")
        if not config.API_AUTH_TOKEN:
            config.API_AUTH_TOKEN = "test_phase8_token"
        self.auth_headers = {"Authorization": f"Bearer {config.API_AUTH_TOKEN}"}

    def tearDown(self):
        config.set_active_chain(self.orig_chain_id)
        config.DEX_ROUTERS = self.orig_routers
        config.SUPPORTED_DEXES = self.orig_dexes
        config.TRADING_MODE = self.orig_trading_mode
        config.EMERGENCY_STOP = self.orig_emergency_stop
        config.LIVE_TRADING_ARMED = self.orig_armed
        config.API_AUTH_TOKEN = self.orig_token

    # ------------------------------------------------------------------
    # 1. Address Validation Helper Tests
    # ------------------------------------------------------------------
    def test_is_valid_ethereum_address(self):
        """Verify EVM address format validation."""
        self.assertTrue(is_valid_ethereum_address("0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24"))
        self.assertTrue(is_valid_ethereum_address("0x1662c4ca803b6d5d42c85d552318b7625038923d"))
        # Invalid cases
        self.assertFalse(is_valid_ethereum_address("0xinvalid"))
        self.assertFalse(is_valid_ethereum_address("0x12345"))  # too short
        self.assertFalse(is_valid_ethereum_address("4752ba5DBc23f44D87826276BF6Fd6b1C372aD24"))  # no 0x prefix
        self.assertFalse(is_valid_ethereum_address(""))
        self.assertFalse(is_valid_ethereum_address(None))
        self.assertFalse(is_valid_ethereum_address(12345))

    # ------------------------------------------------------------------
    # 2. Identical Router Addresses Test
    # ------------------------------------------------------------------
    def test_identical_router_addresses_rejected(self):
        """Requirement 3 & 10: Never silently use the same router as two different DEXes."""
        same_addr = "0x1662C4Ca803B6d5d42C85d552318b7625038923d"
        routers = {
            "Uniswap_V2": same_addr,
            "SushiSwap_V2": same_addr.lower(),  # Even with different casing
        }
        is_valid, reason, valid_dexes = validate_chain_dex_routers(
            routers=routers, dexes=["Uniswap_V2", "SushiSwap_V2"]
        )
        self.assertFalse(is_valid)
        self.assertEqual(reason, "Arbitrage unavailable: fewer than two valid DEX routers configured.")

    # ------------------------------------------------------------------
    # 3. Missing Router Test
    # ------------------------------------------------------------------
    def test_missing_router_rejected(self):
        """Requirement 8 & 10: Missing router results in fewer than two valid routers."""
        # Only 1 router provided
        routers = {
            "Uniswap_V2": "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24"
        }
        is_valid, reason, valid_dexes = validate_chain_dex_routers(
            routers=routers, dexes=["Uniswap_V2"]
        )
        self.assertFalse(is_valid)
        self.assertEqual(reason, "Arbitrage unavailable: fewer than two valid DEX routers configured.")
        self.assertEqual(valid_dexes, ["Uniswap_V2"])

        # Empty dictionary
        is_valid_empty, reason_empty, _ = validate_chain_dex_routers(routers={}, dexes=[])
        self.assertFalse(is_valid_empty)
        self.assertEqual(reason_empty, "Arbitrage unavailable: fewer than two valid DEX routers configured.")

    # ------------------------------------------------------------------
    # 4. Invalid Router Test
    # ------------------------------------------------------------------
    def test_invalid_router_rejected(self):
        """Requirement 10: Malformed router address is not counted as a valid router."""
        routers = {
            "Uniswap_V2": "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
            "SushiSwap_V2": "0xINVALID_ROUTER_ADDRESS_NOT_HEX_CHARS!",
        }
        is_valid, reason, valid_dexes = validate_chain_dex_routers(
            routers=routers, dexes=["Uniswap_V2", "SushiSwap_V2"]
        )
        self.assertFalse(is_valid)
        self.assertEqual(reason, "Arbitrage unavailable: fewer than two valid DEX routers configured.")
        self.assertEqual(valid_dexes, ["Uniswap_V2"])

    # ------------------------------------------------------------------
    # 5. Two Valid Different Routers Test
    # ------------------------------------------------------------------
    def test_two_valid_different_routers_accepted(self):
        """Requirement 10: Two distinct valid EVM routers pass validation."""
        routers = {
            "Uniswap_V2": "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
            "SushiSwap_V2": "0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891",
        }
        is_valid, reason, valid_dexes = validate_chain_dex_routers(
            routers=routers, dexes=["Uniswap_V2", "SushiSwap_V2"]
        )
        self.assertTrue(is_valid)
        self.assertEqual(reason, "Valid DEX routers configured.")
        self.assertEqual(set(valid_dexes), {"Uniswap_V2", "SushiSwap_V2"})

    # ------------------------------------------------------------------
    # 6. Base Sepolia (84532) Truthful Configuration & Gate
    # ------------------------------------------------------------------
    def test_base_sepolia_arbitrage_unavailable(self):
        """Requirement 7 & 8: Base Sepolia only has 1 verified DEX router and reports unavailable."""
        config.set_active_chain(84532)
        self.assertEqual(config.CHAIN_ID, 84532)

        # Routers on Base Sepolia must not have identical SushiSwap_V2 address
        self.assertNotIn("SushiSwap_V2", config.DEX_ROUTERS)
        self.assertIn("Uniswap_V2", config.DEX_ROUTERS)

        is_valid, reason, valid_dexes = validate_chain_dex_routers(84532)
        self.assertFalse(is_valid)
        self.assertEqual(reason, "Arbitrage unavailable: fewer than two valid DEX routers configured.")
        self.assertEqual(valid_dexes, ["Uniswap_V2"])

        # Market analysis must immediately mark arbitrage unavailable
        market = analyze_market(custom_amount=5.0, chain_id=84532)
        self.assertIsNotNone(market)
        self.assertFalse(market.get("arbitrage_available"))
        self.assertEqual(market.get("message"), "Arbitrage unavailable: fewer than two valid DEX routers configured.")

    # ------------------------------------------------------------------
    # 7. Mainnet vs Sepolia Address Separation
    # ------------------------------------------------------------------
    def test_base_mainnet_vs_base_sepolia_isolation(self):
        """Requirement 11 & 12: Base mainnet configuration is separate from Base Sepolia."""
        base_mainnet = CHAIN_REGISTRY[8453]
        base_sepolia = CHAIN_REGISTRY[84532]

        # Mainnet must have 2 valid distinct routers
        is_valid_main, _, _ = validate_chain_dex_routers(8453)
        self.assertTrue(is_valid_main)
        self.assertNotEqual(
            base_mainnet["routers"]["Uniswap_V2"].lower(),
            base_mainnet["routers"]["SushiSwap_V2"].lower()
        )

        # Sepolia must not borrow mainnet routers
        self.assertNotEqual(
            base_sepolia["routers"]["Uniswap_V2"].lower(),
            base_mainnet["routers"]["Uniswap_V2"].lower()
        )

        # Sepolia has only 1 verified router, not 2
        is_valid_sep, _, _ = validate_chain_dex_routers(84532)
        self.assertFalse(is_valid_sep)

    # ------------------------------------------------------------------
    # 8. Execution Gating on Identical / Single Router
    # ------------------------------------------------------------------
    def test_trade_execution_blocked_when_routers_insufficient(self):
        """Requirement 4: Do not execute a trade if fewer than two valid routers exist."""
        # 1. execute_real_trade
        market = {
            "chain_id": 84532,
            "best_route": {
                "chain_id": 84532,
                "buy_dex": "Uniswap_V2",
                "sell_dex": "Uniswap_V2",
                "amount_in": 5.0,
                "net_profit_usdt": 1.0,
                "is_profitable": True,
            }
        }
        res = execute_real_trade(market, is_manual=True)
        self.assertFalse(res.get("success", False))
        self.assertIn("Arbitrage unavailable: fewer than two valid DEX routers configured.", res.get("skip_reason", ""))

        # 2. simulate_atomic_arbitrage with identical routers
        sim_res = simulate_atomic_arbitrage({
            "chain_id": 84532,
            "buy_dex": "Uniswap_V2",
            "sell_dex": "Uniswap_V2",
            "amount_in": 5.0,
            "net_profit_usdt": 1.0,
            "gross_return_usdt": 6.0,
        })
        self.assertFalse(sim_res.get("success", False))
        self.assertEqual(sim_res.get("message"), "Arbitrage unavailable: fewer than two valid DEX routers configured.")

        # 3. execute_atomic_trade
        exec_res = execute_atomic_trade({
            "chain_id": 84532,
            "buy_dex": "Uniswap_V2",
            "sell_dex": "Uniswap_V2",
            "amount_in": 5.0,
            "net_profit_usdt": 1.0,
        })
        self.assertFalse(exec_res.get("success", False))
        self.assertEqual(exec_res.get("message"), "Arbitrage unavailable: fewer than two valid DEX routers configured.")

    # ------------------------------------------------------------------
    # 9. Startup Inspection Verification
    # ------------------------------------------------------------------
    def test_validate_all_chain_configurations(self):
        """Requirement 9: Startup inspection logs and validates all registered chains."""
        results = validate_all_chain_configurations()
        self.assertIn(8453, results)
        self.assertIn(1, results)
        self.assertIn(42161, results)
        self.assertIn(137, results)
        self.assertIn(11155111, results)
        self.assertIn(84532, results)

        # Multi-DEX chains must be valid
        self.assertTrue(results[8453]["is_valid"])
        self.assertTrue(results[1]["is_valid"])
        self.assertTrue(results[42161]["is_valid"])
        self.assertTrue(results[137]["is_valid"])
        self.assertTrue(results[11155111]["is_valid"])

        # Base Sepolia must be flagged truthfully
        self.assertFalse(results[84532]["is_valid"])
        self.assertEqual(results[84532]["reason"], "Arbitrage unavailable: fewer than two valid DEX routers configured.")

    # ------------------------------------------------------------------
    # 10. API Endpoints Behavior on Chain with < 2 Routers
    # ------------------------------------------------------------------
    def test_api_verify_profit_blocked_on_base_sepolia(self):
        """API /api/trade/verify-profit returns arbitrage_available=False on Base Sepolia."""
        config.set_active_chain(84532)
        res = self.client.post("/api/trade/verify-profit", json={"trade_amount": 5.0, "chain_id": 84532})
        data = res.get_json()
        self.assertFalse(data.get("is_profitable"))
        self.assertFalse(data.get("arbitrage_available"))
        self.assertEqual(data.get("skip_reason"), "Arbitrage unavailable: fewer than two valid DEX routers configured.")

    # ------------------------------------------------------------------
    # 11. /api/trade Request Body Chain ID & Router Collision Handling
    # ------------------------------------------------------------------
    def test_api_trade_respects_chain_id_from_json_body(self):
        """Requirement 1: /api/trade respects chain_id from JSON request body."""
        # Active server chain is 8453 (Base mainnet with 2 routers)
        config.set_active_chain(8453)
        self.assertEqual(config.CHAIN_ID, 8453)

        # Request specifically asks for chain_id: 84532 (Base Sepolia with < 2 routers)
        res = self.client.post(
            "/api/trade",
            json={"trade_amount": 5.0, "chain_id": 84532},
            headers=self.auth_headers
        )
        self.assertEqual(res.status_code, 400)
        data = res.get_json()
        self.assertFalse(data.get("success", True))
        self.assertEqual(data.get("status"), "ARBITRAGE_UNAVAILABLE")
        self.assertEqual(data.get("message"), "Arbitrage unavailable: fewer than two valid DEX routers configured.")

    def test_api_trade_rejects_base_sepolia_request(self):
        """Requirement 2: /api/trade correctly rejects a Base Sepolia request when only one router exists."""
        config.set_active_chain(84532)
        res = self.client.post(
            "/api/trade",
            json={"trade_amount": 5.0},
            headers=self.auth_headers
        )
        self.assertEqual(res.status_code, 400)
        data = res.get_json()
        self.assertFalse(data.get("success", True))
        self.assertEqual(data.get("status"), "ARBITRAGE_UNAVAILABLE")
        self.assertEqual(data.get("message"), "Arbitrage unavailable: fewer than two valid DEX routers configured.")

    def test_execute_atomic_trade_rejects_identical_routers_on_multirouter_chain(self):
        """Requirement 3: execute_atomic_trade() rejects identical router addresses even on 2+ router chain."""
        # On chain 8453 (which has 2 valid routers), test plan with identical resolved router addresses
        same_addr = "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24"
        plan = {
            "chain_id": 8453,
            "buy_dex": "Uniswap_V2",
            "sell_dex": "SushiSwap_V2",
            "amount_in": 5.0,
            "net_profit_usdt": 1.0,
        }
        # Simulate registry returning identical router for both DEXes
        mock_registry = dict(config.CHAIN_REGISTRY)
        mock_registry[8453] = dict(mock_registry[8453])
        mock_registry[8453]["routers"] = {
            "Uniswap_V2": same_addr,
            "SushiSwap_V2": same_addr.lower(),
        }
        from unittest.mock import patch
        with patch.dict(config.CHAIN_REGISTRY, mock_registry):
            res = execute_atomic_trade(plan)
            self.assertFalse(res.get("success", False))
            self.assertEqual(res.get("status"), "ARBITRAGE_UNAVAILABLE")
            self.assertEqual(res.get("message"), "Arbitrage unavailable: fewer than two valid DEX routers configured.")

    def test_execute_atomic_trade_rejects_buy_dex_equals_sell_dex(self):
        """Requirement 4: execute_atomic_trade() rejects buy_dex == sell_dex."""
        plan = {
            "chain_id": 8453,
            "buy_dex": "Uniswap_V2",
            "sell_dex": "Uniswap_V2",
            "amount_in": 5.0,
            "net_profit_usdt": 1.0,
        }
        res = execute_atomic_trade(plan)
        self.assertFalse(res.get("success", False))
        self.assertEqual(res.get("status"), "ARBITRAGE_UNAVAILABLE")
        self.assertEqual(res.get("message"), "Arbitrage unavailable: fewer than two valid DEX routers configured.")

    def test_valid_multirouter_execution_passes_router_guard(self):
        """Requirement 5: Existing valid multi-router execution passes Guard 1b without error."""
        plan = {
            "chain_id": 8453,
            "buy_dex": "Uniswap_V2",
            "sell_dex": "SushiSwap_V2",
            "amount_in": 5.0,
            "net_profit_usdt": 1.0,
            "gross_return_usdt": 6.0,
        }
        res = execute_atomic_trade(plan)
        # Should NOT fail with ARBITRAGE_UNAVAILABLE
        self.assertNotEqual(res.get("status"), "ARBITRAGE_UNAVAILABLE")
        self.assertNotEqual(res.get("message"), "Arbitrage unavailable: fewer than two valid DEX routers configured.")


if __name__ == "__main__":
    unittest.main()
