"""DEX Contract ABI and Smart Contract Interface.

Provides complete ABI definitions, 4-byte selectors, and encoding/decoding
utilities for Uniswap V2, SushiSwap V2, ERC-20 tokens, and DexArbitrage.sol.
"""
import json
from typing import Dict, Any, List

# ============================================================
# ERC-20 ABI
# ============================================================
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
    },
    {
        "constant": True,
        "inputs": [],
        "name": "symbol",
        "outputs": [{"name": "", "type": "string"}],
        "type": "function"
    },
    {
        "constant": True,
        "inputs": [
            {"name": "_owner", "type": "address"},
            {"name": "_spender", "type": "address"}
        ],
        "name": "allowance",
        "outputs": [{"name": "remaining", "type": "uint256"}],
        "type": "function"
    },
    {
        "constant": False,
        "inputs": [
            {"name": "_spender", "type": "address"},
            {"name": "_value", "type": "uint256"}
        ],
        "name": "approve",
        "outputs": [{"name": "success", "type": "bool"}],
        "type": "function"
    },
    {
        "constant": False,
        "inputs": [
            {"name": "_to", "type": "address"},
            {"name": "_value", "type": "uint256"}
        ],
        "name": "transfer",
        "outputs": [{"name": "success", "type": "bool"}],
        "type": "function"
    }
]

# ============================================================
# UNISWAP / SUSHISWAP V2 PAIR ABI
# ============================================================
UNISWAP_V2_PAIR_ABI = [
    {
        "constant": True,
        "inputs": [],
        "name": "getReserves",
        "outputs": [
            {"name": "_reserve0", "type": "uint112"},
            {"name": "_reserve1", "type": "uint112"},
            {"name": "_blockTimestampLast", "type": "uint32"}
        ],
        "payable": False,
        "stateMutability": "view",
        "type": "function"
    },
    {
        "constant": True,
        "inputs": [],
        "name": "token0",
        "outputs": [{"name": "", "type": "address"}],
        "payable": False,
        "stateMutability": "view",
        "type": "function"
    },
    {
        "constant": True,
        "inputs": [],
        "name": "token1",
        "outputs": [{"name": "", "type": "address"}],
        "payable": False,
        "stateMutability": "view",
        "type": "function"
    }
]

