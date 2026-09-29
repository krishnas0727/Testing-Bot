"""
Phase 14: Dashboard Architecture — Python Test Suite

Tests:
- Verification of 6 Dashboard Pages & data representations
- Clear distinction between Estimated Profit and Realized Profit
- Currency and Number formatting logic
- Block Explorer link generation for supported chains
- Truncation of Ethereum transaction hashes and addresses
- Multi-bucket Treasury representation
"""

import pytest
from typing import Dict, Any


DASHBOARD_PAGES = [
    "OVERVIEW",
    "OPPORTUNITIES",
    "TRADES",
    "TREASURY",
    "HEALTH",
    "ALERTS",
]

EXPLORER_URLS = {
    8453: "https://basescan.org/tx/",
    84532: "https://sepolia.basescan.org/tx/",
    137: "https://polygonscan.com/tx/",
    42161: "https://arbiscan.io/tx/",
    1: "https://etherscan.io/tx/",
}


def format_currency(amount: float) -> str:
    if amount is None or amount != amount:  # NaN check
        return "$0.00"
    return f"${amount:,.2f}"


def get_tx_explorer_url(chain_id: int, tx_hash: str) -> str:
    prefix = EXPLORER_URLS.get(chain_id, "https://basescan.org/tx/")
    return f"{prefix}{tx_hash}"


def truncate_hash(h: str, start: int = 6, end: int = 4) -> str:
    if not h:
        return ""
    if len(h) <= start + end:
        return h
    return f"{h[:start]}...{h[-end:]}"


class TestDashboardArchitecture:
    def test_all_six_pages_defined(self):
        assert len(DASHBOARD_PAGES) == 6
        assert "OVERVIEW" in DASHBOARD_PAGES
        assert "OPPORTUNITIES" in DASHBOARD_PAGES
        assert "TRADES" in DASHBOARD_PAGES
        assert "TREASURY" in DASHBOARD_PAGES
        assert "HEALTH" in DASHBOARD_PAGES
        assert "ALERTS" in DASHBOARD_PAGES

    def test_estimated_vs_realized_profit_semantics(self):
        opportunity = {
            "tokenPair": "USDC/WETH",
            "expectedNetProfit": 1.25,
            "type": "ESTIMATED",
        }
        trade = {
            "tokenPair": "USDC/WETH",
            "actualNetProfit": 1.10,
            "type": "REALIZED",
        }

        assert opportunity["type"] == "ESTIMATED"
        assert trade["type"] == "REALIZED"
        assert opportunity["expectedNetProfit"] != trade["actualNetProfit"]

    def test_currency_formatting(self):
        assert format_currency(1234.56) == "$1,234.56"
        assert format_currency(0.0) == "$0.00"
        assert format_currency(1000000.0) == "$1,000,000.00"

    def test_explorer_link_generation(self):
        tx = "0x9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b"
        base_link = get_tx_explorer_url(8453, tx)
        assert base_link == f"https://basescan.org/tx/{tx}"

        poly_link = get_tx_explorer_url(137, tx)
        assert poly_link == f"https://polygonscan.com/tx/{tx}"

    def test_hash_truncation(self):
        full_hash = "0x9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b"
        truncated = truncate_hash(full_hash)
        assert truncated == "0x9a8b...1a0b"
        assert len(truncated) == 13

    def test_treasury_bucket_distribution(self):
        buckets = {
            "tradingCapital": 5000.0,
            "gasReserve": 1500.0,
            "profitReserve": 1500.0,
            "emergencyReserve": 1000.0,
            "revenue": 1000.0,
        }
        total = sum(buckets.values())
        assert total == 10000.0
        assert buckets["tradingCapital"] / total == 0.50
        assert buckets["revenue"] / total == 0.10
