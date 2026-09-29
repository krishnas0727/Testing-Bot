import unittest
import time


class CircuitBreakerPython:
    def __init__(self, cooldown_sec: float = 30.0, max_consecutive_failures: int = 3, max_daily_loss: float = 10.0):
        self.cooldown_sec = cooldown_sec
        self.max_consecutive_failures = max_consecutive_failures
        self.max_daily_loss = max_daily_loss
        self.state = "CLOSED"  # CLOSED, OPEN, HALF_OPEN
        self.consecutive_failures = 0
        self.current_daily_loss = 0.0
        self.last_trip_time = None
        self.trip_reason = None

    def get_state(self) -> str:
        if self.state == "OPEN" and self.last_trip_time:
            if (time.time() - self.last_trip_time) >= self.cooldown_sec:
                self.state = "HALF_OPEN"
        return self.state

    def is_blocked(self) -> bool:
        return self.get_state() == "OPEN"

    def trip(self, reason: str):
        self.state = "OPEN"
        self.trip_reason = reason
        self.last_trip_time = time.time()

    def record_failure(self, reason: str):
        self.consecutive_failures += 1
        if self.state == "HALF_OPEN" or self.consecutive_failures >= self.max_consecutive_failures:
            self.trip(f"Failure limit reached: {reason}")

    def record_success(self):
        self.consecutive_failures = 0
        if self.state == "HALF_OPEN":
            self.state = "CLOSED"
            self.trip_reason = None

    def record_loss(self, loss_usdt: float):
        if loss_usdt > 0:
            self.current_daily_loss += loss_usdt
            if self.current_daily_loss >= self.max_daily_loss:
                self.trip(f"Daily loss limit reached: ${self.current_daily_loss:.2f}")

    def reset(self):
        self.state = "CLOSED"
        self.consecutive_failures = 0
        self.current_daily_loss = 0.0
        self.trip_reason = None
        self.last_trip_time = None


