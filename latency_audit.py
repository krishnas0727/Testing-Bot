"""Trade Execution Latency Audit and Quote Staleness Module.

Measures the complete operation using 6 pipeline timestamps:
1. opportunity_detected_at (t_detect)
2. quote_received_at (t_quote)
3. validation_started_at (t_validate)
4. prep_started_at (t_prep)
5. submitted_at (t_submit)
6. confirmed_at (t_confirm)

Calculates and displays 4 timing intervals:
- Detection -> Preparation (detection_to_prep_ms)
- Preparation -> Submission (prep_to_submit_ms)
- Submission -> Confirmation (submit_to_confirm_ms)
- Total elapsed time (total_elapsed_ms)

Records execution telemetry:
- quote_age_ms
- price_at_detection
- price_at_validation
- price_at_submission
- price_drift_pct
- final_result
- gas/fees
- slippage/price impact
- bottleneck_stage
- benchmark_status (target < 1000ms vs real measured time)

Enforces staleness validation against config.MAX_QUOTE_AGE_MS.
"""
import time
from datetime import datetime
from typing import Dict, Any, List, Optional, Tuple

import config


def get_current_epoch_ms() -> float:
    """Return high-resolution current unix epoch in milliseconds."""
    return time.time() * 1000.0


def check_quote_staleness(
    detected_at: Optional[float],
    current_time: Optional[float] = None,
    max_age_ms: Optional[float] = None
) -> Tuple[bool, float]:
    """Check if opportunity quote has exceeded the maximum staleness threshold.
    
    Returns (is_stale, quote_age_ms).
    """
    threshold = float(max_age_ms if max_age_ms is not None else getattr(config, "MAX_QUOTE_AGE_MS", 5000))
    if not detected_at:
        return False, 0.0

    now_ms = current_time if current_time is not None else get_current_epoch_ms()
    # Normalize detected_at to ms if given in seconds
    det_ms = detected_at * 1000.0 if detected_at < 1e11 else detected_at
    age_ms = max(0.0, now_ms - det_ms)
    is_stale = age_ms > threshold
    return is_stale, round(age_ms, 2)


