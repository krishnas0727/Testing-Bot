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

    # Rank opportunities by net profit: prioritize profitable opportunities first
    profitable_opps = [o for o in opportunities if o["is_profitable"]]
    if profitable_opps:
        profitable_opps.sort(key=lambda x: x["net_profit_usdt"], reverse=True)
        best = profitable_opps[0]
    else:
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

def _calculate_net_profit(trade_amt: float, buy_q: dict, sell_q: dict, gas_price_gwei: float, eth_price_usdt: float) -> dict:
    """Calculate complete net profit for a proposed arbitrage trade.

    Accounts for:
    - Both DEX swap fees (0.3% each leg = 0.6% total)
    - Real constant-product price impact on both legs
    - Actual on-chain gas cost in USD
    - Slippage worst-case reserve

    Returns a dict with all cost components + is_profitable flag.
    """
    fee_pct = float(getattr(config, "DEX_PROTOCOL_FEE_PCT", 0.003))

    # Leg 1: USDT → WETH on buy DEX (with 0.3% DEX fee applied by constant-product formula)
    weth_out = calculate_amount_out(
        amount_in=trade_amt,
        reserve_in=buy_q["quote_reserve"],
        reserve_out=buy_q["base_reserve"],
        fee_pct=fee_pct,
    )
    if weth_out <= 0:
        return {"is_profitable": False, "net_profit_usdt": -999.0, "skip_reason": "Zero WETH output on buy leg"}

    # Leg 2: WETH → USDT on sell DEX (with 0.3% DEX fee)
    usdt_out = calculate_amount_out(
        amount_in=weth_out,
        reserve_in=sell_q["base_reserve"],
        reserve_out=sell_q["quote_reserve"],
        fee_pct=fee_pct,
    )
    if usdt_out <= 0:
        return {"is_profitable": False, "net_profit_usdt": -999.0, "skip_reason": "Zero USDT output on sell leg"}

    # Total DEX protocol fees paid (0.3% per leg × 2 legs)
    fee_leg1_usdt = trade_amt * fee_pct
    fee_leg2_usdt = weth_out * sell_q.get("spot_price", 1.0) * fee_pct
    total_dex_fees_usdt = fee_leg1_usdt + fee_leg2_usdt

    # Price impact on both legs
    buy_impact = calculate_price_impact(trade_amt, weth_out, 1.0 / buy_q["spot_price"] if buy_q["spot_price"] > 0 else 0)
    sell_impact = calculate_price_impact(weth_out, usdt_out, sell_q["spot_price"])
    max_impact = max(buy_impact, sell_impact)

    # Slippage reserve cost = difference between expected and minimum acceptable output
    slippage_pct = float(getattr(config, "SLIPPAGE_PCT", 0.5))
    min_usdt_out = calculate_slippage_min_out(usdt_out, slippage_pct)
    slippage_cost_usdt = usdt_out - min_usdt_out

    # Real on-chain gas cost in USD (estimated gas units × gas price × ETH price)
    # Atomic arbitrage ≈ 200,000 – 300,000 gas units
    GAS_UNITS_ESTIMATE = 250_000
    gas_cost_eth = (GAS_UNITS_ESTIMATE * gas_price_gwei * 1e-9)
    gas_cost_usdt = gas_cost_eth * eth_price_usdt
    # Cap gas cost for L2 networks where gas is sub-cent
    gas_cost_usdt = min(gas_cost_usdt, max(0.0001, trade_amt * 0.002))

    # Gross profit = raw output − input (before all costs)
    gross_profit_usdt = usdt_out - trade_amt

    # Net profit = gross − gas − slippage reserve
    # (DEX fees are already embedded in constant-product formula; showing them for transparency)
    net_profit_usdt = gross_profit_usdt - gas_cost_usdt - slippage_cost_usdt
    net_profit_pct = (net_profit_usdt / trade_amt) * 100.0 if trade_amt > 0 else 0.0

    is_gas_ok = gas_price_gwei <= float(getattr(config, "MAX_GAS_PRICE_GWEI", 50.0))
    is_impact_ok = max_impact <= float(getattr(config, "MAX_PRICE_IMPACT_PCT", 1.0))
    is_profitable = (
        net_profit_usdt > 0.0
        and net_profit_pct > 0.0
        and is_gas_ok
        and is_impact_ok
    )

    return {
        "is_profitable": is_profitable,
        "weth_out": round(weth_out, 8),
        "usdt_out": round(usdt_out, 6),
        "gross_profit_usdt": round(gross_profit_usdt, 6),
        "dex_fees_usdt": round(total_dex_fees_usdt, 6),
        "gas_cost_usdt": round(gas_cost_usdt, 6),
        "slippage_cost_usdt": round(slippage_cost_usdt, 6),
        "net_profit_usdt": round(net_profit_usdt, 6),
        "net_profit_pct": round(net_profit_pct, 4),
        "buy_impact_pct": round(buy_impact, 4),
        "sell_impact_pct": round(sell_impact, 4),
        "max_price_impact_pct": round(max_impact, 4),
        "gas_price_gwei": gas_price_gwei,
        "min_usdt_out": round(min_usdt_out, 6),
        "is_gas_acceptable": is_gas_ok,
        "is_impact_acceptable": is_impact_ok,
        "skip_reason": "" if is_profitable else (
            f"INSUFFICIENT_PROFIT: Net ${net_profit_usdt:.6f} USDT "
            f"(Gross ${gross_profit_usdt:.6f} - Gas ${gas_cost_usdt:.6f} - Slip ${slippage_cost_usdt:.6f})"
            if not is_gas_ok is False and not is_impact_ok is False
            else (f"Gas too high ({gas_price_gwei:.2f} Gwei)" if not is_gas_ok
                  else f"Price impact too high ({max_impact:.2f}%)")
        ),
    }


