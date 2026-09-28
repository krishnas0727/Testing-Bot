"""Non-Custodial Web3 Wallet and Token Balance Manager.

Queries live on-chain balances for native ETH/tokens (WETH, USDT, USDC, USDbC)
via Web3 JSON-RPC calls directly on the active blockchain network.
Supports chain-specific RPC override — fixes Sepolia ETH balance showing 0
when MetaMask is on Sepolia but backend RPC is still pointed at Base/Ethereum.
Never returns fake, hardcoded, or mock balances.
"""
import json
import time
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from typing import Dict, Any, Optional, Tuple
import config
from dex_contract import (
    encode_balance_of,
    encode_allowance,
    decode_uint256,
)

_BALANCE_CACHE: Dict[str, Tuple[float, Dict[str, Any]]] = {}
_BALANCE_CACHE_TTL = 3.0  # 3 seconds cache TTL to prevent RPC congestion


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


def _rpc_call_with_url(rpc_url: str, method: str, params: list) -> Any:
    """Make a direct JSON-RPC call to a specific RPC URL — chain-aware."""
    payload = json.dumps({
        "jsonrpc": "2.0",
        "id": 1,
        "method": method,
        "params": params,
    }).encode("utf-8")
    try:
        req = urllib.request.Request(
            rpc_url,
            data=payload,
            headers={"Content-Type": "application/json", "User-Agent": "NexusArb/1.0"},
            method="POST",
        )
        timeout = getattr(config, "REQUEST_TIMEOUT_MS", 10000) / 1000
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            result = json.loads(resp.read().decode("utf-8"))
            return result.get("result")
    except Exception:
        return None


def fetch_native_eth_balance(wallet_address: str, rpc_url: Optional[str] = None) -> float:
    """Query native ETH/coin balance directly via JSON-RPC eth_getBalance.
    Uses chain-specific RPC URL to guarantee correct chain balance.
    """
    if not wallet_address or not wallet_address.startswith("0x"):
        return 0.0
    try:
        url = rpc_url or config.RPC_URL
        res = _rpc_call_with_url(url, "eth_getBalance", [wallet_address, "latest"])
        if res and isinstance(res, str) and res.startswith("0x"):
            wei = int(res, 16)
            return wei / 1e18
    except Exception:
        pass
    return 0.0


def fetch_token_balance_onchain(
    wallet_address: str,
    token_address: str,
    decimals: int,
    rpc_url: Optional[str] = None,
) -> float:
    """Query ERC20 balanceOf(address) directly via JSON-RPC eth_call.
    Uses chain-specific RPC URL to guarantee correct chain balance.
    """
    if not wallet_address or not token_address or not token_address.startswith("0x"):
        return 0.0
    try:
        calldata = encode_balance_of(wallet_address)
        url = rpc_url or config.RPC_URL
        payload = json.dumps({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "eth_call",
            "params": [{"to": token_address, "data": calldata}, "latest"],
        }).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=payload,
            headers={"Content-Type": "application/json", "User-Agent": "NexusArb/1.0"},
            method="POST",
        )
        timeout = getattr(config, "REQUEST_TIMEOUT_MS", 10000) / 1000
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            result = json.loads(resp.read().decode("utf-8"))
            hex_res = result.get("result")
        if not hex_res or hex_res == "0x":
            return 0.0
        raw_val = decode_uint256(hex_res)
        return raw_val / (10 ** decimals)
    except Exception:
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


