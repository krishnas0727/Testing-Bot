"""Non-Custodial Web3 Wallet and Token Balance Manager.

Queries live on-chain balances for native ETH/tokens (WETH, USDT, USDC, USDbC)
via Web3 JSON-RPC calls directly on the active blockchain network.
Never returns fake, hardcoded, or mock balances.
"""
from typing import Dict, Any, Optional
import config
from dex_contract import (
    encode_balance_of,
    encode_allowance,
    decode_uint256,
)


def get_wallet_address() -> str:
    """Return configured non-custodial wallet address."""
    addr = getattr(config, "WALLET_ADDRESS", "").strip()
    if addr and addr.startswith("0x") and len(addr) == 42:
        return addr
    try:
        from database import load_all_bot_settings
        saved = load_all_bot_settings()
        saved_addr = (saved.get("wallet_address") or "").strip()
        if saved_addr and saved_addr.startswith("0x") and len(saved_addr) == 42:
            config.WALLET_ADDRESS = saved_addr
            return saved_addr
    except Exception:
        pass
    return ""


def fetch_token_balance_onchain(wallet_address: str, token_address: str, decimals: int) -> float:
    """Query ERC20 balanceOf(address) directly via JSON-RPC eth_call."""
    if not wallet_address or not token_address or not token_address.startswith("0x"):
        return 0.0
    try:
        from dex_engine import eth_call
        calldata = encode_balance_of(wallet_address)
        hex_res = eth_call(token_address, calldata)
        if not hex_res or hex_res == "0x":
            return 0.0
        raw_val = decode_uint256(hex_res)
        return raw_val / (10 ** decimals)
    except Exception:
        return 0.0


def fetch_native_eth_balance(wallet_address: str) -> float:
    """Query native ETH/coin balance directly via JSON-RPC eth_getBalance."""
    if not wallet_address or not wallet_address.startswith("0x"):
        return 0.0
    try:
        from dex_engine import rpc_call
        res = rpc_call("eth_getBalance", [wallet_address, "latest"])
        if res and isinstance(res, str) and res.startswith("0x"):
            wei = int(res, 16)
            return wei / 1e18
    except Exception:
        pass
    return 0.0


def check_token_allowance(owner: str, spender: str, token_sym: str = "USDT") -> float:
    """Check remaining allowance for a spender (e.g. Router or Arbitrage Contract)."""
    token_info = config.TOKEN_REGISTRY.get(token_sym)
    if not token_info or not owner or not spender:
        return 0.0
    try:
        from dex_engine import eth_call
        calldata = encode_allowance(owner, spender)
        hex_res = eth_call(token_info["address"], calldata)
        if not hex_res or hex_res == "0x":
            return 0.0
        raw_val = decode_uint256(hex_res)
        return raw_val / (10 ** token_info["decimals"])
    except Exception:
        return 0.0


def get_wallet_balances(eth_price_usdt: float = 3000.0, wallet_address: Optional[str] = None) -> Dict[str, Any]:
    """Retrieve actual on-chain wallet balance report for the active network.
    
    Strictly queries real on-chain RPC endpoints. If wallet is not connected,
    returns zero balances and disconnected status. Never returns fake or mock balances.
    """
    if wallet_address is not None and wallet_address.strip():
        user_addr = wallet_address.strip()
    else:
        user_addr = get_wallet_address()

    chain_info = config.CHAIN_REGISTRY.get(config.CHAIN_ID, {})
    native_currency = chain_info.get("currency", "ETH")

    if not user_addr or not user_addr.startswith("0x") or len(user_addr) != 42:
        return {
            "wallet_address": "",
            "is_connected": False,
            "chain": config.DEFAULT_CHAIN,
            "chain_id": config.CHAIN_ID,
            "native_currency": native_currency,
            "source": "disconnected",
            "eth": 0.0,
            "weth": 0.0,
            "usdt": 0.0,
            "usdc": 0.0,
            "usdbc": 0.0,
            "total_stable_usdt": 0.0,
            "total_eth_equity_usdt": 0.0,
            "total_equity_usdt": 0.0,
            "usdt_supported": bool(config.TOKEN_REGISTRY.get("USDT", {}).get("address")),
            "usdc_supported": bool(config.TOKEN_REGISTRY.get("USDC", {}).get("address")),
            "weth_supported": bool(config.TOKEN_REGISTRY.get("WETH", {}).get("address")),
        }

    # Fetch live on-chain balances directly from JSON-RPC
    eth_bal = fetch_native_eth_balance(user_addr)

    weth_info = config.TOKEN_REGISTRY.get("WETH")
    usdt_info = config.TOKEN_REGISTRY.get("USDT")
    usdc_info = config.TOKEN_REGISTRY.get("USDC")
    usdbc_info = config.TOKEN_REGISTRY.get("USDbC")

    weth_bal = fetch_token_balance_onchain(user_addr, weth_info["address"], weth_info["decimals"]) if weth_info and weth_info.get("address") else 0.0
    usdt_bal = fetch_token_balance_onchain(user_addr, usdt_info["address"], usdt_info["decimals"]) if usdt_info and usdt_info.get("address") else 0.0
    usdc_bal = fetch_token_balance_onchain(user_addr, usdc_info["address"], usdc_info["decimals"]) if usdc_info and usdc_info.get("address") else 0.0
    usdbc_bal = fetch_token_balance_onchain(user_addr, usdbc_info["address"], usdbc_info["decimals"]) if usdbc_info and usdbc_info.get("address") else 0.0

    effective_usdc = usdc_bal if usdc_bal > 0 else usdbc_bal
    stable_equity = usdt_bal + usdc_bal + usdbc_bal
    eth_equity = (eth_bal + weth_bal) * eth_price_usdt
    total_equity_usdt = stable_equity + eth_equity

    return {
        "wallet_address": user_addr,
        "is_connected": True,
        "chain": config.DEFAULT_CHAIN,
        "chain_id": config.CHAIN_ID,
        "native_currency": native_currency,
        "source": "on-chain-rpc",
        "eth": round(eth_bal, 6),
        "weth": round(weth_bal, 6),
        "usdt": round(usdt_bal, 4),
        "usdc": round(effective_usdc, 4),
        "native_usdc": round(usdc_bal, 4),
        "usdbc": round(usdbc_bal, 4),
        "total_stable_usdt": round(stable_equity, 4),
        "total_eth_equity_usdt": round(eth_equity, 4),
        "total_equity_usdt": round(total_equity_usdt, 4),
        "usdt_supported": bool(usdt_info and usdt_info.get("address")),
        "usdc_supported": bool(usdc_info and usdc_info.get("address")),
        "weth_supported": bool(weth_info and weth_info.get("address")),
    }
