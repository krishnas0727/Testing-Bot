"""Unit tests for rewritten on-chain treasury withdrawal execution (TASK 2).

Covers:
- success with withdrawToken and EIP-1559 fees + raw_transaction
- signer not owner rejected
- gas estimate failure sends nothing
- amount above balance rejected
- no call to non-existent withdraw(address, uint256, address)
"""

import unittest
from unittest.mock import patch, MagicMock
from hexbytes import HexBytes

import config
import treasury_execution


class TestTreasuryExecutionRewrite(unittest.TestCase):
    OWNER_ADDR = "0x5555555555555555555555555555555555555555"
    NON_OWNER_ADDR = "0x9999999999999999999999999999999999999999"
    CONTRACT_ADDR = "0x1111111111111111111111111111111111111111"
    TOKEN_ADDR = "0x2222222222222222222222222222222222222222"
    DUMMY_PK = "0x" + "a" * 64

    def setUp(self):
        self.chain_id = 8453
        config.CHAIN_REGISTRY[self.chain_id] = {
            "name": "base",
            "rpc_url": "https://base.dummy.rpc",
            "tokens": {
                "USDC": {
                    "address": self.TOKEN_ADDR,
                    "decimals": 6,
                    "symbol": "USDC"
                }
            }
        }

    def _setup_mock_web3(self, owner=None, token_balance=100.0, estimate_gas_side_effect=None):
        if owner is None:
            owner = self.OWNER_ADDR

        mock_w3 = MagicMock()
        mock_w3.is_connected.return_value = True

        # Latest block for EIP-1559 baseFeePerGas
        mock_w3.eth.get_block.return_value = {"baseFeePerGas": 10_000_000_000}
        mock_w3.eth.max_priority_fee = 1_000_000_000
        mock_w3.eth.get_transaction_count.return_value = 5

        # Gas estimate
        if estimate_gas_side_effect:
            mock_w3.eth.estimate_gas.side_effect = estimate_gas_side_effect
        else:
            mock_w3.eth.estimate_gas.return_value = 85000

        # Sign transaction mock
        mock_signed = MagicMock()
        mock_signed.raw_transaction = b"\x01\x02\x03\x04"
        # Ensure rawTransaction is NOT accessed
        del mock_signed.rawTransaction
        mock_w3.eth.account.sign_transaction.return_value = mock_signed

        # Send raw tx
        mock_tx_hash = HexBytes("0x" + "c" * 64)
        mock_w3.eth.send_raw_transaction.return_value = mock_tx_hash

        # Receipt
        mock_w3.eth.wait_for_transaction_receipt.return_value = {
            "status": 1,
            "blockNumber": 123456,
            "gasUsed": 65000
        }

        # Mock contracts
        def contract_factory(address, abi):
            mock_contract = MagicMock()
            # Token ERC20 balanceOf
            raw_bal = int(token_balance * 10**6)
            mock_contract.functions.balanceOf.return_value.call.return_value = raw_bal
            # DexArbitrage owner
            mock_contract.functions.owner.return_value.call.return_value = owner

            # withdrawToken build_transaction
            mock_tx_built = {
                "from": owner,
                "nonce": 5,
                "gasPrice": 0,
                "chainId": self.chain_id
            }
            mock_contract.functions.withdrawToken.return_value.build_transaction.return_value = mock_tx_built

            # Ensure withdraw(address, uint256, address) does not exist!
            del mock_contract.functions.withdraw
            return mock_contract

        mock_w3.eth.contract.side_effect = contract_factory
        return mock_w3

    @patch("eth_account.Account.from_key")
    @patch("treasury_execution.Web3")
    def test_withdrawal_success(self, mock_web3_cls, mock_acct_cls):
        """Test successful withdrawal using withdrawToken and raw_transaction."""
        mock_acct = MagicMock()
        mock_acct.address = self.OWNER_ADDR
        mock_acct_cls.return_value = mock_acct

        mock_w3 = self._setup_mock_web3(owner=self.OWNER_ADDR, token_balance=50.0)
        mock_web3_cls.return_value = mock_w3
        mock_web3_cls.to_checksum_address = lambda a: a

        res = treasury_execution.submit_blockchain_withdrawal(
            contract_address=self.CONTRACT_ADDR,
            private_key=self.DUMMY_PK,
            token_symbol="USDC",
            amount=20.0,
            recipient=self.OWNER_ADDR,
            chain_id=self.chain_id
        )

        self.assertTrue(res["success"])
        self.assertEqual(res["status"], "CONFIRMED")
        self.assertEqual(len(res["tx_hash"]), 66)
        self.assertTrue(res["tx_hash"].startswith("0x"))
        mock_w3.eth.send_raw_transaction.assert_called_once_with(b"\x01\x02\x03\x04")

    @patch("eth_account.Account.from_key")
    @patch("treasury_execution.Web3")
    def test_withdrawal_signer_not_owner_rejected(self, mock_web3_cls, mock_acct_cls):
        """Signer is not owner -> rejected with clear error without broadcasting."""
        mock_acct = MagicMock()
        mock_acct.address = self.NON_OWNER_ADDR
        mock_acct_cls.return_value = mock_acct

        mock_w3 = self._setup_mock_web3(owner=self.OWNER_ADDR, token_balance=50.0)
        mock_web3_cls.return_value = mock_w3
        mock_web3_cls.to_checksum_address = lambda a: a

        res = treasury_execution.submit_blockchain_withdrawal(
            contract_address=self.CONTRACT_ADDR,
            private_key=self.DUMMY_PK,
            token_symbol="USDC",
            amount=10.0,
            recipient=self.OWNER_ADDR,
            chain_id=self.chain_id
        )

        self.assertFalse(res["success"])
        self.assertEqual(res["status"], "UNAUTHORIZED_SIGNER")
        self.assertIn("not the contract owner", res["message"])
        mock_w3.eth.send_raw_transaction.assert_not_called()

    @patch("eth_account.Account.from_key")
    @patch("treasury_execution.Web3")
    def test_withdrawal_gas_estimate_failure_sends_nothing(self, mock_web3_cls, mock_acct_cls):
        """estimate_gas failure returns GAS_ESTIMATION_FAILED and sends nothing."""
        mock_acct = MagicMock()
        mock_acct.address = self.OWNER_ADDR
        mock_acct_cls.return_value = mock_acct

        mock_w3 = self._setup_mock_web3(
            owner=self.OWNER_ADDR,
            token_balance=50.0,
            estimate_gas_side_effect=Exception("execution reverted: Mock reverted")
        )
        mock_web3_cls.return_value = mock_w3
        mock_web3_cls.to_checksum_address = lambda a: a

        res = treasury_execution.submit_blockchain_withdrawal(
            contract_address=self.CONTRACT_ADDR,
            private_key=self.DUMMY_PK,
            token_symbol="USDC",
            amount=10.0,
            recipient=self.OWNER_ADDR,
            chain_id=self.chain_id
        )

        self.assertFalse(res["success"])
        self.assertEqual(res["status"], "GAS_ESTIMATION_FAILED")
        self.assertIn("Gas estimation failed", res["message"])
        # Invariant: Never send or broadcast if gas estimation fails
        mock_w3.eth.send_raw_transaction.assert_not_called()

    @patch("eth_account.Account.from_key")
    @patch("treasury_execution.Web3")
    def test_withdrawal_amount_above_balance_rejected(self, mock_web3_cls, mock_acct_cls):
        """Withdrawal amount exceeding contract token balance is rejected."""
        mock_acct = MagicMock()
        mock_acct.address = self.OWNER_ADDR
        mock_acct_cls.return_value = mock_acct

        # Contract has 5.0 USDC, but requested withdrawal is 20.0 USDC
        mock_w3 = self._setup_mock_web3(owner=self.OWNER_ADDR, token_balance=5.0)
        mock_web3_cls.return_value = mock_w3
        mock_web3_cls.to_checksum_address = lambda a: a

        res = treasury_execution.submit_blockchain_withdrawal(
            contract_address=self.CONTRACT_ADDR,
            private_key=self.DUMMY_PK,
            token_symbol="USDC",
            amount=20.0,
            recipient=self.OWNER_ADDR,
            chain_id=self.chain_id
        )

        self.assertFalse(res["success"])
        self.assertEqual(res["status"], "INSUFFICIENT_CONTRACT_BALANCE")
        self.assertIn("Contract token balance", res["message"])
        mock_w3.eth.send_raw_transaction.assert_not_called()

    @patch("eth_account.Account.from_key")
    @patch("treasury_execution.Web3")
    def test_no_call_to_nonexistent_withdraw_function(self, mock_web3_cls, mock_acct_cls):
        """Verify withdrawToken is called and non-existent withdraw(address,uint256,address) is never called."""
        mock_acct = MagicMock()
        mock_acct.address = self.OWNER_ADDR
        mock_acct_cls.return_value = mock_acct

        mock_w3 = self._setup_mock_web3(owner=self.OWNER_ADDR, token_balance=50.0)
        mock_web3_cls.return_value = mock_w3
        mock_web3_cls.to_checksum_address = lambda a: a

        res = treasury_execution.submit_blockchain_withdrawal(
            contract_address=self.CONTRACT_ADDR,
            private_key=self.DUMMY_PK,
            token_symbol="USDC",
            amount=10.0,
            recipient=self.OWNER_ADDR,
            chain_id=self.chain_id
        )

        self.assertTrue(res["success"])
        # Ensure DEX_ARBITRAGE_ABI has withdrawToken and does not contain 3-arg withdraw
        abi_func_names = [f["name"] for f in treasury_execution.DEX_ARBITRAGE_ABI if f.get("type") == "function"]
        self.assertIn("withdrawToken", abi_func_names)
        self.assertNotIn("withdraw", abi_func_names)


if __name__ == "__main__":
    unittest.main()
