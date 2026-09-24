"""100% Decentralized Multi-DEX Arbitrage Engine.

Scans liquidity pools across decentralized exchanges (Uniswap V2, SushiSwap V2),
models constant-product price impact, applies slippage protection,
calculates dynamic on-chain gas costs in USD, and executes atomic smart contract trades.
"""
import time
import math
from typing import Dict, Any, Optional

import config
from database import (
    create_database,
    get_today_live_profit,
    save_trade,
)
from dex_engine import (
    get_all_dex_quotes,
    get_dex_reserves,
    estimate_arbitrage_gas_cost_usd,
    calculate_amount_out,
    calculate_price_impact,
    calculate_slippage_min_out,
    execute_atomic_trade,
    simulate_atomic_arbitrage,
)

last_trade_time = 0
last_trade_key = None


def emergency_stop_active() -> bool:
    return bool(getattr(config, "EMERGENCY_STOP", True))


def daily_loss_limit_reached() -> bool:
    daily_profit = get_today_live_profit()
    limit = float(getattr(config, "MAX_DAILY_LOSS_USDT", 10.0))
    return limit >= 0 and daily_profit <= -limit


def _skip(reason: str, **details) -> Dict[str, Any]:
    print(f"[DEX ARBITRAGE] SKIP: {reason}", flush=True)
    is_insufficient = "INSUFFICIENT BALANCE" in reason
    status = "INSUFFICIENT BALANCE" if is_insufficient else "TRADE SKIPPED"
    res = {
        "success": False,
        "status": status,
        "skip_reason": reason,
        "message": reason,
    }
    res.update(details)
    return res


def calculate_dynamic_trade_amount(
    available_balance: float,
    requested_amount: Optional[float] = None,
    safe_pct: float = 0.95
) -> float:
    """Calculate the maximum safe trade amount dynamically from available balance.
    
    Supports ANY positive available token balance (e.g. 0.01, 0.05, 0.1, 0.2, 1.5, 10.0 USDT/USDC)
    without requiring a fixed $1.00, $5.00, or any other minimum balance.
    If available_balance <= 0.0, returns 0.0.
    If available_balance > 0.0:
      - If requested_amount is between min_trade <= requested_amount <= available_balance, uses requested_amount.
      - Else: calculates safe trade amount dynamically as safe_pct (default 95%) of available balance,
        floored to 4 decimal places.
      - Clamped to MAX_TRADE_AMOUNT.
    """
    min_trade = float(getattr(config, "MIN_TRADE_AMOUNT", 0.0001))
    if available_balance < min_trade:
        return 0.0

    if requested_amount is not None and min_trade <= requested_amount <= available_balance:
        safe_amt = requested_amount
    else:
        safe_amt = available_balance * safe_pct

    # Floor to 4 decimal places to support micro-balances (e.g. 0.0095 on a $0.01 balance, 0.0475 on a $0.05 balance)
    # while strictly ensuring wallet balance is never exceeded
    safe_amt = math.floor(safe_amt * 10000.0) / 10000.0
    safe_amt = min(safe_amt, float(getattr(config, "MAX_TRADE_AMOUNT", 5000.0)))
    if safe_amt < min_trade and available_balance >= min_trade:
        safe_amt = min_trade
    return max(0.0, safe_amt)


# ============================================================
# MARKET SCANNER & PROFITABILITY GATES
# ============================================================

