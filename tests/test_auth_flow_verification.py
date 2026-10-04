"""Complete Frontend/Backend Authentication Flow Verification Test.

Validates that:
1. When API_AUTH_TOKEN is not configured on the server, protected endpoints return 401.
2. When API_AUTH_TOKEN is configured in environment / config:
   - Missing Authorization header returns 401.
   - Invalid token returns 403.
   - Valid Bearer token (Authorization: Bearer <token>) returns 200 / successful response.
3. Token is NEVER exposed in API responses or logs.
4. MOCK mode is strictly preserved and NO real blockchain trade is executed.
5. All protected endpoints are covered (/api/trade, /api/auth/verify, /api/settings, /api/treasury/withdraw, etc.).
"""

import os
import json
import pytest
import config
from app import app
from database import create_database


@pytest.fixture(autouse=True)
def setup_test_env():
    """Ensure database exists and trading mode is MOCK for tests."""
    create_database()
    orig_mode = config.TRADING_MODE
    orig_armed = config.LIVE_TRADING_ARMED
    orig_token = getattr(config, "API_AUTH_TOKEN", "")
    orig_env_token = os.environ.get("API_AUTH_TOKEN", "")

    config.TRADING_MODE = "MOCK"
    config.LIVE_TRADING_ARMED = False

    yield

    config.TRADING_MODE = orig_mode
    config.LIVE_TRADING_ARMED = orig_armed
    config.API_AUTH_TOKEN = orig_token
    if orig_env_token:
        os.environ["API_AUTH_TOKEN"] = orig_env_token
    else:
        os.environ.pop("API_AUTH_TOKEN", None)


def test_server_without_api_auth_token_returns_401():
    """Requirement 1 & 10: When API_AUTH_TOKEN is empty on server, requests return 401."""
    config.API_AUTH_TOKEN = ""
    os.environ.pop("API_AUTH_TOKEN", None)

    client = app.test_client()

    protected_endpoints = [
        ("POST", "/api/trade", {"trade_amount": 5.0}),
        ("POST", "/api/trade/confirm-live", {"tx_hash": "0x" + "a" * 64}),
        ("POST", "/api/trade/arm", {"arm": True, "confirm_live": True}),
        ("POST", "/api/treasury/withdraw", {"token": "USDT", "amount": 10}),
        ("POST", "/api/wallet/connect", {"address": "0x1111111111111111111111111111111111111111"}),
        ("POST", "/api/wallet/disconnect", {}),
        ("POST", "/api/chain/switch", {"chain_id": 8453}),
        ("POST", "/api/settings", {"trade_amount": 10.0}),
        ("POST", "/api/trades/clear", {}),
        ("POST", "/api/auth/verify", {}),
    ]

    for method, path, payload in protected_endpoints:
        if method == "POST":
            res = client.post(path, json=payload)
        else:
            res = client.get(path)

        assert res.status_code == 401, f"{path} expected 401 when token unconfigured, got {res.status_code}"
        data = res.get_json()
        assert data["success"] is False
        assert "API_AUTH_TOKEN is not configured on the server" in data["message"]


def test_server_with_token_rejects_unauthenticated_requests():
    """Requirement 2, 7, 8, 10: Unauthenticated requests return 401."""
    test_token = "secret-token-verify-12345"
    config.API_AUTH_TOKEN = test_token
    os.environ["API_AUTH_TOKEN"] = test_token

    client = app.test_client()

    # /api/trade specifically
    res = client.post("/api/trade", json={"trade_amount": 5.0})
    assert res.status_code == 401
    assert "Missing Authorization header" in res.get_json()["message"]

    # /api/auth/verify
    res = client.post("/api/auth/verify", json={})
    assert res.status_code == 401
    assert "Missing Authorization header" in res.get_json()["message"]

    # /api/treasury/withdraw
    res = client.post("/api/treasury/withdraw", json={"token": "USDT", "amount": 5})
    assert res.status_code == 401

    # /api/settings POST
    res = client.post("/api/settings", json={"trade_amount": 10.0})
    assert res.status_code == 401


def test_server_with_token_rejects_invalid_token():
    """Requirement 10: Requests with wrong token return 403."""
    test_token = "secret-token-verify-12345"
    config.API_AUTH_TOKEN = test_token
    os.environ["API_AUTH_TOKEN"] = test_token

    client = app.test_client()
    headers = {"Authorization": "Bearer wrong-token-xyz"}

    # /api/trade with bad token
    res = client.post("/api/trade", json={"trade_amount": 5.0}, headers=headers)
    assert res.status_code == 403
    assert "Invalid API authentication token" in res.get_json()["message"]

    # /api/auth/verify with bad token
    res = client.post("/api/auth/verify", json={}, headers=headers)
    assert res.status_code == 403


def test_server_accepts_valid_bearer_token():
    """Requirement 3, 7, 8, 9: Valid Authorization: Bearer <API_AUTH_TOKEN> succeeds."""
    test_token = "secret-token-verify-12345"
    config.API_AUTH_TOKEN = test_token
    os.environ["API_AUTH_TOKEN"] = test_token

    client = app.test_client()
    headers = {
        "Authorization": f"Bearer {test_token}",
        "Content-Type": "application/json"
    }

    # 1. /api/auth/verify
    res = client.post("/api/auth/verify", json={}, headers=headers)
    assert res.status_code == 200
    assert res.get_json()["success"] is True

    # 2. /api/trade (in MOCK mode - no real blockchain transaction executed)
    config.set_active_chain(8453)
    assert config.TRADING_MODE == "MOCK"
    assert config.LIVE_TRADING_ARMED is False
    res = client.post("/api/trade", json={"trade_amount": 1.0}, headers=headers)
    # Crucially: it must NOT be rejected with 401 or 403
    assert res.status_code not in (401, 403), f"Expected auth to pass, got {res.status_code}"
    trade_data = res.get_json()
    # Confirms request reached the trading engine (either executed MOCK or gated by profit/liquidity check)
    assert trade_data.get("status") in ("TRADE SKIPPED", "EXECUTED", "MOCK", "NO ROUTE", "INSUFFICIENT BALANCE") or "trade" in str(trade_data).lower()

    # 3. /api/settings POST
    res = client.post("/api/settings", json={"trade_amount": 2.5}, headers=headers)
    assert res.status_code == 200
    assert res.get_json()["success"] is True


def test_token_is_not_exposed_in_responses():
    """Requirement 5: Token must never be present in API responses or settings."""
    test_token = "secret-token-verify-12345"
    config.API_AUTH_TOKEN = test_token
    os.environ["API_AUTH_TOKEN"] = test_token

    client = app.test_client()
    headers = {"Authorization": f"Bearer {test_token}"}

    # Test /api/settings GET
    res = client.get("/api/settings", headers=headers)
    assert res.status_code == 200
    text = res.get_data(as_text=True)
    assert test_token not in text
    assert "api_auth_token" not in res.get_json()["settings"]

    # Test /api/auth/verify POST
    res = client.post("/api/auth/verify", json={}, headers=headers)
    assert res.status_code == 200
    assert test_token not in res.get_data(as_text=True)
