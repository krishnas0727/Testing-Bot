import unittest
from unittest.mock import patch

import config
from live_verification import get_live_verification_status, run_live_verification


class DEXLiveVerificationTests(unittest.TestCase):
    def test_verification_status_structure(self):
        status = get_live_verification_status()
        self.assertIn("enabled", status)
        self.assertIn("trading_mode", status)
        self.assertIn("rpc_connected", status)
        self.assertIn("supported_dexes", status)
        self.assertIn("Uniswap_V2", status["supported_dexes"])
        self.assertIn("SushiSwap_V2", status["supported_dexes"])

    def test_run_verification_requires_explicit_confirmation(self):
        res = run_live_verification(explicit_confirmation=False)
        self.assertFalse(res["success"])
        self.assertEqual(res["status"], "BLOCKED")

    def test_run_verification_succeeds_with_confirmation(self):
        res = run_live_verification(
            buy_dex="Uniswap_V2",
            sell_dex="SushiSwap_V2",
            amount=100.0,
            explicit_confirmation=True,
        )
        self.assertTrue(res["success"])
        self.assertEqual(res["verification_status"], "VERIFIED")
        self.assertIn("rpc_status", res)
        self.assertIn("wallet_status", res)
        self.assertIn("simulation", res)


if __name__ == "__main__":
    unittest.main()