class RiskEnginePython:
    def __init__(self, config=None):
        self.config = {
            "MIN_NET_PROFIT": 0.01,
            "MAX_TRADE_SIZE": 1000.0,
            "MAX_SLIPPAGE": 1.0,
            "MAX_PRICE_IMPACT": 2.0,
            "MAX_GAS_COST": 0.25,
            "MIN_LIQUIDITY": 1000.0,
            "MAX_CAPITAL_EXPOSURE": 2500.0,
            "MAX_DAILY_LOSS": 10.0,
            "MAX_CONSECUTIVE_FAILURES": 3,
            "MAX_DATA_AGE_SEC": 15.0,
            "SAFETY_MARGIN": 0.02,
            "TOKEN_WHITELIST": ["WETH", "USDT", "USDC", "DAI", "CBETH", "WBTC"],
            "DEX_WHITELIST": ["Uniswap_V2", "SushiSwap_V2", "Aerodrome_V2", "QuickSwap_V2"],
        }
        if config:
            self.config.update(config)
        self.cb = CircuitBreakerPython(
            cooldown_sec=1.0,
            max_consecutive_failures=self.config["MAX_CONSECUTIVE_FAILURES"],
            max_daily_loss=self.config["MAX_DAILY_LOSS"]
        )

    def evaluate(self, opp: dict) -> dict:
        rejection_reasons = []

        # 1. Circuit breaker
        if self.cb.is_blocked():
            rejection_reasons.append(f"Circuit breaker is OPEN: {self.cb.trip_reason}")

        # 2. Token whitelist
        base = opp.get("base_symbol", "").upper()
        quote = opp.get("quote_symbol", "").upper()
        if base not in self.config["TOKEN_WHITELIST"] or quote not in self.config["TOKEN_WHITELIST"]:
            rejection_reasons.append(f"Non-whitelisted token(s): {base}/{quote}")

        # 3. DEX whitelist
        buy_dex = opp.get("buy_dex")
        sell_dex = opp.get("sell_dex")
        if buy_dex not in self.config["DEX_WHITELIST"] or sell_dex not in self.config["DEX_WHITELIST"]:
            rejection_reasons.append(f"Non-whitelisted DEX(es): {buy_dex}/{sell_dex}")

        # 4. Min net profit
        net_profit = opp.get("net_profit_usdt", 0.0)
        if net_profit < self.config["MIN_NET_PROFIT"] or net_profit <= 0:
            rejection_reasons.append(f"Net profit ${net_profit:.4f} below min required ${self.config['MIN_NET_PROFIT']:.4f}")

        # 5. Max trade size
        trade_size = opp.get("trade_size_usdt", 0.0)
        if trade_size > self.config["MAX_TRADE_SIZE"]:
            rejection_reasons.append(f"Trade size ${trade_size:.2f} exceeds max ${self.config['MAX_TRADE_SIZE']:.2f}")

        # 6. Max slippage
        slippage = opp.get("slippage_pct", 0.0)
        if slippage > self.config["MAX_SLIPPAGE"]:
            rejection_reasons.append(f"Slippage {slippage:.2f}% exceeds max {self.config['MAX_SLIPPAGE']:.2f}%")

        # 7. Max price impact
        impact = opp.get("price_impact_pct", 0.0)
        if impact > self.config["MAX_PRICE_IMPACT"]:
            rejection_reasons.append(f"Price impact {impact:.2f}% exceeds limit {self.config['MAX_PRICE_IMPACT']:.2f}%")

        # 8. Max gas cost
        gas_cost = opp.get("gas_cost_usdt", 0.0)
        if gas_cost > self.config["MAX_GAS_COST"]:
            rejection_reasons.append(f"Gas cost ${gas_cost:.4f} exceeds max ${self.config['MAX_GAS_COST']:.4f}")

        # 9. Min liquidity
        min_liq = min(opp.get("buy_pool_liquidity_usd", 0.0), opp.get("sell_pool_liquidity_usd", 0.0))
        if min_liq < self.config["MIN_LIQUIDITY"]:
            rejection_reasons.append(f"Liquidity ${min_liq:.2f} below min required ${self.config['MIN_LIQUIDITY']:.2f}")

        # 10. Capital exposure
        exposure = opp.get("current_exposure_usdt", 0.0) + trade_size
        if exposure > self.config["MAX_CAPITAL_EXPOSURE"]:
            rejection_reasons.append(f"Projected exposure ${exposure:.2f} exceeds limit ${self.config['MAX_CAPITAL_EXPOSURE']:.2f}")

        # 11. Stale data
        data_age = opp.get("data_age_sec", 0.0)
        if data_age > self.config["MAX_DATA_AGE_SEC"]:
            rejection_reasons.append(f"Stale market data (age: {data_age:.1f}s > max: {self.config['MAX_DATA_AGE_SEC']:.1f}s)")

        # 12. Safety margin
        if net_profit < self.config["SAFETY_MARGIN"]:
            rejection_reasons.append(f"Net profit ${net_profit:.4f} below safety margin ${self.config['SAFETY_MARGIN']:.4f}")

        is_approved = len(rejection_reasons) == 0
        return {
            "is_approved": is_approved,
            "status": "APPROVED" if is_approved else "REJECTED",
            "rejection_reasons": rejection_reasons,
            "circuit_breaker_status": self.cb.get_state()
        }