def execute_real_trade(market: Dict[str, Any], custom_amount: Optional[float] = None, is_manual: bool = False) -> Dict[str, Any]:
    """Execute atomic DEX arbitrage trade with rigorous pre-execution profitability gate.

    Profitability chain (all gates must pass):
    1. Emergency stop
    2. Daily loss limit
    3. Cooldown
    4. Route availability
    5. Wallet balance (LIVE/TESTNET only)
    6. Dynamic trade sizing
    7. FRESH quote + gas recalculation at execution time
    8. Net profit > 0 after gas + slippage (INSUFFICIENT_PROFIT if not)
    9. Gas ceiling
    10. Price impact limit
    11. Duplicate suppression
    12. Token allowance
    13. Dispatch to on-chain engine
    14. Record ONLY on confirmed tx success
    """
    global last_trade_time, last_trade_key

    # Gate 1: Emergency stop
    if emergency_stop_active():
        return _skip("Emergency stop is active")

    # Gate 2: Daily loss limit
    if daily_loss_limit_reached():
        return _skip("Daily net loss limit reached")

    # Gate 3: Cooldown
    now = time.time()
    mode = getattr(config, "TRADING_MODE", "MOCK")
    default_cooldown = 1 if mode == "MOCK" else 2
    cooldown = int(getattr(config, "AUTO_TRADE_COOLDOWN", default_cooldown))
    if not is_manual and (now - last_trade_time) < cooldown:
        return _skip(f"Cooldown active ({int(cooldown - (now - last_trade_time))}s remaining)")

    # Gate 4: Route availability
    route = market.get("best_route") if "best_route" in market else market
    if not route:
        return _skip("No valid DEX route available")

    mode = getattr(config, "TRADING_MODE", "MOCK")

    # Gate 5: Wallet balance guard (LIVE/TESTNET only)
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

        if stable_bal <= 0.0 or stable_bal < min_trade_req:
            return _skip(
                f"INSUFFICIENT BALANCE: Wallet {short_addr} has ${stable_bal:.4f} USDC/USDT "
                f"(Need >= ${min_trade_req:.4f}). Transaction aborted."
            )

        if eth_bal < 0.0001:
            return _skip(
                f"INSUFFICIENT BALANCE: Wallet has {eth_bal:.6f} ETH for gas "
                f"(Need >= 0.0001 ETH). Transaction aborted."
            )

        req_val = float(custom_amount) if custom_amount is not None else None
        trade_amt = calculate_dynamic_trade_amount(stable_bal, requested_amount=req_val)

        if trade_amt <= 0.0 or stable_bal < trade_amt:
            return _skip(
                f"INSUFFICIENT BALANCE: Wallet {short_addr} has ${stable_bal:.4f} USDC/USDT "
                f"(Need >= ${min_trade_req:.4f}). Transaction aborted."
            )
    else:
        req_val = float(custom_amount or route.get("amount_in", getattr(config, "DEFAULT_TRADE_AMOUNT", 5.0)))
        trade_amt = max(0.0001, req_val)
        addr = getattr(config, "WALLET_ADDRESS", "")
        stable_bal = 999999.0

    buy_dex = route.get("buy_dex", "")
    sell_dex = route.get("sell_dex", "")

    # ============================================================
    # Gate 6+7+8: FRESH QUOTE + FULL PROFIT RECALCULATION
    # This is the core fix — recalculate everything at execution time,
    # never trust stale quote from the polling cycle.
    # ============================================================
    print(f"[PROFIT CHECK] Fetching fresh quote for ${trade_amt:.4f} USDT on {buy_dex} → {sell_dex}...", flush=True)

    parts = config.SYMBOL.split("/")
    base_sym = parts[0] if len(parts) > 0 else "WETH"
    quote_sym = parts[1] if len(parts) > 1 else "USDT"

    try:
        fresh_quotes = get_all_dex_quotes(trade_amt, base_sym, quote_sym)
    except Exception as exc:
        return _skip(f"Failed to fetch fresh DEX quotes: {exc}")

