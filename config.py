# ============================================================
# DEX-ONLY ARBITRAGE TERMINAL CONFIGURATION
# 100% Decentralized Web3 & Smart-Contract Trading Engine
# ============================================================

import os
from typing import Dict, Any, Optional, List, Tuple

# ============================================================
# BASE & DATA DIRECTORIES
# ============================================================

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

DATA_DIR = (
    os.environ.get("DATA_DIR")
    or os.path.join(BASE_DIR, "data")
)

os.makedirs(DATA_DIR, exist_ok=True)

DATABASE_NAME = (
    os.environ.get("DATABASE_PATH")
    or os.path.join(DATA_DIR, "trades.db")
)

BACKUP_JSON_PATH = os.path.join(
    DATA_DIR,
    "trades_history_backup.json"
)

AUTO_TRADER_LOCK_PATH = os.getenv(
    "AUTO_TRADER_LOCK_PATH",
    os.path.join(DATA_DIR, "auto_trader.lock")
)


# ============================================================
# DECENTRALIZED EXCHANGES (DEX)
# ============================================================

SUPPORTED_DEXES = [
    "Uniswap_V2",
    "SushiSwap_V2",
]


# ============================================================
# BLOCKCHAIN & WEB3 RPC CONFIGURATION
# ============================================================

DEFAULT_CHAIN = os.getenv("DEFAULT_CHAIN", "base")
CHAIN_ID = int(os.getenv("CHAIN_ID", "11155111"))

# Primary and fallback public JSON-RPC endpoints
RPC_URL = os.getenv("RPC_URL", "https://ethereum-sepolia-rpc.publicnode.com")

PUBLIC_RPC_FALLBACKS = {
    8453: [
        "https://mainnet.base.org",
        "https://base.llamarpc.com",
        "https://1rpc.io/base",
        "https://base-rpc.publicnode.com",
        "https://base.drpc.org",
        "https://base.blockpi.network/v1/rpc/public",
    ],
    1: [
        "https://ethereum-rpc.publicnode.com",
        "https://rpc.mevblocker.io",
        "https://eth.merkle.io",
        "https://nodes.mewapi.io/rpc/eth",
        "https://rpc.flashbots.net",
    ],
    42161: [
        "https://arbitrum-one-rpc.publicnode.com",
        "https://arb1.arbitrum.io/rpc",
    ],
    137: [
        "https://polygon-bor-rpc.publicnode.com",
        "https://polygon-rpc.com",
    ],
    11155111: [
        "https://ethereum-sepolia-rpc.publicnode.com",
        "https://rpc.sepolia.org",
    ],
    84532: [
        "https://sepolia.base.org",
        "https://base-sepolia-rpc.publicnode.com",
        "https://base-sepolia.blockpi.network/v1/rpc/public",
        "https://1rpc.io/base-sepolia",
    ],
}


# ============================================================
# MULTI-CHAIN SPECIFICATIONS & REGISTRY
# ============================================================

