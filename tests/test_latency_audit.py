"""Unit tests for Trade Execution Latency Audit and Quote Staleness Module.

Tests:
1. TradeLatencyAudit class initialization, interval calculations, and normalization.
2. Bottleneck stage identification (Detection -> Prep, Prep -> Submit, Submit -> Confirm).
3. Benchmark compliance (<1000ms target vs measured time, e.g. 12.4s).
4. Quote staleness validation (check_quote_staleness against MAX_QUOTE_AGE_MS).
5. Price drift percentage calculation.
6. Summary calculation and telemetry persistence.
7. /api/latency-audit endpoint responses.
8. /api/trade/verify-profit staleness invalidation.
9. execute_real_trade stale quote rejection and telemetry attachment.
"""
import time
import unittest
from unittest.mock import patch, MagicMock

from app import app
import config
import database
import latency_audit
from latency_audit import (
    TradeLatencyAudit,
    check_quote_staleness,
    record_latency_audit,
    get_latency_audit_summary,
    get_latest_latency_audit,
)


class TestLatencyAudit(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()
        self.client.testing = True

    def test_timestamp_intervals_and_benchmark_met(self):
        """Test interval calculation when execution completes under the 1000ms benchmark."""
        t_detect = 1700000000.000
        t_quote = 1700000000.050
        t_validate = 1700000000.080
        t_prep = 1700000000.120     # Det -> Prep = 120ms
        t_submit = 1700000000.200   # Prep -> Submit = 80ms
        t_confirm = 1700000000.600  # Submit -> Confirm = 400ms (Total = 600ms)

        audit = TradeLatencyAudit(
            tx_hash="0x123456789abcdef",
            token_pair="WETH/USDT",
            mode="MOCK",
            detected_at=t_detect,
            quote_received_at=t_quote,
            validation_started_at=t_validate,
            prep_started_at=t_prep,
            submitted_at=t_submit,
            confirmed_at=t_confirm,
            price_at_detection={"buy_price": 3000.0, "sell_price": 3030.0},
            price_at_validation={"buy_price": 3000.0, "sell_price": 3030.0},
            price_at_submission={"buy_price": 3001.5, "sell_price": 3030.0},
        )

        d = audit.to_dict()
        intervals = d["intervals_ms"]
        self.assertAlmostEqual(intervals["detection_to_prep_ms"], 120.0, places=1)
        self.assertAlmostEqual(intervals["prep_to_submit_ms"], 80.0, places=1)
        self.assertAlmostEqual(intervals["submit_to_confirm_ms"], 400.0, places=1)
        self.assertAlmostEqual(intervals["total_elapsed_ms"], 600.0, places=1)

        # Under 1000ms benchmark target
        self.assertIn("TARGET_MET", d["benchmark_status"])
        self.assertFalse(d["is_stale"])
        self.assertAlmostEqual(d["quote_age_ms"], 80.0, places=1)

        # Bottleneck stage: Submit -> Confirm was 400ms (largest)
        self.assertIn("Submission -> Confirmation", d["bottleneck_stage"])

        # Price drift: (3001.5 - 3000.0) / 3000.0 = +0.05%
        self.assertAlmostEqual(d["prices"]["price_drift_pct"], 0.05, places=2)

    def test_benchmark_exceeded_and_bottleneck_detection(self):
        """Test latency audit when execution exceeds target benchmark (e.g. 12.4s)."""
        t_detect = 1700000000.0
        t_quote = 1700000000.2
        t_validate = 1700000000.4
        t_prep = 1700000001.0       # Det -> Prep = 1000ms
        t_submit = 1700000002.0     # Prep -> Submit = 1000ms
        t_confirm = 1700000012.4    # Submit -> Confirm = 10400ms (Total = 12400ms = 12.4s)

        audit = TradeLatencyAudit(
            tx_hash="0xabcdef123456",
            token_pair="WETH/USDC",
            mode="LIVE",
            detected_at=t_detect,
            quote_received_at=t_quote,
            validation_started_at=t_validate,
            prep_started_at=t_prep,
            submitted_at=t_submit,
            confirmed_at=t_confirm,
        )

        d = audit.to_dict()
        intervals = d["intervals_ms"]
        self.assertAlmostEqual(intervals["total_elapsed_ms"], 12400.0, places=0)
        self.assertIn("TARGET_EXCEEDED", d["benchmark_status"])
        self.assertIn("12.40s measured", d["benchmark_status"])
        self.assertIn("Submission -> Confirmation", d["bottleneck_stage"])

    def test_quote_staleness_check(self):
        """Test check_quote_staleness helper with fresh and expired timestamps."""
        now = time.time() * 1000.0

        # Fresh quote: 1000ms old (threshold = 5000ms)
        is_stale, age = check_quote_staleness(now - 1000.0, current_time=now, max_age_ms=5000)
        self.assertFalse(is_stale)
        self.assertAlmostEqual(age, 1000.0, delta=5.0)

        # Expired/Stale quote: 6500ms old
        is_stale, age = check_quote_staleness(now - 6500.0, current_time=now, max_age_ms=5000)
        self.assertTrue(is_stale)
        self.assertAlmostEqual(age, 6500.0, delta=5.0)

    def test_record_latency_audit_and_summary(self):
        """Test recording latency audits and verifying statistical summary."""
        audit1 = TradeLatencyAudit(
            tx_hash="0xtest_1",
            mode="MOCK",
            detected_at=1700000000.0,
            prep_started_at=1700000000.1,
            submitted_at=1700000000.2,
            confirmed_at=1700000000.5,
        )
        audit2 = TradeLatencyAudit(
            tx_hash="0xtest_2",
            mode="LIVE",
            detected_at=1700000000.0,
            prep_started_at=1700000000.2,
            submitted_at=1700000000.4,
            confirmed_at=1700000002.0,  # 2000ms total
        )

        record_latency_audit(audit1)
        record_latency_audit(audit2)

        summary = get_latency_audit_summary(limit=10)
        self.assertGreaterEqual(summary["total_audited"], 2)
        self.assertIn("averages", summary)
        self.assertIn("benchmark_compliance", summary)
        self.assertIn("staleness_stats", summary)

    def test_latency_audit_api_endpoint(self):
        """Test /api/latency-audit GET endpoint."""
        res = self.client.get("/api/latency-audit")
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertTrue(data["success"])
        self.assertIn("data", data)
        self.assertIn("averages", data["data"])
        self.assertIn("benchmark_compliance", data["data"])

    def test_verify_profit_stale_rejection(self):
        """Test /api/trade/verify-profit rejects stale detected_at timestamps."""
        stale_detected_at = time.time() - 10.0  # 10 seconds ago (> 5s threshold)
        res = self.client.post("/api/trade/verify-profit", json={
            "trade_amount": 1.0,
            "chain_id": 8453,
            "detected_at": stale_detected_at
        })
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertTrue(data.get("is_stale"))
        self.assertIn("STALE_OPPORTUNITY", data.get("status", ""))

    def test_execute_real_trade_stale_invalidation(self):
        """Test execute_real_trade rejects opportunities whose quote exceeds MAX_QUOTE_AGE_MS."""
        from arbitrage import execute_real_trade

        stale_market = {
            "is_profitable": True,
            "symbol": "WETH/USDC",
            "detected_at": time.time() - 15.0,  # 15s ago (> 5000ms)
            "best_route": {
                "buy_dex": "Uniswap_V2",
                "sell_dex": "SushiSwap_V2",
                "buy_price": 3000.0,
                "sell_price": 3050.0,
                "spread_usdt": 50.0,
                "spread_pct": 1.66,
                "amount_in": 1.0,
                "gross_profit_usdt": 0.05,
                "gas_cost_usdt": 0.005,
                "net_profit_usdt": 0.045,
                "is_profitable": True
            }
        }

        result = execute_real_trade(stale_market, is_manual=True)
        self.assertFalse(result.get("success"))
        self.assertEqual(result.get("status"), "STALE_OPPORTUNITY")
        self.assertIn("telemetry", result)
        self.assertTrue(result["telemetry"].get("is_stale"))


if __name__ == "__main__":
    unittest.main()