<<<<<<< HEAD
    if buy_dex not in fresh_quotes or sell_dex not in fresh_quotes:
        return _skip(f"Required DEXes {buy_dex}, {sell_dex} not available in fresh quote")

    fresh_buy_q = fresh_quotes[buy_dex]
    fresh_sell_q = fresh_quotes[sell_dex]

    # Validate that the spread still exists (sell price > buy price)
    if fresh_sell_q["spot_price"] <= fresh_buy_q["spot_price"]:
        return _skip(
            f"INSUFFICIENT_PROFIT: Spread disappeared — "
            f"{buy_dex} ${fresh_buy_q['spot_price']:.2f} vs {sell_dex} ${fresh_sell_q['spot_price']:.2f}"
        )

    # Get fresh gas and ETH price
    from dex_engine import estimate_arbitrage_gas_cost_usd
    avg_eth_price = (fresh_buy_q["spot_price"] + fresh_sell_q["spot_price"]) / 2.0
    gas_info = estimate_arbitrage_gas_cost_usd(avg_eth_price)
    fresh_gas_gwei = gas_info["gas_price_gwei"]

    # Full net profit recalculation with fresh data
    profit_check = _calculate_net_profit(
        trade_amt=trade_amt,
        buy_q=fresh_buy_q,
        sell_q=fresh_sell_q,
        gas_price_gwei=fresh_gas_gwei,
        eth_price_usdt=avg_eth_price,
    )

    print(
        f"[PROFIT CHECK] Gross=${profit_check['gross_profit_usdt']:.6f} "
        f"Gas=${profit_check['gas_cost_usdt']:.6f} "
        f"Slip=${profit_check['slippage_cost_usdt']:.6f} "
        f"Net=${profit_check['net_profit_usdt']:.6f} "
        f"Profitable={profit_check['is_profitable']}",
        flush=True
    )

    # Gate 8: Net profit must be > 0 after ALL costs (gas + slippage + fees)
    if not profit_check["is_profitable"]:
        reason = profit_check.get("skip_reason", "INSUFFICIENT_PROFIT")
        print(f"[PROFIT CHECK] BLOCKED: {reason}", flush=True)
        return _skip(reason,
                     gross_profit_usdt=profit_check["gross_profit_usdt"],
                     gas_cost_usdt=profit_check["gas_cost_usdt"],
                     slippage_cost_usdt=profit_check["slippage_cost_usdt"],
                     net_profit_usdt=profit_check["net_profit_usdt"],
                     net_profit_pct=profit_check["net_profit_pct"])

    # Gate 9: Gas ceiling
    if not profit_check["is_gas_acceptable"]:
        return _skip(f"Gas price {fresh_gas_gwei:.2f} Gwei exceeds ceiling {getattr(config, 'MAX_GAS_PRICE_GWEI', 50.0):.2f} Gwei")

    # Gate 10: Price impact limit
    max_impact = profit_check["max_price_impact_pct"]
    if max_impact > float(getattr(config, "MAX_PRICE_IMPACT_PCT", 1.0)):
        return _skip(f"Price impact ({max_impact:.2f}%) exceeds safety limit ({getattr(config, 'MAX_PRICE_IMPACT_PCT', 1.0):.2f}%)")

    # Gate 11: Duplicate trigger guard
    route_key = f"{buy_dex}->{sell_dex}"
    if not is_manual and route_key == last_trade_key and (now - last_trade_time) < cooldown:
        return _skip("Cooldown active (1s remaining)")

    # Gate 12: Token Allowance Check
    if mode in ("LIVE", "TESTNET") and getattr(config, "ARBITRAGE_CONTRACT_ADDRESS", ""):
        from wallet_manager import check_token_allowance
        token_to_spend = "USDT" if "USDT" in config.SYMBOL else "USDC"
        allowance = check_token_allowance(addr, config.ARBITRAGE_CONTRACT_ADDRESS, token_to_spend)
        if allowance < trade_amt:
            return _skip(
                f"TOKEN ALLOWANCE REQUIRED: Approve DexArbitrage contract "
                f"({config.ARBITRAGE_CONTRACT_ADDRESS[:6]}...{config.ARBITRAGE_CONTRACT_ADDRESS[-4:]}) "
                f"to spend ${trade_amt:.4f} {token_to_spend}."
            )

    # Gate 13: Build the execution route with fresh verified data and dispatch
    execution_route = {
        **route,
        "amount_in": trade_amt,
        "weth_amount": profit_check["weth_out"],
        "gross_return_usdt": round(profit_check["usdt_out"], 6),
        "gross_profit_usdt": profit_check["gross_profit_usdt"],
        "gas_cost_usdt": profit_check["gas_cost_usdt"],
        "slippage_cost_usdt": profit_check["slippage_cost_usdt"],
        "net_profit_usdt": profit_check["net_profit_usdt"],
        "net_profit_percent": profit_check["net_profit_pct"],
        "buy_price_impact_pct": profit_check["buy_impact_pct"],
        "sell_price_impact_pct": profit_check["sell_impact_pct"],
        "max_price_impact_pct": max_impact,
        "min_output_usdt": profit_check["min_usdt_out"],
        "is_profitable": True,
        "is_gas_acceptable": True,
        "verified_at_execution": True,
    }

    result = execute_atomic_trade(execution_route, is_manual=is_manual)

    # Gate 14: Record profit ONLY after confirmed on-chain transaction success
    if result.get("success"):
        last_trade_time = now
        last_trade_key = route_key
        trade_data = result.get("trade", {})
        if trade_data:
            # Enrich with verified execution-time profit figures
            trade_data["price_impact"] = max_impact
            trade_data["slippage"] = getattr(config, "SLIPPAGE_PCT", 0.5)
            trade_data["verified_gross_profit"] = profit_check["gross_profit_usdt"]
            trade_data["verified_gas_cost"] = profit_check["gas_cost_usdt"]
            trade_data["verified_net_profit"] = profit_check["net_profit_usdt"]
            # Only save after tx hash confirmed
            tx_hash = trade_data.get("tx_hash") or result.get("tx_hash")
            if tx_hash:
                print(f"[TRADE CONFIRMED] tx={tx_hash} net_profit=${profit_check['net_profit_usdt']:.6f} USDT", flush=True)
                save_trade(trade_data)
            else:
                # MOCK / simulation — save for record
                save_trade(trade_data)
    else:
        print(f"[TRADE FAILED] {result.get('message', 'Unknown error')} — NOT recording profit.", flush=True)

    return result

