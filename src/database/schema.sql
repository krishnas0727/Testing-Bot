-- ============================================================
-- DEX ARBITRAGE & TREASURY SYSTEM — PRODUCTION DATABASE SCHEMA
-- ============================================================
-- Compatible with PostgreSQL 14+ and SQLite 3
-- Zero mock data. Strict foreign keys, unique constraints, and indexes.
-- ============================================================

-- 1. TRADES TABLE (Realized On-Chain Arbitrage Trades)
CREATE TABLE IF NOT EXISTS trades (
    id VARCHAR(64) PRIMARY KEY,
    trade_id VARCHAR(64) UNIQUE NOT NULL,
    tx_hash VARCHAR(66) UNIQUE,
    chain_id INTEGER NOT NULL,
    token_in VARCHAR(42) NOT NULL,
    token_out VARCHAR(42) NOT NULL,
    buy_dex VARCHAR(64) NOT NULL,
    sell_dex VARCHAR(64) NOT NULL,
    amount_in NUMERIC(36, 18) NOT NULL,
    gross_profit_usdt NUMERIC(18, 6) NOT NULL,
    net_profit_usdt NUMERIC(18, 6) NOT NULL,
    gas_cost_usdt NUMERIC(18, 6) NOT NULL,
    roi_pct NUMERIC(8, 4) NOT NULL,
    status VARCHAR(20) NOT NULL CHECK (status IN ('PENDING', 'CONFIRMED', 'REVERTED', 'FAILED')),
    execution_time_ms INTEGER DEFAULT 0,
    timestamp BIGINT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
CREATE INDEX IF NOT EXISTS idx_trades_chain_id ON trades(chain_id);
CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_trades_tx_hash ON trades(tx_hash);

-- 2. TRANSACTIONS TABLE (Blockchain Sync Records)
CREATE TABLE IF NOT EXISTS transactions (
    tx_hash VARCHAR(66) PRIMARY KEY,
    chain_id INTEGER NOT NULL,
    block_number BIGINT NOT NULL,
    from_address VARCHAR(42) NOT NULL,
    to_address VARCHAR(42) NOT NULL,
    gas_used BIGINT NOT NULL,
    effective_gas_price_gwei NUMERIC(18, 6) NOT NULL,
    status VARCHAR(20) NOT NULL CHECK (status IN ('PENDING', 'SUCCESS', 'REVERTED')),
    synced_at BIGINT NOT NULL,
    timestamp BIGINT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tx_chain_block ON transactions(chain_id, block_number DESC);
CREATE INDEX IF NOT EXISTS idx_tx_status ON transactions(status);

-- 3. OPPORTUNITIES TABLE (Market Discrepancy Detections)
CREATE TABLE IF NOT EXISTS opportunities (
    id VARCHAR(64) PRIMARY KEY,
    chain_id INTEGER NOT NULL,
    token_in VARCHAR(42) NOT NULL,
    token_out VARCHAR(42) NOT NULL,
    buy_dex VARCHAR(64) NOT NULL,
    sell_dex VARCHAR(64) NOT NULL,
    trade_size_usdt NUMERIC(18, 6) NOT NULL,
    expected_gross_profit_usdt NUMERIC(18, 6) NOT NULL,
    expected_net_profit_usdt NUMERIC(18, 6) NOT NULL,
    roi_pct NUMERIC(8, 4) NOT NULL,
    price_impact_pct NUMERIC(8, 4) NOT NULL,
    estimated_gas_usdt NUMERIC(18, 6) NOT NULL,
    status VARCHAR(20) NOT NULL CHECK (status IN ('ACTIVE', 'EXPIRED', 'EXECUTED', 'REJECTED', 'APPROVED')),
    rejection_reason VARCHAR(255),
    timestamp BIGINT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_opp_chain_status ON opportunities(chain_id, status);
CREATE INDEX IF NOT EXISTS idx_opp_timestamp ON opportunities(timestamp DESC);

-- 4. REVENUE ALLOCATIONS TABLE (60/20/20 Treasury Distribution Ledger)
CREATE TABLE IF NOT EXISTS revenue_allocations (
    id VARCHAR(64) PRIMARY KEY,
    trade_id VARCHAR(64) NOT NULL REFERENCES trades(trade_id),
    tx_hash VARCHAR(66) NOT NULL,
    chain_id INTEGER NOT NULL,
    token_address VARCHAR(42) NOT NULL,
    gross_profit NUMERIC(36, 18) NOT NULL,
    dex_fees NUMERIC(36, 18) NOT NULL,
    gas_cost NUMERIC(36, 18) NOT NULL,
    net_profit NUMERIC(36, 18) NOT NULL,
    trading_capital_share NUMERIC(36, 18) NOT NULL,
    reserve_share NUMERIC(36, 18) NOT NULL,
    revenue_share NUMERIC(36, 18) NOT NULL,
    timestamp BIGINT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_rev_trade_id ON revenue_allocations(trade_id);
CREATE INDEX IF NOT EXISTS idx_rev_tx_hash ON revenue_allocations(tx_hash);

-- 5. SYSTEM ALERTS TABLE (Circuit Breakers & Health Warnings)
CREATE TABLE IF NOT EXISTS system_alerts (
    id VARCHAR(64) PRIMARY KEY,
    type VARCHAR(64) NOT NULL,
    severity VARCHAR(20) NOT NULL CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL')),
    message TEXT NOT NULL,
    details TEXT,
    resolved BOOLEAN DEFAULT FALSE,
    created_at BIGINT NOT NULL,
    resolved_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_alerts_resolved ON system_alerts(resolved, severity);
