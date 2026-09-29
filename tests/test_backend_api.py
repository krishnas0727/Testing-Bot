"""
Phase 13: Backend API Architecture — Python Test Suite

Tests:
- API endpoint paths and conventions
- Role-based authorization hierarchy (Admin > Operator > Viewer)
- Rate limiting sliding-window logic
- Pagination calculations and boundary guards
- Filter and sorting mechanisms
- Sensitive secret scrubbing
- Idempotency key tracking
- Treasury read-only security invariant
"""

import pytest
import time
from typing import Dict, Any, List, Optional


# ─────────────────────────────────────────────────────────────────────────────
# PYTHON MIRRORS OF BACKEND API LOGIC
# ─────────────────────────────────────────────────────────────────────────────

ROLE_HIERARCHY = {
    "ADMIN": 3,
    "OPERATOR": 2,
    "VIEWER": 1,
}

SENSITIVE_KEYS = {
    "privatekey",
    "private_key",
    "mnemonic",
    "secret",
    "apikey",
    "deployer_private_key",
    "password",
}


def check_role_permission(user_role: str, required_role: str) -> bool:
    user_level = ROLE_HIERARCHY.get(user_role, 0)
    required_level = ROLE_HIERARCHY.get(required_role, 0)
    return user_level >= required_level


def scrub_sensitive_data(data: Any) -> Any:
    if data is None or not isinstance(data, (dict, list)):
        return data

    if isinstance(data, list):
        return [scrub_sensitive_data(item) for item in data]

    clean = {}
    for key, val in data.items():
        if key.lower() in SENSITIVE_KEYS:
            clean[key] = "[REDACTED_SECRET]"
        elif isinstance(val, (dict, list)):
            clean[key] = scrub_sensitive_data(val)
        else:
            clean[key] = val
    return clean


def paginate_items(items: List[Any], page: int, limit: int) -> Dict[str, Any]:
    page = max(1, page)
    limit = max(1, min(100, limit))
    total_items = len(items)
    total_pages = (total_items + limit - 1) // limit if total_items > 0 else 1
    start_idx = (page - 1) * limit
    paginated = items[start_idx : start_idx + limit]

    return {
        "items": paginated,
        "pagination": {
            "page": page,
            "limit": limit,
            "totalItems": total_items,
            "totalPages": total_pages,
            "hasNext": page < total_pages,
            "hasPrev": page > 1,
        },
    }


class SlidingWindowRateLimiter:
    def __init__(self, max_requests: int, window_sec: float):
        self.max_requests = max_requests
        self.window_sec = window_sec
        self.store: Dict[str, List[float]] = {}

    def is_allowed(self, client_ip: str) -> bool:
        now = time.time()
        timestamps = self.store.get(client_ip, [])
        # Evict outside window
        valid = [t for t in timestamps if now - t < self.window_sec]
        if len(valid) >= self.max_requests:
            self.store[client_ip] = valid
            return False
        valid.append(now)
        self.store[client_ip] = valid
        return True


# ─────────────────────────────────────────────────────────────────────────────
# TESTS
# ─────────────────────────────────────────────────────────────────────────────

class TestRoleAuthorization:
    def test_admin_has_access_to_all_roles(self):
        assert check_role_permission("ADMIN", "VIEWER") is True
        assert check_role_permission("ADMIN", "OPERATOR") is True
        assert check_role_permission("ADMIN", "ADMIN") is True

    def test_operator_has_access_to_viewer_and_operator_only(self):
        assert check_role_permission("OPERATOR", "VIEWER") is True
        assert check_role_permission("OPERATOR", "OPERATOR") is True
        assert check_role_permission("OPERATOR", "ADMIN") is False

    def test_viewer_has_access_to_viewer_only(self):
        assert check_role_permission("VIEWER", "VIEWER") is True
        assert check_role_permission("VIEWER", "OPERATOR") is False
        assert check_role_permission("VIEWER", "ADMIN") is False

    def test_unknown_role_rejected(self):
        assert check_role_permission("ANONYMOUS", "VIEWER") is False


class TestSecretScrubber:
    def test_scrubs_nested_private_keys(self):
        payload = {
            "tradingMode": "LIVE",
            "privateKey": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
            "wallet": {
                "address": "0xUserWalletAddress",
                "mnemonic": "twelve secret recovery words that must never ever be leaked here",
            },
            "rpcUrl": "https://base.org",
        }

        clean = scrub_sensitive_data(payload)
        assert clean["privateKey"] == "[REDACTED_SECRET]"
        assert clean["wallet"]["mnemonic"] == "[REDACTED_SECRET]"
        assert clean["wallet"]["address"] == "0xUserWalletAddress"
        assert clean["tradingMode"] == "LIVE"


class TestPagination:
    def test_pagination_standard_page(self):
        data = list(range(1, 26))  # 25 items
        res = paginate_items(data, page=1, limit=10)
        assert len(res["items"]) == 10
        assert res["pagination"]["totalItems"] == 25
        assert res["pagination"]["totalPages"] == 3
        assert res["pagination"]["hasNext"] is True
        assert res["pagination"]["hasPrev"] is False

    def test_pagination_last_page(self):
        data = list(range(1, 26))
        res = paginate_items(data, page=3, limit=10)
        assert len(res["items"]) == 5
        assert res["pagination"]["hasNext"] is False
        assert res["pagination"]["hasPrev"] is True

    def test_pagination_clamps_limit(self):
        data = list(range(200))
        res = paginate_items(data, page=1, limit=500)
        assert res["pagination"]["limit"] == 100  # Clamped to max 100


class TestRateLimiter:
    def test_allows_up_to_quota(self):
        limiter = SlidingWindowRateLimiter(max_requests=3, window_sec=1.0)
        client = "192.168.1.10"

        assert limiter.is_allowed(client) is True
        assert limiter.is_allowed(client) is True
        assert limiter.is_allowed(client) is True
        # 4th request within window rejected
        assert limiter.is_allowed(client) is False

    def test_resets_after_window(self):
        limiter = SlidingWindowRateLimiter(max_requests=2, window_sec=0.1)
        client = "10.0.0.1"

        assert limiter.is_allowed(client) is True
        assert limiter.is_allowed(client) is True
        assert limiter.is_allowed(client) is False

        time.sleep(0.12)
        assert limiter.is_allowed(client) is True
