"""Non-Custodial Web3 Wallet and Token Balance Manager.

Queries live on-chain balances for native ETH and ERC-20 tokens (WETH, USDT, USDC)
via Web3 JSON-RPC calls, checks token allowances, and provides simulated
non-custodial wallet balances when running in MOCK mode.
"""
from typing import Dict, Any, Optional
import config
from dex_contract import (
    encode_balance_of,
    encode_allowance,
    decode_uint256,
)

# Simulated non-custodial wallet balances for MOCK mode
MOCK_WALLET_BALANCES = {
    "address": "0x71C8BF422005A3Db0782F434914f6b15Ac5c0c6E",
    "eth": 0.5,       # Native ETH for on-chain gas fees
    "weth": 5.0,      # Wrapped ETH active trading inventory
    "usdt": 10000.0,  # Tether USDT active trading capital
    "usdc": 0.0,
    "wbtc": 0.0,
    "dai": 0.0,
}


def get_wallet_address() -> str:
    """Return configured non-custodial wallet address."""
    addr = getattr(config, "WALLET_ADDRESS", "").strip()
    if addr:
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
    mode = getattr(config, "TRADING_MODE", "LIVE")
    if mode == "MOCK":
        return MOCK_WALLET_BALANCES["address"]
    return ""


def fetch_token_balance_onchain(
    wallet_address: str,
    token_address: str,
    decimals: int
) -> float:
    """Query ERC20 balanceOf(address) directly via Sepolia JSON-RPC."""

    if not wallet_address or not token_address:
        return 0.0

    try:
        from dex_engine import eth_call

        calldata = encode_balance_of(wallet_address)

        hex_res = eth_call(
            token_address,
            calldata
        )

        if not hex_res:
            raise RuntimeError(
                f"Empty RPC response for token {token_address}"
            )

        raw_val = decode_uint256(hex_res)

        balance = raw_val / (10 ** decimals)

        print(
            f"[Wallet Balance] "
            f"token={token_address} "
            f"wallet={wallet_address} "
            f"raw={raw_val} "
            f"decimals={decimals} "
            f"balance={balance}",
            flush=True
        )

        return balance

    except Exception as exc:
        print(
            f"[Wallet Balance ERROR] "
            f"token={token_address} "
            f"wallet={wallet_address}: {exc}",
            flush=True
        )
        return 0.0


def fetch_native_eth_balance(wallet_address: str) -> float:
    """Query native ETH balance directly via JSON-RPC eth_getBalance."""
    if not wallet_address:
        return 0.0
    try:
        from dex_engine import rpc_call
        res = rpc_call("eth_getBalance", [wallet_address, "latest"])
        if res:
            wei = int(res, 16)
            return wei / 1e18
    except Exception:
        pass
    return 0.0


def check_token_allowance(owner: str, spender: str, token_sym: str = "WETH") -> float:
    """Check remaining allowance for a spender (e.g. Router or Arbitrage Contract)."""
    token_info = config.TOKEN_REGISTRY.get(token_sym)
    if not token_info or not owner or not spender:
        return 0.0
    try:
        from dex_engine import eth_call
        calldata = encode_allowance(owner, spender)
        hex_res = eth_call(token_info["address"], calldata)
        raw_val = decode_uint256(hex_res)
        return raw_val / (10 ** token_info["decimals"])
    except Exception:
        return 0.0


def get_wallet_balances(eth_price_usdt: float = 3000.0, wallet_address: Optional[str] = None) -> Dict[str, Any]:
    """Retrieve complete wallet balance report.
    
    In LIVE mode, strictly queries real on-chain balances. If wallet is not
    configured, returns zero balances and disconnected state.
    """
    mode = getattr(config, "TRADING_MODE", "LIVE")
    if wallet_address is not None:
        user_addr = wallet_address.strip()
    else:
        user_addr = getattr(config, "WALLET_ADDRESS", "").strip()

    if not user_addr:
        if mode == "MOCK":
            wallet_addr = MOCK_WALLET_BALANCES["address"]
            eth_bal = MOCK_WALLET_BALANCES["eth"]
            weth_bal = MOCK_WALLET_BALANCES["weth"]
            usdt_bal = MOCK_WALLET_BALANCES["usdt"]
            usdc_bal = MOCK_WALLET_BALANCES["usdc"]
            usdbc_bal = 0.0
            source = "mock-simulated"
            is_connected = True
        else:
            # LIVE or TESTNET mode with no configured wallet
            wallet_addr = ""
            eth_bal = 0.0
            weth_bal = 0.0
            usdt_bal = 0.0
            usdc_bal = 0.0
            usdbc_bal = 0.0
            source = "disconnected"
            is_connected = False
    else:
        wallet_addr = user_addr
        eth_bal = fetch_native_eth_balance(wallet_addr)
        weth_info = config.TOKEN_REGISTRY.get("WETH", {"decimals": 18, "address": ""})
        usdt_info = config.TOKEN_REGISTRY.get("USDT", {"decimals": 6, "address": ""})
        usdc_info = config.TOKEN_REGISTRY.get("USDC", {"decimals": 6, "address": ""})
        usdbc_info = config.TOKEN_REGISTRY.get("USDbC", {"decimals": 6, "address": ""})

        weth_bal = fetch_token_balance_onchain(wallet_addr, weth_info["address"], weth_info["decimals"])
        usdt_bal = fetch_token_balance_onchain(wallet_addr, usdt_info["address"], usdt_info["decimals"])
        usdc_bal = fetch_token_balance_onchain(wallet_addr, usdc_info["address"], usdc_info["decimals"])
        usdbc_bal = fetch_token_balance_onchain(wallet_addr, usdbc_info["address"], usdbc_info["decimals"]) if usdbc_info and usdbc_info.get("address") else 0.0
        source = "on-chain-rpc"
        is_connected = True

    # Total liquid USDT + USDC + USDbC (support both Native USDC and Bridged USDbC on Base)
    effective_usdc = usdc_bal if usdc_bal > 0 else usdbc_bal
    stable_equity = usdt_bal + usdc_bal + usdbc_bal
    # Total ETH + WETH converted to USD
    eth_equity = (eth_bal + weth_bal) * eth_price_usdt
    total_equity_usdt = stable_equity + eth_equity

    return {
        "wallet_address": wallet_addr,
        "is_connected": is_connected,
        "chain": config.DEFAULT_CHAIN,
        "chain_id": config.CHAIN_ID,
        "source": source,
        "eth": round(eth_bal, 6),
        "weth": round(weth_bal, 6),
        "usdt": round(usdt_bal, 4),
        "usdc": round(effective_usdc, 4),
        "native_usdc": round(usdc_bal, 4),
        "usdbc": round(usdbc_bal, 4),
        "total_stable_usdt": round(stable_equity, 4),
        "total_eth_equity_usdt": round(eth_equity, 4),
        "total_equity_usdt": round(total_equity_usdt, 4),
    }