class RiskEnginePythonTests(unittest.TestCase):
    def setUp(self):
        self.engine = RiskEnginePython()
        self.golden_opp = {
            "opportunity_id": "opp_py_1",
            "base_symbol": "WETH",
            "quote_symbol": "USDT",
            "buy_dex": "Uniswap_V2",
            "sell_dex": "SushiSwap_V2",
            "trade_size_usdt": 50.0,
            "net_profit_usdt": 0.50,
            "slippage_pct": 0.50,
            "price_impact_pct": 0.20,
            "gas_cost_usdt": 0.005,
            "buy_pool_liquidity_usd": 100000.0,
            "sell_pool_liquidity_usd": 120000.0,
            "current_exposure_usdt": 0.0,
            "data_age_sec": 1.0
        }

    def test_profitable_opportunity_approval(self):
        result = self.engine.evaluate(self.golden_opp)
        self.assertTrue(result["is_approved"])
        self.assertEqual(result["status"], "APPROVED")
        self.assertEqual(len(result["rejection_reasons"]), 0)

    def test_low_profit_rejection(self):
        opp = dict(self.golden_opp, net_profit_usdt=0.005)
        result = self.engine.evaluate(opp)
        self.assertFalse(result["is_approved"])
        self.assertTrue(any("below min required" in r for r in result["rejection_reasons"]))

    def test_excessive_trade_size(self):
        opp = dict(self.golden_opp, trade_size_usdt=5000.0)
        result = self.engine.evaluate(opp)
        self.assertFalse(result["is_approved"])
        self.assertTrue(any("exceeds max" in r for r in result["rejection_reasons"]))

    def test_excessive_slippage(self):
        opp = dict(self.golden_opp, slippage_pct=2.5)
        result = self.engine.evaluate(opp)
        self.assertFalse(result["is_approved"])
        self.assertTrue(any("Slippage" in r for r in result["rejection_reasons"]))

    def test_excessive_price_impact(self):
        opp = dict(self.golden_opp, price_impact_pct=3.0)
        result = self.engine.evaluate(opp)
        self.assertFalse(result["is_approved"])
        self.assertTrue(any("Price impact" in r for r in result["rejection_reasons"]))

    def test_high_gas_cost(self):
        opp = dict(self.golden_opp, gas_cost_usdt=0.50)
        result = self.engine.evaluate(opp)
        self.assertFalse(result["is_approved"])
        self.assertTrue(any("Gas cost" in r for r in result["rejection_reasons"]))

    def test_low_liquidity(self):
        opp = dict(self.golden_opp, buy_pool_liquidity_usd=500.0)
        result = self.engine.evaluate(opp)
        self.assertFalse(result["is_approved"])
        self.assertTrue(any("Liquidity" in r for r in result["rejection_reasons"]))

    def test_non_whitelisted_token(self):
        opp = dict(self.golden_opp, base_symbol="SCAM_COIN")
        result = self.engine.evaluate(opp)
        self.assertFalse(result["is_approved"])
        self.assertTrue(any("Non-whitelisted token" in r for r in result["rejection_reasons"]))

    def test_non_whitelisted_dex(self):
        opp = dict(self.golden_opp, buy_dex="Untrusted_DEX")
        result = self.engine.evaluate(opp)
        self.assertFalse(result["is_approved"])
        self.assertTrue(any("Non-whitelisted DEX" in r for r in result["rejection_reasons"]))

    def test_excessive_capital_exposure(self):
        opp = dict(self.golden_opp, trade_size_usdt=500.0, current_exposure_usdt=2200.0)
        result = self.engine.evaluate(opp)
        self.assertFalse(result["is_approved"])
        self.assertTrue(any("exposure" in r for r in result["rejection_reasons"]))

    def test_stale_market_data(self):
        opp = dict(self.golden_opp, data_age_sec=30.0)
        result = self.engine.evaluate(opp)
        self.assertFalse(result["is_approved"])
        self.assertTrue(any("Stale market data" in r for r in result["rejection_reasons"]))

    def test_circuit_breaker_activation_and_recovery(self):
        # Trigger 3 consecutive failures
        self.engine.cb.record_failure("Revert 1")
        self.engine.cb.record_failure("Revert 2")
        self.engine.cb.record_failure("Revert 3")

        result = self.engine.evaluate(self.golden_opp)
        self.assertFalse(result["is_approved"])
        self.assertEqual(result["circuit_breaker_status"], "OPEN")

        # Admin reset recovers circuit breaker
        self.engine.cb.reset()
        result2 = self.engine.evaluate(self.golden_opp)
        self.assertTrue(result2["is_approved"])
        self.assertEqual(result2["circuit_breaker_status"], "CLOSED")

    def test_multiple_simultaneous_risk_failures(self):
        opp = dict(
            self.golden_opp,
            net_profit_usdt=-0.10,
            trade_size_usdt=10000.0,
            slippage_pct=5.0,
            base_symbol="UNLISTED",
            buy_dex="UNKNOWN_DEX"
        )
        result = self.engine.evaluate(opp)
        self.assertFalse(result["is_approved"])
        # Multi-failure collection check
        self.assertGreaterEqual(len(result["rejection_reasons"]), 4)


if __name__ == "__main__":
    unittest.main()