class TradeLatencyAudit:
    """Encapsulates a full latency telemetry audit record for a single trade."""

    TARGET_BENCHMARK_MS = 1000.0  # < 1000 ms target benchmark

    def __init__(
        self,
        tx_hash: str = "",
        token_pair: str = "WETH/USDC",
        mode: str = "MOCK",
        detected_at: Optional[float] = None,
        quote_received_at: Optional[float] = None,
        validation_started_at: Optional[float] = None,
        prep_started_at: Optional[float] = None,
        submitted_at: Optional[float] = None,
        confirmed_at: Optional[float] = None,
        price_at_detection: Optional[Dict[str, float]] = None,
        price_at_validation: Optional[Dict[str, float]] = None,
        price_at_submission: Optional[Dict[str, float]] = None,
        final_result: str = "CONFIRMED",
        gas_fees: Optional[Dict[str, Any]] = None,
        slippage_price_impact: Optional[Dict[str, Any]] = None,
        skip_reason: str = "",
    ):
        now = get_current_epoch_ms()
        # Normalization: ensure timestamps are epoch milliseconds
        self.tx_hash = tx_hash
        self.token_pair = token_pair
        self.mode = mode

        self.detected_at = self._norm_ms(detected_at or now)
        self.quote_received_at = self._norm_ms(quote_received_at or self.detected_at)
        self.validation_started_at = self._norm_ms(validation_started_at or self.quote_received_at)
        self.prep_started_at = self._norm_ms(prep_started_at or self.validation_started_at)
        self.submitted_at = self._norm_ms(submitted_at or self.prep_started_at)
        self.confirmed_at = self._norm_ms(confirmed_at or self.submitted_at)

        self.price_at_detection = price_at_detection or {}
        self.price_at_validation = price_at_validation or dict(self.price_at_detection)
        self.price_at_submission = price_at_submission or dict(self.price_at_validation)

        self.final_result = final_result
        self.skip_reason = skip_reason
        self.gas_fees = gas_fees or {}
        self.slippage_price_impact = slippage_price_impact or {}

        # Computed fields
        self.quote_age_ms = 0.0
        self.detection_to_prep_ms = 0.0
        self.prep_to_submit_ms = 0.0
        self.submit_to_confirm_ms = 0.0
        self.total_elapsed_ms = 0.0
        self.price_drift_pct = 0.0
        self.bottleneck_stage = "None"
        self.benchmark_status = "TARGET_MET"
        self.is_stale = False

        self.calculate()

    @staticmethod
    def _norm_ms(ts: float) -> float:
        if ts <= 0:
            return 0.0
        # If timestamp is in seconds (< 1e11), convert to ms
        return ts * 1000.0 if ts < 1e11 else float(ts)

    def calculate(self):
        """Calculate intervals, quote age, price drift, bottleneck stage, and benchmark compliance."""
        # 1. Quote age at validation start
        self.quote_age_ms = max(0.0, round(self.validation_started_at - self.detected_at, 2))
        max_quote_age = float(getattr(config, "MAX_QUOTE_AGE_MS", 5000))
        self.is_stale = self.quote_age_ms > max_quote_age

        # 2. Stage intervals
        self.detection_to_prep_ms = max(0.0, round(self.prep_started_at - self.detected_at, 2))
        self.prep_to_submit_ms = max(0.0, round(self.submitted_at - self.prep_started_at, 2))
        self.submit_to_confirm_ms = max(0.0, round(self.confirmed_at - self.submitted_at, 2))

        # Total elapsed time
        self.total_elapsed_ms = max(0.0, round(self.confirmed_at - self.detected_at, 2))

        # 3. Price drift calculation (between detection spot prices and submission/validation)
        det_buy = float(self.price_at_detection.get("buy_price") or self.price_at_detection.get("spot_price") or 0.0)
        sub_buy = float(self.price_at_submission.get("buy_price") or self.price_at_validation.get("buy_price") or 0.0)
        if det_buy > 0 and sub_buy > 0:
            self.price_drift_pct = round(((sub_buy - det_buy) / det_buy) * 100.0, 4)
        else:
            self.price_drift_pct = 0.0

        # 4. Bottleneck Stage Analysis
        stages = [
            ("Detection -> Preparation", self.detection_to_prep_ms),
            ("Preparation -> Submission", self.prep_to_submit_ms),
            ("Submission -> Confirmation", self.submit_to_confirm_ms),
        ]
        # Sort to find largest contributor
        stages.sort(key=lambda s: s[1], reverse=True)
        slowest_stage, max_duration = stages[0]
        if max_duration > 0:
            pct_of_total = (max_duration / self.total_elapsed_ms * 100.0) if self.total_elapsed_ms > 0 else 0.0
            self.bottleneck_stage = f"{slowest_stage} ({max_duration:.1f}ms, {pct_of_total:.0f}%)"
        else:
            self.bottleneck_stage = "Instant (< 1ms)"

        # 5. Benchmark Target Verification (< 1000 ms)
        if self.total_elapsed_ms <= self.TARGET_BENCHMARK_MS:
            self.benchmark_status = "TARGET_MET (< 1000ms)"
        else:
            sec = self.total_elapsed_ms / 1000.0
            self.benchmark_status = f"TARGET_EXCEEDED ({sec:.2f}s measured)"

    def to_dict(self) -> Dict[str, Any]:
        """Return full telemetry dictionary."""
        return {
            "tx_hash": self.tx_hash,
            "token_pair": self.token_pair,
            "mode": self.mode,
            "timestamps": {
                "opportunity_detected_at": self.detected_at,
                "quote_received_at": self.quote_received_at,
                "validation_started_at": self.validation_started_at,
                "prep_started_at": self.prep_started_at,
                "submitted_at": self.submitted_at,
                "confirmed_at": self.confirmed_at,
            },
            "intervals_ms": {
                "detection_to_prep_ms": self.detection_to_prep_ms,
                "prep_to_submit_ms": self.prep_to_submit_ms,
                "submit_to_confirm_ms": self.submit_to_confirm_ms,
                "total_elapsed_ms": self.total_elapsed_ms,
            },
            "quote_age_ms": self.quote_age_ms,
            "is_stale": self.is_stale,
            "max_quote_age_ms": getattr(config, "MAX_QUOTE_AGE_MS", 5000),
            "prices": {
                "price_at_detection": self.price_at_detection,
                "price_at_validation": self.price_at_validation,
                "price_at_submission": self.price_at_submission,
                "price_drift_pct": self.price_drift_pct,
            },
            "final_result": self.final_result,
            "skip_reason": self.skip_reason,
            "gas_fees": self.gas_fees,
            "slippage_price_impact": self.slippage_price_impact,
            "bottleneck_stage": self.bottleneck_stage,
            "benchmark_status": self.benchmark_status,
            "target_benchmark_ms": self.TARGET_BENCHMARK_MS,
            "created_at": datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S"),
        }


# ============================================================
# IN-MEMORY & PERSISTENT TELEMETRY BUFFER
# ============================================================

_RECENT_LATENCY_AUDITS: List[Dict[str, Any]] = []
_MAX_AUDITS_IN_MEMORY = 100