# ============================================================
# UNISWAP / SUSHISWAP V2 ROUTER ABI
# ============================================================
UNISWAP_V2_ROUTER_ABI = [
    {
        "inputs": [
            {"internalType": "uint256", "name": "amountIn", "type": "uint256"},
            {"internalType": "address[]", "name": "path", "type": "address[]"}
        ],
        "name": "getAmountsOut",
        "outputs": [
            {"internalType": "uint256[]", "name": "amounts", "type": "uint256[]"}
        ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [
            {"internalType": "uint256", "name": "amountIn", "type": "uint256"},
            {"internalType": "uint256", "name": "amountOutMin", "type": "uint256"},
            {"internalType": "address[]", "name": "path", "type": "address[]"},
            {"internalType": "address", "name": "to", "type": "address"},
            {"internalType": "uint256", "name": "deadline", "type": "uint256"}
        ],
        "name": "swapExactTokensForTokens",
        "outputs": [
            {"internalType": "uint256[]", "name": "amounts", "type": "uint256[]"}
        ],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "factory",
        "outputs": [{"internalType": "address", "name": "", "type": "address"}],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "WETH",
        "outputs": [{"internalType": "address", "name": "", "type": "address"}],
        "stateMutability": "view",
        "type": "function"
    }
]

# ============================================================
# UNISWAP / SUSHISWAP V2 FACTORY ABI
# ============================================================
UNISWAP_V2_FACTORY_ABI = [
    {
        "inputs": [
            {"internalType": "address", "name": "tokenA", "type": "address"},
            {"internalType": "address", "name": "tokenB", "type": "address"}
        ],
        "name": "getPair",
        "outputs": [{"internalType": "address", "name": "pair", "type": "address"}],
        "stateMutability": "view",
        "type": "function"
    }
]

# ============================================================
# DEX ARBITRAGE SMART CONTRACT ABI
# ============================================================
DEX_ARBITRAGE_ABI = [
    {
        "inputs": [],
        "stateMutability": "nonpayable",
        "type": "constructor"
    },
    {
        "inputs": [
            {
                "components": [
                    {"internalType": "address", "name": "routerBuy", "type": "address"},
                    {"internalType": "address", "name": "routerSell", "type": "address"},
                    {"internalType": "address", "name": "tokenIn", "type": "address"},
                    {"internalType": "address", "name": "tokenOut", "type": "address"},
                    {"internalType": "uint256", "name": "amountIn", "type": "uint256"},
                    {"internalType": "uint256", "name": "minProfit", "type": "uint256"},
                    {"internalType": "uint256", "name": "deadline", "type": "uint256"}
                ],
                "internalType": "struct DexArbitrage.ArbitrageParams",
                "name": "params",
                "type": "tuple"
            }
        ],
        "name": "executeArbitrage",
        "outputs": [{"internalType": "uint256", "name": "netProfit", "type": "uint256"}],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [
            {
                "components": [
                    {"internalType": "address", "name": "routerBuy", "type": "address"},
                    {"internalType": "address", "name": "routerSell", "type": "address"},
                    {"internalType": "address", "name": "tokenIn", "type": "address"},
                    {"internalType": "address", "name": "tokenOut", "type": "address"},
                    {"internalType": "uint256", "name": "amountIn", "type": "uint256"},
                    {"internalType": "uint256", "name": "minProfit", "type": "uint256"},
                    {"internalType": "uint256", "name": "deadline", "type": "uint256"}
                ],
                "internalType": "struct DexArbitrage.ArbitrageParams",
                "name": "params",
                "type": "tuple"
            }
        ],
        "name": "simulateArbitrage",
        "outputs": [
            {"internalType": "bool", "name": "profitable", "type": "bool"},
            {"internalType": "uint256", "name": "expectedProfit", "type": "uint256"},
            {"internalType": "uint256", "name": "leg1Output", "type": "uint256"},
            {"internalType": "uint256", "name": "leg2Output", "type": "uint256"}
        ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "owner",
        "outputs": [{"internalType": "address", "name": "", "type": "address"}],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "paused",
        "outputs": [{"internalType": "bool", "name": "", "type": "bool"}],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "togglePause",
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
    },
    {
        "inputs": [],
        "name": "withdrawETH",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    }
]

# ============================================================
# FUNCTION SELECTORS & HELPERS
# ============================================================

# Keccak-256 4-byte function selectors
SELECTOR_GET_RESERVES = "0x0902f1ac"
SELECTOR_GET_AMOUNTS_OUT = "0xd06ca61f"
SELECTOR_SWAP_EXACT_TOKENS = "0x38ed1739"
SELECTOR_GET_PAIR = "0xe6a43905"
SELECTOR_BALANCE_OF = "0x70a08231"
SELECTOR_DECIMALS = "0x313ce567"
SELECTOR_SYMBOL = "0x95d89b41"
SELECTOR_ALLOWANCE = "0xdd62ed3e"
SELECTOR_APPROVE = "0x095ea7b3"
SELECTOR_SIMULATE_ARBITRAGE = "0x973a8f5c"
SELECTOR_EXECUTE_ARBITRAGE = "0x7593c20c"


def pad_address(address: str) -> str:
    """Pad an EVM address to 32 bytes (64 hex characters)."""
    clean = address.lower().replace("0x", "").strip()
    return clean.rjust(64, "0")


def pad_uint256(value: int) -> str:
    """Pad an integer to 32 bytes (64 hex characters)."""
    h = hex(int(value)).replace("0x", "")
    return h.rjust(64, "0")


def encode_balance_of(account: str) -> str:
    """Encode calldata for ERC20 balanceOf(address)."""
    return SELECTOR_BALANCE_OF + pad_address(account)


def encode_allowance(owner: str, spender: str) -> str:
    """Encode calldata for ERC20 allowance(address,address)."""
    return SELECTOR_ALLOWANCE + pad_address(owner) + pad_address(spender)


def encode_approve(spender: str, amount: int) -> str:
    """Encode calldata for ERC20 approve(address,uint256)."""
    return SELECTOR_APPROVE + pad_address(spender) + pad_uint256(amount)


def encode_get_pair(tokenA: str, tokenB: str) -> str:
    """Encode calldata for IUniswapV2Factory getPair(address,address)."""
    return SELECTOR_GET_PAIR + pad_address(tokenA) + pad_address(tokenB)


def decode_get_reserves(hex_data: str):
    """Decode returned data from getReserves() -> (reserve0, reserve1, blockTimestampLast)."""
    clean = hex_data.replace("0x", "")
    if len(clean) < 192:
        return None
    r0 = int(clean[0:64], 16)
    r1 = int(clean[64:128], 16)
    ts = int(clean[128:192], 16)
    return r0, r1, ts


def decode_uint256(hex_data: str) -> int:
    """Decode a single uint256 from return data."""
    clean = hex_data.replace("0x", "")
    if not clean:
        return 0
    return int(clean[-64:], 16)


def decode_address(hex_data: str) -> str:
    """Decode an EVM address from 32-byte word."""
    clean = hex_data.replace("0x", "")
    if len(clean) < 40:
        return "0x0000000000000000000000000000000000000000"
    return "0x" + clean[-40:]