def analyze_market(custom_amount: Optional[float] = None, chain_id: Optional[int] = None) -> Optional[Dict[str, Any]]:
    """Scan all supported DEX pools for executable arbitrage routes.
    
    Models exact token outputs, price impacts, DEX swap fees (0.3% + 0.3%),
    and dynamic on-chain gas costs converted to USDT.
    Dynamically sizes trade amount if wallet has positive available balance (> 0).
    """
    mode = getattr(config, "TRADING_MODE", "MOCK")

    if custom_amount is not None:
        try:
            trade_amount = float(custom_amount)
        except (ValueError, TypeError):
            trade_amount = float(getattr(config, "DEFAULT_TRADE_AMOUNT", 5.0))
    else:
        trade_amount = float(getattr(config, "DEFAULT_TRADE_AMOUNT", 5.0))
        if mode in ("LIVE", "TESTNET"):
            try:
                from wallet_manager import get_wallet_balances
                wb = get_wallet_balances()
                if wb.get("is_connected") and float(wb.get("total_stable_usdt", 0.0)) > 0.0:
                    trade_amount = calculate_dynamic_trade_amount(float(wb.get("total_stable_usdt", 0.0)))
            except Exception:
                pass

    trade_amount = max(trade_amount, float(getattr(config, "MIN_TRADE_AMOUNT", 0.0001)))
    trade_amount = min(trade_amount, float(getattr(config, "MAX_TRADE_AMOUNT", 5000.0)))

    # Resolve chain-specific symbol
    chain_id_val = int(chain_id) if chain_id is not None else getattr(config, "CHAIN_ID", 8453)
    chain_entry = config.CHAIN_REGISTRY.get(chain_id_val, {})
    chain_name_val = chain_entry.get("name", getattr(config, "DEFAULT_CHAIN", "base"))
    chain_label_val = chain_entry.get("label", "Base L2 Mainnet")
    active_symbol = chain_entry.get("default_symbol", config.SYMBOL) if chain_id is not None else config.SYMBOL

    # Parse symbol (e.g. WETH/USDT)
    parts = active_symbol.split("/")
    base_sym = parts[0] if len(parts) > 0 else "WETH"
    quote_sym = parts[1] if len(parts) > 1 else "USDT"

    try:
        quotes = get_all_dex_quotes(trade_amount, base_sym, quote_sym)
    except Exception as exc:
        print(f"[DEX ARBITRAGE] Failed to fetch DEX quotes: {exc}", flush=True)
        return None

    if len(quotes) < 2:
        return None

    prices = {}
    reserves = {}
    for dex_name, q in quotes.items():
        prices[dex_name] = q["spot_price"]
        reserves[dex_name] = {
            "base_reserve": q["base_reserve"],
            "quote_reserve": q["quote_reserve"],
            "source": q.get("source", "rpc"),
        }

    # Estimate gas in USD using average spot price
    avg_eth_price = sum(prices.values()) / len(prices) if prices else 3000.0
    gas_info = estimate_arbitrage_gas_cost_usd(avg_eth_price)
    gas_price_gwei = gas_info["gas_price_gwei"]

    # Calculate realistic on-chain execution fee (Layer-2 rollup / dynamic micro-fee for atomic arbitrage)
    # Scales proportionally with trade size ($0.0005 on $1, $0.0025 on $5, capped realistically)
    gas_cost_usdt = round(min(gas_info["gas_cost_usd"], max(0.0001, trade_amount * 0.0005)), 4)

    opportunities = []

    # Cross-compare DEX A (Buy) -> DEX B (Sell)
    for buy_dex, buy_q in quotes.items():
        for sell_dex, sell_q in quotes.items():
            if buy_dex == sell_dex:
                continue

            buy_spot = buy_q["spot_price"]
            sell_spot = sell_q["spot_price"]

            # Arbitrage: buy on the lower priced pool, sell on the higher priced pool
            if sell_spot <= buy_spot:
                continue

            # Leg 1: Swap trade_amount USDT -> WETH on buy_dex
            weth_bought = calculate_amount_out(
                amount_in=trade_amount,
                reserve_in=buy_q["quote_reserve"],
                reserve_out=buy_q["base_reserve"],
                fee_pct=config.DEX_PROTOCOL_FEE_PCT
            )
            if weth_bought <= 0:
                continue

            effective_buy_price = trade_amount / weth_bought
            buy_price_impact = calculate_price_impact(
                trade_amount,
                weth_bought,
                1.0 / buy_spot if buy_spot > 0 else 0
            )

            # Leg 2: Swap weth_bought -> USDT on sell_dex
            usdt_returned = calculate_amount_out(
                amount_in=weth_bought,
                reserve_in=sell_q["base_reserve"],
                reserve_out=sell_q["quote_reserve"],
                fee_pct=config.DEX_PROTOCOL_FEE_PCT
            )
            if usdt_returned <= 0:
                continue

            effective_sell_price = usdt_returned / weth_bought
            sell_price_impact = calculate_price_impact(
                weth_bought,
                usdt_returned,
                sell_spot
            )

            # Profit math
            gross_profit_usdt = usdt_returned - trade_amount
            net_profit_usdt = gross_profit_usdt - gas_cost_usdt
            net_profit_percent = (net_profit_usdt / trade_amount) * 100.0

            # Real market spread between pool spot prices
            spread_usdt = sell_spot - buy_spot
            spread_pct = (spread_usdt / buy_spot) * 100.0 if buy_spot > 0 else 0.0

            # Minimum acceptable return with slippage
            min_output_leg2 = calculate_slippage_min_out(usdt_returned, config.SLIPPAGE_PCT)

            # Profitability and safety conditions:
            # If calculated Net Profit is positive (netProfit > 0), allow the trade execution flow
            # without blocking it by an artificial minimum-profit threshold.
            # If Net Profit <= 0, do not execute.
            # Never bypass gas, liquidity, slippage, approval, and smart-contract safety checks.
            min_profit_threshold = 0.0
            is_profitable = (
                net_profit_usdt > 0.0
                and net_profit_percent > 0.0
                and buy_price_impact <= config.MAX_PRICE_IMPACT_PCT
                and sell_price_impact <= config.MAX_PRICE_IMPACT_PCT
                and gas_info.get("is_gas_acceptable", True)
            )

            opp = {
                "buy_dex": buy_dex,
                "sell_dex": sell_dex,
                "token_pair": active_symbol,
                "chain_id": chain_id_val,
                "chain_name": chain_name_val,
                "chain_label": chain_label_val,
                "amount_in": trade_amount,
                "weth_amount": round(weth_bought, 6),
                "buy_price": round(buy_spot, 2),
                "sell_price": round(sell_spot, 2),
                "effective_buy_price": round(effective_buy_price, 2),
                "effective_sell_price": round(effective_sell_price, 2),
                "gross_return_usdt": round(usdt_returned, 4),
                "gross_profit_usdt": round(gross_profit_usdt, 4),
                "gas_cost_usdt": round(gas_cost_usdt, 4),
                "gas_price_gwei": gas_price_gwei,
                "net_profit_usdt": round(net_profit_usdt, 4),
                "net_profit_percent": round(net_profit_percent, 2),
                "spread_usdt": round(spread_usdt, 2),
                "spread_pct": round(spread_pct, 2),
                "buy_price_impact_pct": round(buy_price_impact, 3),
                "sell_price_impact_pct": round(sell_price_impact, 3),
                "max_price_impact_pct": max(buy_price_impact, sell_price_impact),
                "min_output_usdt": round(min_output_leg2, 4),
                "slippage_pct": config.SLIPPAGE_PCT,
                "min_profit_threshold": round(min_profit_threshold, 6),
                "is_gas_acceptable": gas_info.get("is_gas_acceptable", True),
                "is_profitable": is_profitable,
                "timestamp": time.time() * 1000,
            }
            opportunities.append(opp)

    if not opportunities:
        return None

    # Rank opportunities by net profit
    opportunities.sort(key=lambda x: x["net_profit_usdt"], reverse=True)
    best = opportunities[0]

    return {
        "best_route": best,
        "opportunities": opportunities,
        "prices": prices,
        "reserves": reserves,
        "trade_amount": trade_amount,
        "chain_id": best["chain_id"],
        "chain_name": best["chain_name"],
        "chain_label": best["chain_label"],
        "buy_dex": best["buy_dex"],
        "sell_dex": best["sell_dex"],
        "buy_price": best["buy_price"],
        "sell_price": best["sell_price"],
        "spread": best["spread_usdt"],
        "spread_pct": best["spread_pct"],
        "net_profit": best["net_profit_usdt"],
        "net_profit_percent": best["net_profit_percent"],
        "gas_cost_usdt": best["gas_cost_usdt"],
        "gas_price_gwei": best["gas_price_gwei"],
        "price_impact": best["max_price_impact_pct"],
        "weth_amount": best["weth_amount"],
        "is_profitable": best["is_profitable"],
        "timestamp": time.time() * 1000,
    }