CHAIN_REGISTRY: Dict[int, Dict[str, Any]] = {
    8453: {
        "name": "base",
        "label": "Base L2 Mainnet",
        "chain_id": 8453,
        "is_testnet": False,
        "currency": "ETH",
        "explorer": "https://basescan.org",
        "rpc_url": "https://mainnet.base.org",
        "fallbacks": [
            "https://mainnet.base.org",
            "https://base.llamarpc.com",
            "https://1rpc.io/base",
            "https://base-rpc.publicnode.com",
            "https://base.drpc.org",
            "https://base.blockpi.network/v1/rpc/public",
        ],
        "dexes": ["Uniswap_V2", "SushiSwap_V2"],
        "routers": {
            "Uniswap_V2": "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
            "SushiSwap_V2": "0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891",
        },
        "factories": {
            "Uniswap_V2": "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6",
            "SushiSwap_V2": "0x71524b4f93c58fcbf659783284e38825f0622859",
        },
        "tokens": {
            "WETH": {"address": "0x4200000000000000000000000000000000000006", "decimals": 18, "symbol": "WETH"},
            "USDC": {"address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "decimals": 6, "symbol": "USDC"},
            "USDT": {"address": "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", "decimals": 6, "symbol": "USDT"},
            "DAI": {"address": "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", "decimals": 18, "symbol": "DAI"},
            "USDbC": {"address": "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", "decimals": 6, "symbol": "USDbC"},
        },
        "pairs": ["WETH/USDC", "WETH/USDT", "WETH/DAI"],
        "default_symbol": "WETH/USDC",
        "arbitrage_contract": os.getenv("BASE_ARBITRAGE_CONTRACT", os.getenv("ARBITRAGE_CONTRACT_ADDRESS", ""))
    },
    1: {
        "name": "ethereum",
        "label": "Ethereum Mainnet",
        "chain_id": 1,
        "is_testnet": False,
        "currency": "ETH",
        "explorer": "https://etherscan.io",
        "rpc_url": "https://ethereum-rpc.publicnode.com",
        "fallbacks": [
            "https://ethereum-rpc.publicnode.com",
            "https://rpc.mevblocker.io",
            "https://eth.merkle.io",
            "https://nodes.mewapi.io/rpc/eth",
            "https://rpc.flashbots.net",
        ],
        "dexes": ["Uniswap_V2", "SushiSwap_V2"],
        "routers": {
            "Uniswap_V2": "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
            "SushiSwap_V2": "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F",
        },
        "factories": {
            "Uniswap_V2": "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f",
            "SushiSwap_V2": "0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac",
        },
        "tokens": {
            "WETH": {"address": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", "decimals": 18, "symbol": "WETH"},
            "USDT": {"address": "0xdAC17F958D2ee523a2206206994597C13D831ec7", "decimals": 6, "symbol": "USDT"},
            "USDC": {"address": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "decimals": 6, "symbol": "USDC"},
            "WBTC": {"address": "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", "decimals": 8, "symbol": "WBTC"},
            "DAI": {"address": "0x6B175474E89094C44Da98b954EedeAC495271d0F", "decimals": 18, "symbol": "DAI"},
        },
        "pairs": ["WETH/USDT", "WETH/USDC", "WETH/DAI"],
        "default_symbol": "WETH/USDT",
        "arbitrage_contract": os.getenv("ETH_ARBITRAGE_CONTRACT", os.getenv("ARBITRAGE_CONTRACT_ADDRESS", ""))
    },
    42161: {
        "name": "arbitrum",
        "label": "Arbitrum One",
        "chain_id": 42161,
        "is_testnet": False,
        "currency": "ETH",
        "explorer": "https://arbiscan.io",
        "rpc_url": "https://arbitrum-one-rpc.publicnode.com",
        "fallbacks": [
            "https://arbitrum-one-rpc.publicnode.com",
            "https://arb1.arbitrum.io/rpc",
        ],
        "dexes": ["Uniswap_V2", "SushiSwap_V2"],
        "routers": {
            "Uniswap_V2": "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
            "SushiSwap_V2": "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",
        },
        "factories": {
            "Uniswap_V2": "0xf1D7CC64Fb4452F05c498126312eBE29f30Fbcf9",
            "SushiSwap_V2": "0xc35DADB65012eC5796536bD9864eD8773aBc74C4",
        },
        "tokens": {
            "WETH": {"address": "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", "decimals": 18, "symbol": "WETH"},
            "USDT": {"address": "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", "decimals": 6, "symbol": "USDT"},
            "USDC": {"address": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", "decimals": 6, "symbol": "USDC"},
        },
        "pairs": ["WETH/USDC", "WETH/USDT"],
        "default_symbol": "WETH/USDC",
        "arbitrage_contract": os.getenv("ARB_ARBITRAGE_CONTRACT", os.getenv("ARBITRAGE_CONTRACT_ADDRESS", ""))
    },
    137: {
        "name": "polygon",
        "label": "Polygon (PoS)",
        "chain_id": 137,
        "is_testnet": False,
        "currency": "POL",
        "explorer": "https://polygonscan.com",
        "rpc_url": "https://polygon-bor-rpc.publicnode.com",
        "fallbacks": [
            "https://polygon-bor-rpc.publicnode.com",
            "https://polygon-rpc.com",
        ],
        "dexes": ["Uniswap_V2", "SushiSwap_V2"],
        "routers": {
            "Uniswap_V2": "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
            "SushiSwap_V2": "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",
        },
        "factories": {
            "Uniswap_V2": "0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32",
            "SushiSwap_V2": "0xc35DADB65012eC5796536bD9864eD8773aBc74C4",
        },
        "tokens": {
            "WETH": {"address": "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", "decimals": 18, "symbol": "WETH"},
            "USDT": {"address": "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", "decimals": 6, "symbol": "USDT"},
            "USDC": {"address": "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", "decimals": 6, "symbol": "USDC"},
        },
        "pairs": ["WETH/USDT", "WETH/USDC"],
        "default_symbol": "WETH/USDT",
        "arbitrage_contract": os.getenv("POLYGON_ARBITRAGE_CONTRACT", os.getenv("ARBITRAGE_CONTRACT_ADDRESS", ""))
    },
    11155111: {
        "name": "sepolia",
        "label": "Sepolia Testnet (SepoliaETH)",
        "chain_id": 11155111,
        "is_testnet": True,
        "currency": "SepoliaETH",
        "explorer": "https://sepolia.etherscan.io",
        "rpc_url": "https://ethereum-sepolia-rpc.publicnode.com",
        "fallbacks": [
            "https://ethereum-sepolia-rpc.publicnode.com",
            "https://rpc.sepolia.org",
            "https://rpc2.sepolia.org",
        ],
        "dexes": ["Uniswap_V2", "SushiSwap_V2"],
        "routers": {
            "Uniswap_V2": "0xC532a74256D3Db42D0Bf7a0400fEFDbad7694008",
            "SushiSwap_V2": "0xeaBcE3E74EF41FB40024a21Cc2ee2F5dDc615791",
        },
        "factories": {
            "Uniswap_V2": "0x7E0987E5b3a30e3f2828572Bb659A548460a3003",
            "SushiSwap_V2": "0x734583F62bB6acE3c9bA9Bd5a53143CA2CE8c55a",
        },
        "tokens": {
            "WETH": {"address": "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9", "decimals": 18, "symbol": "WETH"},
            "USDT": {"address": "0xd077A400968890Eacc75cdc901F0356c943e4fDb", "decimals": 6, "symbol": "USDT"},
            "USDC": {"address": "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", "decimals": 6, "symbol": "USDC"},
        },
        "pairs": ["WETH/USDC", "WETH/USDT"],
        "default_symbol": "WETH/USDC",
        "arbitrage_contract": os.getenv("SEPOLIA_ARBITRAGE_CONTRACT", os.getenv("ARBITRAGE_CONTRACT_ADDRESS", ""))
    },
    84532: {
        "name": "base_sepolia",
        "label": "Base Sepolia Testnet (ETH)",
        "chain_id": 84532,
        "is_testnet": True,
        "currency": "ETH",
        "explorer": "https://sepolia.basescan.org",
        "rpc_url": "https://sepolia.base.org",
        "fallbacks": [
            "https://sepolia.base.org",
            "https://base-sepolia-rpc.publicnode.com",
            "https://base-sepolia.blockpi.network/v1/rpc/public",
            "https://1rpc.io/base-sepolia",
        ],
        "dexes": ["Uniswap_V2"],
        "routers": {
            "Uniswap_V2": "0x1662C4Ca803B6d5d42C85d552318b7625038923d",
        },
        "factories": {
            "Uniswap_V2": "0xF62c03E08ada871A0bEb309762E260a7a6a880E6",
        },
        "tokens": {
            "WETH": {"address": "0x4200000000000000000000000000000000000006", "decimals": 18, "symbol": "WETH"},
            "USDC": {"address": "0x036CbD53842c5426634e7929541eC2318f3dCF7e", "decimals": 6, "symbol": "USDC"},
            "USDT": {"address": "0x0a1e4ff477ff2099307c87c06eb73cbeec0678eb", "decimals": 6, "symbol": "USDT"},
        },
        "pairs": ["WETH/USDC", "WETH/USDT"],
        "default_symbol": "WETH/USDC",
        "arbitrage_contract": os.getenv("BASE_SEPOLIA_ARBITRAGE_CONTRACT", os.getenv("ARBITRAGE_CONTRACT_ADDRESS", ""))
    }
}


# ============================================================
# PROTOCOL SMART CONTRACT ADDRESSES (ACTIVE CHAIN)
# ============================================================

_active_chain_info = CHAIN_REGISTRY.get(CHAIN_ID, CHAIN_REGISTRY[11155111])

DEX_ROUTERS: Dict[str, str] = _active_chain_info["routers"]
DEX_FACTORIES: Dict[str, str] = _active_chain_info["factories"]
TOKEN_REGISTRY: Dict[str, Dict[str, Any]] = _active_chain_info["tokens"]
ARBITRAGE_CONTRACT_ADDRESS: str = os.getenv("ARBITRAGE_CONTRACT_ADDRESS") or _active_chain_info.get("arbitrage_contract", "")
SUPPORTED_DEXES = list(_active_chain_info.get("dexes", ["Uniswap_V2", "SushiSwap_V2"]))


def set_active_chain(chain_id: int) -> Dict[str, Any]:
    """Switch active blockchain configuration dynamically across the application."""
    global CHAIN_ID, DEFAULT_CHAIN, RPC_URL, DEX_ROUTERS, DEX_FACTORIES, TOKEN_REGISTRY, _active_chain_info, SYMBOL, ARBITRAGE_CONTRACT_ADDRESS, SUPPORTED_DEXES
    if chain_id not in CHAIN_REGISTRY:
        raise ValueError(f"Unsupported chain ID: {chain_id}")
    _active_chain_info = CHAIN_REGISTRY[chain_id]
    CHAIN_ID = chain_id
    DEFAULT_CHAIN = _active_chain_info["name"]
    RPC_URL = _active_chain_info["rpc_url"]
    DEX_ROUTERS = _active_chain_info["routers"]
    DEX_FACTORIES = _active_chain_info["factories"]
    TOKEN_REGISTRY = _active_chain_info["tokens"]
    ARBITRAGE_CONTRACT_ADDRESS = os.getenv("ARBITRAGE_CONTRACT_ADDRESS") or _active_chain_info.get("arbitrage_contract", "")
    SUPPORTED_DEXES = list(_active_chain_info.get("dexes", ["Uniswap_V2", "SushiSwap_V2"]))
    SYMBOL = _active_chain_info.get("default_symbol", "WETH/USDC" if chain_id in (8453, 84532, 11155111) else "WETH/USDT")

    # Invalidate decimals and gas cache
    try:
        import dex_engine
        dex_engine._token_decimals_cache.clear()
        dex_engine._last_known_gas_wei = dex_engine._default_gas_wei()
        dex_engine._last_gas_fetch_time = 0.0
    except Exception:
        pass

    return _active_chain_info


def is_chain_testnet(chain_id: Optional[int] = None) -> bool:
    """Return True if the chain (passed or active) is a testnet."""
    cid = chain_id if chain_id is not None else CHAIN_ID
    return bool(CHAIN_REGISTRY.get(cid, {}).get("is_testnet", False))


# Default trading pair
SYMBOL = os.getenv("TRADING_SYMBOL", _active_chain_info.get("default_symbol", "WETH/USDC"))


# ============================================================
# NON-CUSTODIAL WALLET & ARBITRAGE CONTRACT
# ============================================================

WALLET_ADDRESS = os.getenv("WALLET_ADDRESS", "")
PRIVATE_KEY = os.getenv("PRIVATE_KEY", "")
ARBITRAGE_CONTRACT_ADDRESS = os.getenv("ARBITRAGE_CONTRACT_ADDRESS", "")
TREASURY_CONTRACT_ADDRESS = os.getenv("TREASURY_CONTRACT_ADDRESS", "")


# ============================================================
# TRADING MODE & SAFETY SWITCHES
# ============================================================

# MOCK | TESTNET | LIVE
TRADING_MODE = os.getenv("TRADING_MODE", "MOCK").upper()

# Auto-trading background engine (safe default: False)
AUTO_TRADE_ENABLED = os.getenv("AUTO_TRADE_ENABLED", "false").lower() == "true"

# Live execution arm switch
LIVE_TRADING_ARMED = os.getenv("LIVE_TRADING_ARMED", "false").lower() == "true"   # FIXED: was default "true"

# Emergency kill switch (safe default: False; toggleable via UI or API)
EMERGENCY_STOP = os.getenv("EMERGENCY_STOP", "false").lower() == "true"


# ============================================================
# TRADE SIZING & NOTIONAL LIMITS (IN USDT)
# ============================================================

DEFAULT_TRADE_AMOUNT = float(os.getenv("DEFAULT_TRADE_AMOUNT", "5.0"))
MIN_TRADE_AMOUNT = float(os.getenv("MIN_TRADE_AMOUNT", "0.0001"))
MAX_TRADE_AMOUNT = float(os.getenv("MAX_TRADE_AMOUNT", "20.0"))   # FIXED: was 5000


# ============================================================
# PROFIT, GAS, SLIPPAGE & LIQUIDITY GATES
# ============================================================

# Minimum net profit in USDT required after gas & protocol fees (calibrated for Base L2 sub-cent gas fees)
MIN_PROFIT_USDT = float(os.getenv("MIN_PROFIT_USDT", "0.005"))

# Minimum net profit margin in percentage
MIN_PROFIT_PERCENT = float(os.getenv("MIN_PROFIT_PERCENT", "0.005"))

# Target Arbitrage Opportunity Spread (in percentage, default 1.50% = profitable DEX spread)
# Models active market dislocation between Uniswap V2 and SushiSwap V2
ARBITRAGE_SPREAD_TARGET_PCT = float(os.getenv("ARBITRAGE_SPREAD_TARGET_PCT", "1.50"))

# DEX protocol swap fee (0.30% each for Uniswap V2 & SushiSwap V2)
# Fee Percentage: 0.30% (used in UI displays and percentage calculations)
DEX_PROTOCOL_FEE_PCT = 0.30
# Decimal Fee Fraction: 0.30% = 0.003 (used in multiplication formulas: $5 * 0.003 = $0.015 per swap)
DEX_PROTOCOL_FEE_FRACTION = 0.003

# Maximum slippage tolerance (0.50%)
SLIPPAGE_ENABLED = True
SLIPPAGE_PCT = float(os.getenv("SLIPPAGE_PCT", "0.50"))

# Maximum allowable price impact against pool reserves (1.00%)
MAX_PRICE_IMPACT_PCT = float(os.getenv("MAX_PRICE_IMPACT_PCT", "1.00"))

# Gas price ceiling in Gwei
MAX_GAS_PRICE_GWEI = float(os.getenv("MAX_GAS_PRICE_GWEI", "50.0"))   # set ~1-5 in .env for Base / L2

# Estimated gas units for 2-hop atomic smart contract swap
ESTIMATED_GAS_UNITS = int(os.getenv("ESTIMATED_GAS_UNITS", "250000"))

# Stop trading if daily net loss exceeds this threshold
MAX_DAILY_LOSS_USDT = float(os.getenv("MAX_DAILY_LOSS_USDT", "10.00"))


# ============================================================
# TIMING & EXECUTION SAFETY
# ============================================================

AUTO_TRADE_COOLDOWN = int(os.getenv("AUTO_TRADE_COOLDOWN", "10"))
REFRESH_INTERVAL = int(os.getenv("REFRESH_INTERVAL", "2"))
REQUEST_TIMEOUT_MS = int(os.getenv("REQUEST_TIMEOUT_MS", "15000"))
MAX_QUOTE_AGE_MS = int(os.getenv("MAX_QUOTE_AGE_MS", "5000"))
ON_CHAIN_STREAM_ENABLED = os.getenv("ON_CHAIN_STREAM_ENABLED", "true").lower() == "true"


# ============================================================
# LIVE EXECUTION (live_executor.py)
# ============================================================

# Optional dedicated RPC just for sending/reading the trade tx (e.g. Base Flashblocks: https://mainnet-preconf.base.org)
LIVE_EXEC_RPC_URL = os.getenv("LIVE_EXEC_RPC_URL", "")
# Required net profit AFTER gas, in stable units. Enforced on-chain via minProfit.
LIVE_MIN_NET_PROFIT_USDT = float(os.getenv("LIVE_MIN_NET_PROFIT_USDT", "0.01"))
LIVE_GAS_SAFETY_MULT = float(os.getenv("LIVE_GAS_SAFETY_MULT", "1.5"))
LIVE_GAS_LIMIT_BUFFER = float(os.getenv("LIVE_GAS_LIMIT_BUFFER", "1.3"))
LIVE_MAX_PRIORITY_GWEI = float(os.getenv("LIVE_MAX_PRIORITY_GWEI", "0.05"))
LIVE_L1_FEE_USD = float(os.getenv("LIVE_L1_FEE_USD", "0.005"))   # OP-stack L1 data fee estimate (Base)
LIVE_DEADLINE_SEC = int(os.getenv("LIVE_DEADLINE_SEC", "20"))
LIVE_RECEIPT_TIMEOUT_SEC = float(os.getenv("LIVE_RECEIPT_TIMEOUT_SEC", "30"))
LIVE_RECEIPT_POLL_SEC = float(os.getenv("LIVE_RECEIPT_POLL_SEC", "0.05"))


# ============================================================
# ATOMIC FLASHLOAN ARBITRAGE ADAPTER
# ============================================================

DEX_FLASHLOAN_ENABLED = os.getenv("DEX_FLASHLOAN_ENABLED", "false").lower() == "true"
DEX_FLASHLOAN_PROVIDER = os.getenv("DEX_FLASHLOAN_PROVIDER", "aave_v3")
DEX_FLASHLOAN_FEE_PCT = 0.05


# ============================================================
# FLASK WEB SERVER CONFIGURATION
# ============================================================

HOST = os.getenv("HOST", "127.0.0.1")
PORT = int(os.getenv("PORT", "5000"))
DEBUG = os.getenv("DEBUG", "false").lower() == "true"
API_AUTH_TOKEN = os.getenv("API_AUTH_TOKEN", "").strip()


# ============================================================
# CONFIG VALIDATION
# ============================================================

def is_valid_ethereum_address(address: Any) -> bool:
    """Check if address is a valid 42-character 0x hex EVM address."""
    if not isinstance(address, str):
        return False
    clean = address.strip()
    if len(clean) != 42 or not clean.startswith("0x"):
        return False
    try:
        int(clean[2:], 16)
        return True
    except ValueError:
        return False


def validate_chain_dex_routers(
    chain_id: Optional[int] = None,
    routers: Optional[Dict[str, str]] = None,
    dexes: Optional[List[str]] = None,
) -> Tuple[bool, str, List[str]]:
    """Validate that a chain configuration has at least two unique, valid DEX router addresses.

    Returns:
        (is_valid, reason, valid_dex_names)
    """
    if chain_id is not None and routers is None:
        chain_info = CHAIN_REGISTRY.get(chain_id)
        if not chain_info:
            return False, "Arbitrage unavailable: fewer than two valid DEX routers configured.", []
        routers = chain_info.get("routers", {})
        if dexes is None:
            dexes = chain_info.get("dexes", list(routers.keys()))
    elif routers is None:
        routers = DEX_ROUTERS
        if dexes is None:
            dexes = SUPPORTED_DEXES

    if dexes is None:
        dexes = list(routers.keys())

    # Map normalized lowercase router addresses to assigned DEX names
    address_to_dexes: Dict[str, List[str]] = {}
    valid_dexes: List[str] = []

    for dex in dexes:
        addr = routers.get(dex)
        if not addr or not is_valid_ethereum_address(addr):
            continue
        norm_addr = addr.strip().lower()
        if norm_addr not in address_to_dexes:
            address_to_dexes[norm_addr] = []
        address_to_dexes[norm_addr].append(dex)
        valid_dexes.append(dex)

    # Check for identical router addresses assigned across distinct DEXes
    for norm_addr, assigned_dexes in address_to_dexes.items():
        if len(assigned_dexes) > 1:
            print(
                f"[ROUTER VALIDATION] Identical router address {norm_addr} configured for multiple DEXes: {assigned_dexes}",
                flush=True
            )

    unique_router_count = len(address_to_dexes)
    if unique_router_count < 2:
        return False, "Arbitrage unavailable: fewer than two valid DEX routers configured.", valid_dexes

    return True, "Valid DEX routers configured.", valid_dexes


def validate_all_chain_configurations() -> Dict[int, Dict[str, Any]]:
    """Inspect and validate DEX routers across all registered chains on startup.

    Logs configuration status for each chain and ensures no identical routers are silently permitted.
    """
    results = {}
    for cid, info in CHAIN_REGISTRY.items():
        is_valid, reason, valid_dexes = validate_chain_dex_routers(cid)
        results[cid] = {
            "name": info.get("name", ""),
            "label": info.get("label", ""),
            "is_valid": is_valid,
            "reason": reason,
            "valid_dexes": valid_dexes,
            "routers": info.get("routers", {}),
        }
        if not is_valid:
            print(
                f"[STARTUP ROUTER VALIDATION] Chain {cid} ({info.get('name')}): {reason}",
                flush=True
            )
        else:
            print(
                f"[STARTUP ROUTER VALIDATION] Chain {cid} ({info.get('name')}): OK ({len(valid_dexes)} DEXes)",
                flush=True
            )
    return results


def validate_config():
    valid_modes = {"MOCK", "TESTNET", "LIVE"}
    if TRADING_MODE not in valid_modes:
        raise RuntimeError(
            f"Invalid TRADING_MODE: '{TRADING_MODE}'. Must be one of: {valid_modes}"
        )

    if not SUPPORTED_DEXES:
        raise RuntimeError("No decentralized exchanges configured.")

    for dex in SUPPORTED_DEXES:
        if dex not in DEX_ROUTERS:
            raise RuntimeError(f"Router address not configured for DEX: {dex}")

    # Startup inspection of all registered chain DEX routers
    validate_all_chain_configurations()

    # Enforce router uniqueness in active chain if LIVE
    if TRADING_MODE == "LIVE":
        is_valid, reason, _ = validate_chain_dex_routers(CHAIN_ID)
        if not is_valid:
            raise RuntimeError(f"Cannot start in LIVE mode on chain {CHAIN_ID}: {reason}")

    if DEFAULT_TRADE_AMOUNT <= 0:
        raise RuntimeError("DEFAULT_TRADE_AMOUNT must be greater than zero.")

    if MIN_TRADE_AMOUNT <= 0:
        raise RuntimeError("MIN_TRADE_AMOUNT must be greater than zero.")

    if MAX_TRADE_AMOUNT < MIN_TRADE_AMOUNT:
        raise RuntimeError("MAX_TRADE_AMOUNT must be >= MIN_TRADE_AMOUNT.")

    if MIN_PROFIT_USDT < 0:
        raise RuntimeError("MIN_PROFIT_USDT cannot be negative.")

    if MIN_PROFIT_PERCENT < 0:
        raise RuntimeError("MIN_PROFIT_PERCENT cannot be negative.")

    if SLIPPAGE_PCT < 0:
        raise RuntimeError("SLIPPAGE_PCT cannot be negative.")

    if MAX_PRICE_IMPACT_PCT <= 0:
        raise RuntimeError("MAX_PRICE_IMPACT_PCT must be positive.")

    if MAX_GAS_PRICE_GWEI <= 0:
        raise RuntimeError("MAX_GAS_PRICE_GWEI must be positive.")


# Run validation on import
validate_config()
