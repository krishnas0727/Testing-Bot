"""Real Blockchain Treasury Withdrawal Module.

Executes genuine on-chain withdrawals from deployed Treasury or DexArbitrage smart contracts.
Strictly adheres to Phase 5 requirements:
- Validates token, recipient, amount
- Validates contract token balance on-chain
- Submits actual signed transaction to Web3 RPC
- Waits for receipt and verifies EVM status == 0x1
- Never invents fake transaction hashes
"""

import time
import math
from typing import Dict, Any, Optional

try:
    from web3 import Web3
    _HAS_WEB3 = True
except ImportError:
    _HAS_WEB3 = False

import config

ERC20_ABI = [
    {
        "constant": True,
        "inputs": [{"name": "_owner", "type": "address"}],
        "name": "balanceOf",
        "outputs": [{"name": "balance", "type": "uint256"}],
        "type": "function"
    },
    {
        "constant": True,
        "inputs": [],
        "name": "decimals",
        "outputs": [{"name": "", "type": "uint8"}],
        "type": "function"
    }
]

TREASURY_WITHDRAW_ABI = [
    {
        "inputs": [
            {"internalType": "address", "name": "token", "type": "address"},
            {"internalType": "uint256", "name": "amount", "type": "uint256"},
            {"internalType": "address", "name": "recipient", "type": "address"}
        ],
        "name": "withdraw",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [
            {"internalType": "address", "name": "token", "type": "address"},
            {"internalType": "uint256", "name": "amount", "type": "uint256"}
        ],
        "name": "withdrawToken",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    }
]


def check_contract_balance(
    w3: "Web3",
    contract_address: str,
    token_address: str,
    decimals: int = 18
) -> float:
    """Query on-chain ERC20 token balance held by the contract."""
    try:
        if token_address == "0x0000000000000000000000000000000000000000" or token_address.lower() == "eth":
            raw_bal = w3.eth.get_balance(Web3.to_checksum_address(contract_address))
            return float(raw_bal) / 1e18

        token_contract = w3.eth.contract(
            address=Web3.to_checksum_address(token_address),
            abi=ERC20_ABI
        )
        raw_bal = token_contract.functions.balanceOf(Web3.to_checksum_address(contract_address)).call()
        return float(raw_bal) / (10 ** decimals)
    except Exception as e:
        print(f"⚠️ Error querying contract balance: {e}", flush=True)
        return 0.0


def submit_blockchain_withdrawal(
    contract_address: str,
    private_key: str,
    token_symbol: str,
    amount: float,
    recipient: str,
    chain_id: int
) -> Dict[str, Any]:
    """Submit a real on-chain withdrawal transaction, wait for receipt, and verify success."""
    if not _HAS_WEB3:
        return {
            "success": False,
            "status": "MISSING_DEPENDENCY",
            "message": "web3 library is not installed."
        }

    chain_info = config.CHAIN_REGISTRY.get(chain_id, {})
    rpc_url = chain_info.get("rpc_url") or config.RPC_URL
    w3 = Web3(Web3.HTTPProvider(rpc_url, request_kwargs={"timeout": 15}))
    if not w3.is_connected():
        return {
            "success": False,
            "status": "RPC_DISCONNECTED",
            "message": f"Could not connect to blockchain RPC at {rpc_url}."
        }

    try:
        from eth_account import Account
        acct = Account.from_key(private_key)
        signer_address = acct.address
    except Exception as e:
        return {
            "success": False,
            "status": "INVALID_SIGNER_KEY",
            "message": f"Invalid signing private key: {e}"
        }

    chain_info = config.CHAIN_REGISTRY.get(chain_id, {})
    tokens_map = chain_info.get("tokens", {})
    token_info = tokens_map.get(token_symbol, {})
    token_address = token_info.get("address", "")
    decimals = int(token_info.get("decimals", 18 if token_symbol == "WETH" else 6))

    if not token_address and token_symbol not in ("ETH", "NATIVE"):
        return {
            "success": False,
            "status": "TOKEN_NOT_FOUND",
            "message": f"Token contract address for {token_symbol} not found on chain {chain_id}."
        }

    # Verify contract balance on-chain
    contract_bal = check_contract_balance(w3, contract_address, token_address, decimals)
    if contract_bal < amount:
        return {
            "success": False,
            "status": "INSUFFICIENT_CONTRACT_BALANCE",
            "message": (
                f"Contract token balance ({contract_bal:.4f} {token_symbol}) is less than "
                f"requested withdrawal amount ({amount:.4f} {token_symbol})."
            )
        }

    amount_raw = int(amount * (10 ** decimals))
    contract = w3.eth.contract(address=Web3.to_checksum_address(contract_address), abi=TREASURY_WITHDRAW_ABI)

    try:
        # Build transaction (try 3-arg withdraw(token, amount, recipient) or 2-arg withdrawToken)
        nonce = w3.eth.get_transaction_count(signer_address, "pending")
        gas_price = w3.eth.gas_price

        # Check function existence
        tx_data = None
        try:
            tx_data = contract.functions.withdraw(
                Web3.to_checksum_address(token_address),
                amount_raw,
                Web3.to_checksum_address(recipient)
            ).build_transaction({
                "from": signer_address,
                "nonce": nonce,
                "gasPrice": gas_price,
                "chainId": chain_id
            })
        except Exception:
            tx_data = contract.functions.withdrawToken(
                Web3.to_checksum_address(token_address),
                amount_raw
            ).build_transaction({
                "from": signer_address,
                "nonce": nonce,
                "gasPrice": gas_price,
                "chainId": chain_id
            })

        # Estimate gas
        try:
            estimated_gas = w3.eth.estimate_gas(tx_data)
            tx_data["gas"] = int(estimated_gas * 1.3)
        except Exception:
            tx_data["gas"] = 150000

        # Sign transaction
        signed_tx = w3.eth.account.sign_transaction(tx_data, private_key)
        # Broadcast transaction
        tx_hash_bytes = w3.eth.send_raw_transaction(signed_tx.rawTransaction)
        real_tx_hash = "0x" + tx_hash_bytes.hex().lower().removeprefix("0x")

        # Wait for receipt
        receipt = w3.eth.wait_for_transaction_receipt(real_tx_hash, timeout=30)
        status_val = receipt.get("status")
        is_success = (status_val == 1 or status_val == "0x1" or status_val is True)

        if not is_success:
            return {
                "success": False,
                "status": "FAILED",
                "tx_hash": real_tx_hash,
                "message": f"Withdrawal transaction {real_tx_hash} reverted on-chain (status 0x0)."
            }

        return {
            "success": True,
            "status": "CONFIRMED",
            "tx_hash": real_tx_hash,
            "block_number": receipt.get("blockNumber"),
            "gas_used": receipt.get("gasUsed")
        }

    except Exception as exc:
        return {
            "success": False,
            "status": "FAILED",
            "message": f"Blockchain transaction execution error: {str(exc)}"
        }