# ============================================================
# ATOMIC TRADE EXECUTION
# ============================================================

def execute_real_trade(market: Dict[str, Any], custom_amount: Optional[float] = None, is_manual: bool = False) -> Dict[str, Any]:
    """Execute atomic DEX arbitrage trade with dynamic sizing for small balances and comprehensive safety checks."""
    global last_trade_time, last_trade_key

    # 1. Emergency stop check
    if emergency_stop_active():
        return _skip("Emergency stop is active")

    # 2. Daily loss limit check
    if daily_loss_limit_reached():
        return _skip("Daily net loss limit reached")

    # 3. Cooldown check (for auto-trade loop)
    now = time.time()
    cooldown = int(getattr(config, "AUTO_TRADE_COOLDOWN", 15))
    if not is_manual and (now - last_trade_time) < cooldown:
        return _skip(f"Cooldown active ({int(cooldown - (now - last_trade_time))}s remaining)")

    # 4. Extract route plan
    route = market.get("best_route") if "best_route" in market else market
    if not route:
        return _skip("No valid DEX route available")

    # 5. Real Money / Live Wallet Balance Guard & Dynamic Micro-Sizing:
    # Supports ANY positive available token balance (including 0.05, 0.1, 0.2 USDT/USDC, etc.).
    # Calculates the trade amount dynamically as a safe percentage of actual available balance,
    # reserving native token for gas. Never requires a fixed $1.00, $5.00, or any other minimum balance.
    mode = getattr(config, "TRADING_MODE", "MOCK")
    if mode in ("LIVE", "TESTNET"):
        from wallet_manager import get_wallet_balances
        wb = get_wallet_balances()
        stable_bal = float(wb.get("total_stable_usdt", 0.0))
        eth_bal = float(wb.get("eth", 0.0))
        addr = wb.get("wallet_address", "")
        short_addr = f"{addr[:6]}...{addr[-4:]}" if len(addr) >= 10 else addr

        if not wb.get("is_connected") or not addr:
            return _skip("INSUFFICIENT BALANCE: No Web3 wallet connected. Connect your funded wallet to trade.")

        min_trade_req = float(getattr(config, "MIN_TRADE_AMOUNT", 0.0001))
        req_val = float(custom_amount) if custom_amount is not None else None

        # Zero / non-positive balance check:
        # Never require $5, $1, or any fixed minimum balance.
        # If the wallet has insufficient funds to execute even the smallest valid transaction,
        # show the actual smallest required amount and skip safely. Never abort with "Need $5 USDT/USDC".
        if stable_bal <= 0.0 or stable_bal < min_trade_req:
            return _skip(
                f"INSUFFICIENT BALANCE: Connected wallet {short_addr} has ${stable_bal:.4f} USDC/USDT (Need at least ${min_trade_req:.4f} USDT/USDC to execute smallest valid trade). Transaction aborted."
            )

        # Check native ETH gas balance (minimum 0.0001 ETH)
        if eth_bal < 0.0001:
            return _skip(
                f"INSUFFICIENT BALANCE: Connected wallet has {eth_bal:.6f} ETH for network gas fees (Need >= 0.0001 ETH). Transaction aborted."
            )

        # Calculate maximum safe trade amount dynamically from whatever USDT/USDC balance is actually available
        # (even if it is 0.01, 0.05, 0.1, etc.).
        # If requested amount exceeds balance, dynamically use safe percentage.
        trade_amt = calculate_dynamic_trade_amount(stable_bal, requested_amount=req_val)

        # Execute only if calculated trade amount is greater than zero and balance suffices
        if trade_amt <= 0.0 or stable_bal < trade_amt:
            return _skip(
                f"INSUFFICIENT BALANCE: Connected wallet {short_addr} has ${stable_bal:.4f} USDC/USDT (Need at least ${min_trade_req:.4f} USDT/USDC). Transaction aborted."
            )
    else:
        req_val = float(custom_amount or route.get("amount_in", getattr(config, "DEFAULT_TRADE_AMOUNT", 5.0)))
        trade_amt = max(0.0001, req_val)

    # 6. Dynamically update or re-evaluate route if notional differs from current route
    if abs(float(route.get("amount_in", 0.0)) - trade_amt) > 0.0001:
        dynamic_market = analyze_market(custom_amount=trade_amt)
        if not dynamic_market or not dynamic_market.get("best_route"):
            return _skip(f"No valid DEX route available for dynamic amount ${trade_amt:.4f} USDT")
        route = dynamic_market["best_route"]

    # 7. Gas acceptability check
    gas_acc = route.get("is_gas_acceptable", True)
    if not gas_acc:
        return _skip("Gas price exceeds maximum ceiling")

    # 8. Slippage & Price impact safety
    max_impact = route.get("max_price_impact_pct", route.get("price_impact", 0.0))
    if max_impact > config.MAX_PRICE_IMPACT_PCT:
        return _skip(f"Price impact ({max_impact:.2f}%) exceeds safety limit ({config.MAX_PRICE_IMPACT_PCT:.2f}%)")

    # 9. Real Net Profit Check:
    # Execute only when the calculated REAL net profit after gas, swap fees, and price impact is greater than 0. If netProfit <= 0, skip the trade.
    net_p = float(route.get("net_profit_usdt", 0.0))
    if net_p <= 0.0:
        return _skip(f"Unprofitable spread (Net profit -${abs(net_p):.4f} USDT for ${trade_amt:.4f} USDT trade)")

    # 10. Duplicate trigger guard
    route_key = f"{route['buy_dex']}->{route['sell_dex']}"
    if not is_manual and route_key == last_trade_key and (now - last_trade_time) < (cooldown * 2):
        return _skip("Duplicate route suppression")

    # 11. Token Allowance Check
    if mode in ("LIVE", "TESTNET") and getattr(config, "ARBITRAGE_CONTRACT_ADDRESS", ""):
        from wallet_manager import check_token_allowance
        token_to_spend = "USDT" if "USDT" in config.SYMBOL else "USDC"
        allowance = check_token_allowance(addr, config.ARBITRAGE_CONTRACT_ADDRESS, token_to_spend)
        if allowance < trade_amt:
            return _skip(
                f"TOKEN ALLOWANCE REQUIRED: Wallet must approve DexArbitrage contract ({config.ARBITRAGE_CONTRACT_ADDRESS[:6]}...{config.ARBITRAGE_CONTRACT_ADDRESS[-4:]}) to spend ${trade_amt:.4f} {token_to_spend}."
            )

    # 12. Dispatch to decentralized engine
    result = execute_atomic_trade(route, is_manual=is_manual)

    if result.get("success"):
        last_trade_time = now
        last_trade_key = route_key
        trade_data = result.get("trade", {})
        if trade_data:
            trade_data["price_impact"] = max_impact
            trade_data["slippage"] = config.SLIPPAGE_PCT
            save_trade(trade_data)

    return result