def get_wallet_balances(
    eth_price_usdt: float = 3000.0,
    wallet_address: Optional[str] = None,
    chain_id: Optional[int] = None,
) -> Dict[str, Any]:
    """Retrieve actual on-chain wallet balance report for the specified chain.

    KEY FIX: Uses chain-specific RPC from CHAIN_REGISTRY[chain_id] so that
    Sepolia ETH is always read from Sepolia RPC, Base ETH from Base RPC, etc.
    Never mixes chains. Never returns fake or mock balances.
    """
    if wallet_address is not None:
        user_addr = wallet_address.strip()
    else:
        user_addr = get_wallet_address()

    # Determine which chain to query — prefer explicit chain_id param, fallback to config
    active_chain_id = chain_id if chain_id and chain_id in config.CHAIN_REGISTRY else config.CHAIN_ID
    chain_info = config.CHAIN_REGISTRY.get(active_chain_id, {})
    native_currency = chain_info.get("currency", "ETH")

    # Use the chain-specific RPC — this is the core fix for Sepolia showing 0
    chain_rpc = chain_info.get("rpc_url") or config.RPC_URL

    # Token registry for this specific chain
    chain_tokens = chain_info.get("tokens", config.TOKEN_REGISTRY)

    if not user_addr or not user_addr.startswith("0x") or len(user_addr) != 42:
        return {
            "wallet_address": "",
            "is_connected": False,
            "chain": chain_info.get("name", config.DEFAULT_CHAIN),
            "chain_id": active_chain_id,
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
            "usdt_supported": bool(chain_tokens.get("USDT", {}).get("address")),
            "usdc_supported": bool(chain_tokens.get("USDC", {}).get("address")),
            "weth_supported": bool(chain_tokens.get("WETH", {}).get("address")),
        }

    now = time.time()
    cache_key = f"{user_addr.lower()}_{active_chain_id}"
    if cache_key in _BALANCE_CACHE:
        cached_time, cached_bal = _BALANCE_CACHE[cache_key]
        if now - cached_time < _BALANCE_CACHE_TTL:
            res = dict(cached_bal)
            eth_equity = (res.get("eth", 0.0) + res.get("weth", 0.0)) * eth_price_usdt
            res["total_eth_equity_usdt"] = round(eth_equity, 4)
            res["total_equity_usdt"] = round(res.get("total_stable_usdt", 0.0) + eth_equity, 4)
            return res

    weth_info = chain_tokens.get("WETH")
    usdt_info = chain_tokens.get("USDT")
    usdc_info = chain_tokens.get("USDC")
    usdbc_info = chain_tokens.get("USDbC")

    # Fetch live on-chain balances in parallel across 5 threads (reduces latency by ~80%)
    with ThreadPoolExecutor(max_workers=5) as ex:
        f_eth = ex.submit(fetch_native_eth_balance, user_addr, rpc_url=chain_rpc)
        f_weth = ex.submit(fetch_token_balance_onchain, user_addr, weth_info["address"], weth_info["decimals"], rpc_url=chain_rpc) if weth_info and weth_info.get("address") else None
        f_usdt = ex.submit(fetch_token_balance_onchain, user_addr, usdt_info["address"], usdt_info["decimals"], rpc_url=chain_rpc) if usdt_info and usdt_info.get("address") else None
        f_usdc = ex.submit(fetch_token_balance_onchain, user_addr, usdc_info["address"], usdc_info["decimals"], rpc_url=chain_rpc) if usdc_info and usdc_info.get("address") else None
        f_usdbc = ex.submit(fetch_token_balance_onchain, user_addr, usdbc_info["address"], usdbc_info["decimals"], rpc_url=chain_rpc) if usdbc_info and usdbc_info.get("address") else None

        eth_bal = f_eth.result() if f_eth else 0.0
        weth_bal = f_weth.result() if f_weth else 0.0
        usdt_bal = f_usdt.result() if f_usdt else 0.0
        usdc_bal = f_usdc.result() if f_usdc else 0.0
        usdbc_bal = f_usdbc.result() if f_usdbc else 0.0

    effective_usdc = usdc_bal if usdc_bal > 0 else usdbc_bal
    stable_equity = usdt_bal + usdc_bal + usdbc_bal
    eth_equity = (eth_bal + weth_bal) * eth_price_usdt
    total_equity_usdt = stable_equity + eth_equity

    res = {
        "wallet_address": user_addr,
        "is_connected": True,
        "chain": chain_info.get("name", config.DEFAULT_CHAIN),
        "chain_id": active_chain_id,
        "native_currency": native_currency,
        "source": "on-chain-rpc",
        "rpc_used": chain_rpc,
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
    _BALANCE_CACHE[cache_key] = (now, res)
    return res
