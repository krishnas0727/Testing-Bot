import unittest
from unittest.mock import patch
import os
from pathlib import Path

import config
from dex_contract import (
    DEX_ARBITRAGE_ABI,
    UNISWAP_V2_ROUTER_ABI,
    UNISWAP_V2_PAIR_ABI,
    ERC20_ABI,
    pad_address,
    pad_uint256,
    decode_get_reserves,
    decode_uint256,
    decode_address,
)
from dex_flashloan import build_plan, validate_plan, execute_atomic_flashloan


class DEXContractTests(unittest.TestCase):
    def setUp(self):
        self._orig_mode = config.TRADING_MODE
        self._orig_stop = config.EMERGENCY_STOP
        config.TRADING_MODE = "MOCK"
        config.EMERGENCY_STOP = False

    def tearDown(self):
        config.TRADING_MODE = self._orig_mode
        config.EMERGENCY_STOP = self._orig_stop

    def test_solidity_contract_file_exists(self):
        root = Path(__file__).resolve().parents[1]
        contract_file = root / "contracts" / "DexArbitrage.sol"
        self.assertTrue(contract_file.exists())
        content = contract_file.read_text(encoding="utf-8")
        self.assertIn("contract DexArbitrage", content)
        self.assertIn("executeArbitrage", content)
        self.assertIn("simulateArbitrage", content)
        self.assertIn("UnprofitableArbitrage", content)

    def test_abi_definitions_contain_required_functions(self):
        arb_fn_names = [x["name"] for x in DEX_ARBITRAGE_ABI if x.get("type") == "function"]
        self.assertIn("executeArbitrage", arb_fn_names)
        self.assertIn("simulateArbitrage", arb_fn_names)
        self.assertIn("togglePause", arb_fn_names)
        self.assertIn("withdrawToken", arb_fn_names)

        router_fn_names = [x["name"] for x in UNISWAP_V2_ROUTER_ABI if x.get("type") == "function"]
        self.assertIn("swapExactTokensForTokens", router_fn_names)
        self.assertIn("getAmountsOut", router_fn_names)

        pair_fn_names = [x["name"] for x in UNISWAP_V2_PAIR_ABI if x.get("type") == "function"]
        self.assertIn("getReserves", pair_fn_names)

    def test_evm_encoding_helpers(self):
        addr = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D"
        padded_addr = pad_address(addr)
        self.assertEqual(len(padded_addr), 64)
        self.assertTrue(padded_addr.endswith(addr.lower().replace("0x", "")))

        val = 1000000
        padded_val = pad_uint256(val)
        self.assertEqual(len(padded_val), 64)
        self.assertEqual(int(padded_val, 16), val)

    def test_decode_reserves(self):
        # Sample encoded response for 10 WETH (10 * 1e18) and 30,000 USDT (30000 * 1e6)
        r0 = 10 * 10**18
        r1 = 30000 * 10**6
        ts = 1700000000
        hex_str = pad_uint256(r0) + pad_uint256(r1) + pad_uint256(ts)
        decoded = decode_get_reserves("0x" + hex_str)
        self.assertIsNotNone(decoded)
        dec_r0, dec_r1, dec_ts = decoded
        self.assertEqual(dec_r0, r0)
        self.assertEqual(dec_r1, r1)
        self.assertEqual(dec_ts, ts)

    def test_flashloan_plan_validation(self):
        # Valid plan
        res_valid = build_plan(
            asset="WETH",
            amount=1.0,
            buy_dex="Uniswap_V2",
            sell_dex="SushiSwap_V2",
            expected_profit_usdt=5.0,
            gas_budget_usdt=1.0,
            slippage_pct=0.50
        )
        self.assertTrue(res_valid["valid"])

        # Invalid plan: buy and sell are same DEX
        res_invalid = build_plan(
            asset="WETH",
            amount=1.0,
            buy_dex="Uniswap_V2",
            sell_dex="Uniswap_V2",
            expected_profit_usdt=5.0,
            gas_budget_usdt=1.0
        )
        self.assertFalse(res_invalid["valid"])
        self.assertTrue(any("different" in e.lower() for e in res_invalid["errors"]))

    def test_execute_atomic_flashloan_in_mock_mode(self):
        with patch.object(config, "EMERGENCY_STOP", False):
            res = execute_atomic_flashloan({"amount": 100.0})
            self.assertTrue(res["success"])
            self.assertEqual(res["status"], "MOCK_FLASHLOAN_SIMULATED")



if __name__ == "__main__":
    unittest.main()