def record_latency_audit(audit_or_dict: Any) -> Dict[str, Any]:
    """Store latency audit event in memory and persist to database."""
    global _RECENT_LATENCY_AUDITS
    audit_dict = audit_or_dict.to_dict() if hasattr(audit_or_dict, "to_dict") else dict(audit_or_dict)

    _RECENT_LATENCY_AUDITS.insert(0, audit_dict)
    if len(_RECENT_LATENCY_AUDITS) > _MAX_AUDITS_IN_MEMORY:
        _RECENT_LATENCY_AUDITS = _RECENT_LATENCY_AUDITS[:_MAX_AUDITS_IN_MEMORY]

    # Persist to database
    try:
        from database import save_latency_audit
        save_latency_audit(audit_dict)
    except Exception as exc:
        # Non-fatal log
        pass

    return audit_dict


def get_latest_latency_audit() -> Optional[Dict[str, Any]]:
    """Return the most recently recorded latency audit."""
    if _RECENT_LATENCY_AUDITS:
        return _RECENT_LATENCY_AUDITS[0]
    try:
        from database import get_recent_latency_audits
        audits = get_recent_latency_audits(limit=1)
        return audits[0] if audits else None
    except Exception:
        return None


def get_latency_audit_summary(limit: int = 50) -> Dict[str, Any]:
    """Calculate summary statistics over recent trade latency telemetry."""
    audits = _RECENT_LATENCY_AUDITS[:limit]
    if not audits:
        try:
            from database import get_recent_latency_audits
            audits = get_recent_latency_audits(limit=limit)
        except Exception:
            audits = []

    count = len(audits)
    if count == 0:
        return {
            "total_audited": 0,
            "latest": None,
            "averages": {
                "detection_to_prep_ms": 0.0,
                "prep_to_submit_ms": 0.0,
                "submit_to_confirm_ms": 0.0,
                "total_elapsed_ms": 0.0,
                "quote_age_ms": 0.0,
            },
            "benchmark_compliance": {
                "target_ms": TradeLatencyAudit.TARGET_BENCHMARK_MS,
                "target_met_count": 0,
                "target_exceeded_count": 0,
                "compliance_pct": 100.0,
            },
            "staleness_stats": {
                "stale_count": 0,
                "fresh_count": 0,
                "max_allowed_age_ms": getattr(config, "MAX_QUOTE_AGE_MS", 5000),
            },
            "primary_bottleneck": "None",
            "recent_audits": [],
        }

    sum_det_prep = sum(a.get("intervals_ms", {}).get("detection_to_prep_ms", 0.0) for a in audits)
    sum_prep_sub = sum(a.get("intervals_ms", {}).get("prep_to_submit_ms", 0.0) for a in audits)
    sum_sub_conf = sum(a.get("intervals_ms", {}).get("submit_to_confirm_ms", 0.0) for a in audits)
    sum_total = sum(a.get("intervals_ms", {}).get("total_elapsed_ms", 0.0) for a in audits)
    sum_quote_age = sum(a.get("quote_age_ms", 0.0) for a in audits)

    target_met = sum(1 for a in audits if a.get("intervals_ms", {}).get("total_elapsed_ms", 0.0) <= TradeLatencyAudit.TARGET_BENCHMARK_MS)
    target_exceeded = count - target_met
    stale_count = sum(1 for a in audits if a.get("is_stale", False))

    avg_det_prep = round(sum_det_prep / count, 2)
    avg_prep_sub = round(sum_prep_sub / count, 2)
    avg_sub_conf = round(sum_sub_conf / count, 2)
    avg_total = round(sum_total / count, 2)
    avg_quote_age = round(sum_quote_age / count, 2)

    # Determine primary overall bottleneck
    stage_avgs = [
        ("Detection -> Preparation", avg_det_prep),
        ("Preparation -> Submission", avg_prep_sub),
        ("Submission -> Confirmation", avg_sub_conf),
    ]
    stage_avgs.sort(key=lambda s: s[1], reverse=True)
    slowest_name, slowest_avg = stage_avgs[0]
    primary_bottleneck = f"{slowest_name} (avg {slowest_avg:.1f}ms)" if slowest_avg > 0 else "Instant (< 1ms)"

    return {
        "total_audited": count,
        "latest": audits[0] if audits else None,
        "averages": {
            "detection_to_prep_ms": avg_det_prep,
            "prep_to_submit_ms": avg_prep_sub,
            "submit_to_confirm_ms": avg_sub_conf,
            "total_elapsed_ms": avg_total,
            "quote_age_ms": avg_quote_age,
        },
        "benchmark_compliance": {
            "target_ms": TradeLatencyAudit.TARGET_BENCHMARK_MS,
            "target_met_count": target_met,
            "target_exceeded_count": target_exceeded,
            "compliance_pct": round((target_met / count) * 100.0, 1),
        },
        "staleness_stats": {
            "stale_count": stale_count,
            "fresh_count": count - stale_count,
            "max_allowed_age_ms": getattr(config, "MAX_QUOTE_AGE_MS", 5000),
        },
        "primary_bottleneck": primary_bottleneck,
        "recent_audits": audits,
    }
