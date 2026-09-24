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
                x["age_ms"] = max(0.0, (now - x.get("received_at", now)) * 1000.0)
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
                    base_res = res["base_reserve"]
                    quote_res = res["quote_reserve"]
                    spot = res["spot_price"]

                    weth_for_100_usdt = calculate_amount_out(100.0, quote_res, base_res, config.DEX_PROTOCOL_FEE_PCT)
                    ask = 100.0 / weth_for_100_usdt if weth_for_100_usdt > 0 else spot
                    bid = calculate_amount_out(1.0, base_res, quote_res, config.DEX_PROTOCOL_FEE_PCT)

                    with self._lock:
                        self._data[dex_name] = {
                            "dex": dex_name,
                            "bid": round(bid, 2),
                            "ask": round(ask, 2),
                            "last": round(spot, 2),
                            "spot_price": round(spot, 2),
                            "base_reserve": base_res,
                            "quote_reserve": quote_res,
                            "received_at": time.time(),
                            "source": res.get("source", "on-chain-rpc"),
                        }
            except Exception as exc:
                print(f"[DEX Stream] Polling update error: {exc}", flush=True)

            interval = max(1, int(getattr(config, "REFRESH_INTERVAL", 2)))
            time.sleep(interval)


public_bbo_stream = OnChainDEXStream()
