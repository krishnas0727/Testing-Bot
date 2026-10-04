"""On-Chain DEX Market Stream.

Polls decentralized liquidity pool reserves and quotes periodically in the background,
providing low-latency price snapshots for the dashboard and auto-trader loop.
Zero centralized exchange dependencies.
"""
import threading
import time
from typing import Dict, Any, Optional

import config
from dex_engine import get_dex_reserves, calculate_amount_out


class OnChainDEXStream:
    def __init__(self):
        self._lock = threading.Lock()
        self._data: Dict[str, Dict[str, Any]] = {}
        self._thread: Optional[threading.Thread] = None
        self._running = False

    def start(self) -> bool:
        if self._running:
            return True
        self._running = True
        self._thread = threading.Thread(target=self._poll_loop, name="dex-stream", daemon=True)
        self._thread.start()
        return True

    def stop(self):
        self._running = False

    def snapshot(self) -> Dict[str, Dict[str, Any]]:
        with self._lock:
            now = time.time()
            out = {}
            for name, item in self._data.items():
                x = dict(item)
                age_ms = max(0.0, (now - x.get("received_at", now)) * 1000.0)
                x["age_ms"] = round(age_ms, 1)
                if age_ms <= 6000:
                    x["freshness"] = "FRESH"
                elif age_ms <= 30000:
                    x["freshness"] = "STALE"
                else:
                    x["freshness"] = "EXPIRED"
                out[name] = x
            return out

    def _poll_loop(self):
        while self._running:
            try:
                symbol = getattr(config, "SYMBOL", "WETH/USDT")
                parts = symbol.split("/")
                base_sym = parts[0] if len(parts) > 0 else "WETH"
                quote_sym = parts[1] if len(parts) > 1 else "USDT"

                for dex_name in config.SUPPORTED_DEXES:
                    res = get_dex_reserves(dex_name, base_sym, quote_sym)
                    base_res = float(res.get("base_reserve", 0.0))
                    quote_res = float(res.get("quote_reserve", 0.0))
                    spot = float(res.get("spot_price", 0.0))

                    weth_for_100_usdt = calculate_amount_out(100.0, quote_res, base_res, config.DEX_PROTOCOL_FEE_PCT) if (quote_res > 0 and base_res > 0) else 0.0
                    ask = 100.0 / weth_for_100_usdt if weth_for_100_usdt > 0 else spot
                    bid = calculate_amount_out(1.0, base_res, quote_res, config.DEX_PROTOCOL_FEE_PCT) if (quote_res > 0 and base_res > 0) else 0.0

                    is_valid = bool(base_res > 0 and quote_res > 0 and spot > 0)
                    liquidity_usd = round(quote_res * 2.0, 2)

                    with self._lock:
                        self._data[dex_name] = {
                            "dex": dex_name,
                            "pair": f"{base_sym}/{quote_sym}",
                            "bid": round(bid, 2),
                            "ask": round(ask, 2),
                            "last": round(spot, 2),
                            "spot_price": round(spot, 2),
                            "base_reserve": base_res,
                            "quote_reserve": quote_res,
                            "liquidity_usd": liquidity_usd,
                            "fee_bps": 30,
                            "fee_pct": 0.003,
                            "is_valid": is_valid,
                            "received_at": time.time(),
                            "source": res.get("source", "on-chain-rpc"),
                        }
            except Exception as exc:
                print(f"[DEX Stream] Polling update error: {exc}", flush=True)

            interval = max(1, int(getattr(config, "REFRESH_INTERVAL", 2)))
            time.sleep(interval)


public_bbo_stream = OnChainDEXStream()
