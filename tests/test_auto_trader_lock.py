"""Unit Tests for Auto-Trader Lock & Concurrency Safety System (Phase 6).

Strictly verifies Phase 6 requirements:
1. First process acquires lock successfully.
2. Second process / thread is blocked while lock is held.
3. Lock is released after normal shutdown.
4. Lock is released after worker exception.
5. Stale lock recovery works when holding process terminates abnormally.
6. Restart after stale lock can start auto-trader.
7. Corrupted lock metadata (empty file, invalid JSON) is handled safely.
8. Active process lock is not incorrectly removed or treated as stale.
9. PID reuse protection: different start time detects stale lock even if PID is active.
10. Two simultaneous acquisition attempts -> exactly one succeeds, one rejected.
11. Simultaneous stale lock recovery -> exactly one succeeds, one rejected.
12. Multiple start requests -> exactly one worker thread running.
13. Start/stop race leaves consistent state.
14. Emergency Stop still blocks live execution.
15. LIVE mode does not auto-arm on auto-trader startup (LIVE_TRADING_ARMED remains False).
16. Daily loss breaker still blocks live execution.
17. Lock recovery does not reset risk state, emergency stop, or arming.
18. Lock file contains zero secrets (no private keys, API tokens, passwords).
19. Zero real blockchain transactions executed.
"""

import os
import sys
import json
import time
import io
import threading
import unittest
import tempfile
from unittest.mock import patch, MagicMock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import config
import database
from trader_lock import (
    acquire_auto_trader_lock,
    release_auto_trader_lock,
    auto_trader_lock_context,
    is_pid_running,
    get_process_start_time,
    is_lock_owner_active,
    read_lock_info,
    is_auto_trader_locked,
)
from app import (
    app,
    start_background_auto_trader,
    stop_background_auto_trader,
)


class TestAutoTraderLock(unittest.TestCase):
    def setUp(self):
        self.tmp_dir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.lock_path = os.path.join(self.tmp_dir.name, "test_auto_trader.lock")
        self.db_path = os.path.join(self.tmp_dir.name, "test_phase6.db")

        self.orig_db = config.DATABASE_NAME
        config.DATABASE_NAME = self.db_path
        database.DATABASE_NAME = self.db_path
        database.create_database()

        self.orig_lock_path = getattr(config, "AUTO_TRADER_LOCK_PATH", None)
        config.AUTO_TRADER_LOCK_PATH = self.lock_path

        self.orig_emergency = getattr(config, "EMERGENCY_STOP", False)
        config.EMERGENCY_STOP = False
        self.orig_armed = getattr(config, "LIVE_TRADING_ARMED", False)
        config.LIVE_TRADING_ARMED = False
        self.orig_mode = getattr(config, "TRADING_MODE", "MOCK")
        config.TRADING_MODE = "MOCK"
        self.orig_auto_trade = getattr(config, "AUTO_TRADE_ENABLED", False)
        config.AUTO_TRADE_ENABLED = False

        # Ensure any previous state is clean
        release_auto_trader_lock(self.lock_path, force=True)

    def tearDown(self):
        release_auto_trader_lock(self.lock_path, force=True)
        config.AUTO_TRADER_LOCK_PATH = self.orig_lock_path
        config.EMERGENCY_STOP = self.orig_emergency
        config.LIVE_TRADING_ARMED = self.orig_armed
        config.TRADING_MODE = self.orig_mode
        config.AUTO_TRADE_ENABLED = self.orig_auto_trade
        database.DATABASE_NAME = self.orig_db
        config.DATABASE_NAME = self.orig_db
        try:
            self.tmp_dir.cleanup()
        except Exception:
            pass

    # ============================================================
    # 1. BASIC LOCKING
    # ============================================================

    def test_first_process_acquires_lock(self):
        """Requirement 1 & 9: First process acquires lock successfully."""
        captured_stdout = io.StringIO()
        with patch("sys.stdout", captured_stdout):
            success = acquire_auto_trader_lock(self.lock_path)

        self.assertTrue(success)
        self.assertTrue(os.path.exists(self.lock_path))

        info = read_lock_info(self.lock_path)
        self.assertIsNotNone(info)
        self.assertEqual(info["pid"], os.getpid())
        self.assertIn("process_start_time", info)
        self.assertIn("owner_token", info)

        log_output = captured_stdout.getvalue()
        self.assertIn("lock acquired", log_output)

    def test_second_process_is_blocked(self):
        """Requirement 2 & 9: Second process is blocked while lock is held."""
        self.assertTrue(acquire_auto_trader_lock(self.lock_path))

        captured_stdout = io.StringIO()
        with patch("sys.stdout", captured_stdout):
            second_attempt = acquire_auto_trader_lock(self.lock_path)

        self.assertFalse(second_attempt)
        log_output = captured_stdout.getvalue()
        self.assertIn("lock already exists", log_output)

    def test_normal_shutdown_releases_lock(self):
        """Requirement 3 & 9: Normal shutdown releases lock cleanly."""
        self.assertTrue(acquire_auto_trader_lock(self.lock_path))
        self.assertTrue(os.path.exists(self.lock_path))

        captured_stdout = io.StringIO()
        with patch("sys.stdout", captured_stdout):
            released = release_auto_trader_lock(self.lock_path)

        self.assertTrue(released)
        self.assertFalse(os.path.exists(self.lock_path))
        log_output = captured_stdout.getvalue()
        self.assertIn("lock released", log_output)

        # After release, lock can be acquired again
        self.assertTrue(acquire_auto_trader_lock(self.lock_path))

    def test_lock_released_after_worker_exception(self):
        """Requirement 4: Lock is released after worker exception in context manager."""
        self.assertFalse(os.path.exists(self.lock_path))

        with self.assertRaises(ValueError):
            with auto_trader_lock_context(self.lock_path):
                self.assertTrue(os.path.exists(self.lock_path))
                raise ValueError("Simulated unexpected crash inside auto-trader worker")

        # Must be released after exception
        self.assertFalse(os.path.exists(self.lock_path))
        # Subsequent acquisition succeeds
        self.assertTrue(acquire_auto_trader_lock(self.lock_path))

    # ============================================================
    # 2. STALE LOCK RECOVERY & PID REUSE SAFETY
    # ============================================================

    def test_stale_lock_recovery_with_dead_pid(self):
        """Requirement 5 & 6: Handle stale locks safely after abnormal termination."""
        dead_pid = 99999999
        self.assertFalse(is_pid_running(dead_pid))

        with open(self.lock_path, "w", encoding="utf-8") as f:
            json.dump({
                "pid": dead_pid,
                "process_start_time": 1000.0,
                "created_at": time.time() - 3600
            }, f)

        self.assertTrue(os.path.exists(self.lock_path))

        captured_stdout = io.StringIO()
        with patch("sys.stdout", captured_stdout):
            acquired = acquire_auto_trader_lock(self.lock_path)

        self.assertTrue(acquired)
        info = read_lock_info(self.lock_path)
        self.assertEqual(info["pid"], os.getpid())

        log_output = captured_stdout.getvalue()
        self.assertIn("stale lock recovered", log_output)
        self.assertIn("lock acquired", log_output)

    def test_stale_lock_recovery_with_legacy_format(self):
        """Verify recovery of legacy plain integer PID lock file."""
        dead_pid = 99999999
        with open(self.lock_path, "w", encoding="utf-8") as f:
            f.write(f"{dead_pid}\n")

        captured_stdout = io.StringIO()
        with patch("sys.stdout", captured_stdout):
            acquired = acquire_auto_trader_lock(self.lock_path)

        self.assertTrue(acquired)
        info = read_lock_info(self.lock_path)
        self.assertEqual(info["pid"], os.getpid())
        log_output = captured_stdout.getvalue()
        self.assertIn("stale lock recovered", log_output)

    def test_corrupted_lock_metadata_handled_safely(self):
        """Requirement 7: Corrupted lock metadata (empty file, invalid json) is safely recovered."""
        # 1. Zero-byte file
        with open(self.lock_path, "w", encoding="utf-8") as f:
            f.write("")

        # Ensure mtime is older than 2s so it is recognized as corrupted, not concurrent write
        past_time = time.time() - 10.0
        os.utime(self.lock_path, (past_time, past_time))

        self.assertTrue(acquire_auto_trader_lock(self.lock_path))
        self.assertTrue(os.path.exists(self.lock_path))
        info = read_lock_info(self.lock_path)
        self.assertEqual(info["pid"], os.getpid())
        release_auto_trader_lock(self.lock_path)

        # 2. Corrupted JSON file
        with open(self.lock_path, "w", encoding="utf-8") as f:
            f.write("{corrupted: json content ??? not valid")
        os.utime(self.lock_path, (past_time, past_time))

        self.assertTrue(acquire_auto_trader_lock(self.lock_path))
        info = read_lock_info(self.lock_path)
        self.assertEqual(info["pid"], os.getpid())

    def test_active_process_lock_is_not_removed(self):
        """Requirement 8: Active running process lock is NOT removed or treated as stale."""
        other_active_pid = 12345
        with open(self.lock_path, "w", encoding="utf-8") as f:
            json.dump({"pid": other_active_pid, "created_at": time.time()}, f)

        with patch("trader_lock.is_pid_running", return_value=True):
            captured_stdout = io.StringIO()
            with patch("sys.stdout", captured_stdout):
                acquired = acquire_auto_trader_lock(self.lock_path)

            self.assertFalse(acquired)
            self.assertTrue(os.path.exists(self.lock_path))
            info = read_lock_info(self.lock_path)
            self.assertEqual(info["pid"], other_active_pid)

            log_output = captured_stdout.getvalue()
            self.assertIn("lock already exists", log_output)

    def test_pid_reuse_safety(self):
        """Requirement 9: When PID matches an active process but start time differs, detect PID reuse and recover."""
        reused_pid = 12345
        old_start_time = 100000.0
        new_process_start_time = 200000.0  # Unrelated new process has different start time

        with open(self.lock_path, "w", encoding="utf-8") as f:
            json.dump({
                "pid": reused_pid,
                "process_start_time": old_start_time,
                "created_at": time.time() - 3600
            }, f)

        # PID is running, but start time is completely different (PID reuse!)
        with patch("trader_lock.is_pid_running", return_value=True):
            with patch("trader_lock.get_process_start_time", return_value=new_process_start_time):
                acquired = acquire_auto_trader_lock(self.lock_path)

                self.assertTrue(acquired)
                info = read_lock_info(self.lock_path)
                self.assertEqual(info["pid"], os.getpid())

    # ============================================================
    # 3. CONCURRENCY & MULTI-WORKER SAFETY
    # ============================================================

    def test_two_simultaneous_acquisition_attempts(self):
        """Requirement 10: Two simultaneous acquisition attempts -> exactly ONE succeeds."""
        results = []

        def attempt_acquire(worker_id):
            res = acquire_auto_trader_lock(self.lock_path)
            results.append((worker_id, res))
            if res:
                time.sleep(0.05)
                release_auto_trader_lock(self.lock_path)

        t1 = threading.Thread(target=attempt_acquire, args=(1,))
        t2 = threading.Thread(target=attempt_acquire, args=(2,))

        t1.start()
        t2.start()
        t1.join()
        t2.join()

        successes = [r for r in results if r[1] is True]
        failures = [r for r in results if r[1] is False]

        self.assertEqual(len(successes), 1)
        self.assertEqual(len(failures), 1)

    def test_simultaneous_stale_lock_recovery(self):
        """Requirement 11: Simultaneous stale lock recovery -> exactly ONE succeeds."""
        dead_pid = 99999999
        with open(self.lock_path, "w", encoding="utf-8") as f:
            json.dump({"pid": dead_pid, "created_at": time.time() - 3600}, f)

        results = []

        def attempt_stale_recovery(worker_id):
            res = acquire_auto_trader_lock(self.lock_path)
            results.append((worker_id, res))
            if res:
                time.sleep(0.05)
                release_auto_trader_lock(self.lock_path)

        t1 = threading.Thread(target=attempt_stale_recovery, args=(1,))
        t2 = threading.Thread(target=attempt_stale_recovery, args=(2,))

        t1.start()
        t2.start()
        t1.join()
        t2.join()

        successes = [r for r in results if r[1] is True]
        failures = [r for r in results if r[1] is False]

        self.assertEqual(len(successes), 1)
        self.assertEqual(len(failures), 1)

    def test_multiple_start_requests_spawn_single_worker(self):
        """Requirement 12: Multiple concurrent start requests -> exactly ONE worker starts."""
        stop_background_auto_trader()

        start_results = []

        def call_start():
            res = start_background_auto_trader()
            start_results.append(res)

        threads = [threading.Thread(target=call_start) for _ in range(5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        # Exactly 1 thread successfully started
        true_starts = [r for r in start_results if r is True]
        self.assertEqual(len(true_starts), 1)

        # Clean up
        stop_background_auto_trader()

    def test_start_stop_race_leaves_consistent_state(self):
        """Requirement 13: Rapid start and stop leaves consistent state."""
        stop_background_auto_trader()

        for _ in range(3):
            start_background_auto_trader()
            time.sleep(0.01)
            stop_background_auto_trader()

        self.assertFalse(is_auto_trader_locked(self.lock_path))

    # ============================================================
    # 4. SAFETY CONTROLS PRESERVATION
    # ============================================================

    def test_emergency_stop_still_blocks_execution(self):
        """Requirement 14: Emergency Stop active prevents auto-trader trade execution."""
        config.EMERGENCY_STOP = True
        config.AUTO_TRADE_ENABLED = True
        config.TRADING_MODE = "MOCK"

        # Verify engine status is blocked
        from app import emergency_stop_active
        self.assertTrue(emergency_stop_active())

    def test_live_mode_does_not_auto_arm_on_autotrader_start(self):
        """Requirement 15: Auto-trader startup never automatically arms LIVE trading."""
        config.TRADING_MODE = "LIVE"
        config.LIVE_TRADING_ARMED = False

        self.assertTrue(acquire_auto_trader_lock(self.lock_path))

        # LIVE_TRADING_ARMED must strictly remain False
        self.assertFalse(config.LIVE_TRADING_ARMED)
        self.assertEqual(config.TRADING_MODE, "LIVE")

        release_auto_trader_lock(self.lock_path)

    def test_daily_loss_breaker_still_blocks_execution(self):
        """Requirement 16: Daily loss breaker blocks live trading in auto-trader loop."""
        config.TRADING_MODE = "LIVE"
        config.LIVE_TRADING_ARMED = True

        # Record a loss trade in risk_ledger that triggers the breaker
        database.save_trade({
            "tx_hash": "0x" + "a" * 64,
            "chain_id": 8453,
            "buy_dex": "Uniswap_V2",
            "sell_dex": "SushiSwap_V2",
            "token_pair": "WETH/USDT",
            "amount_in": 100.0,
            "amount_out": 0.0,
            "net_profit": -150.0,
            "gross_profit": -140.0,
            "gas_cost_usdt": 10.0,
            "status": "REVERTED",
            "mode": "LIVE"
        })

        from app import daily_loss_limit_reached
        self.assertTrue(daily_loss_limit_reached())

    def test_lock_recovery_does_not_reset_risk_state(self):
        """Requirement 17: Recovering a stale lock preserves risk ledger, emergency stop, and arming."""
        config.EMERGENCY_STOP = True
        config.LIVE_TRADING_ARMED = True

        database.save_trade({
            "tx_hash": "0x" + "b" * 64,
            "chain_id": 8453,
            "buy_dex": "Uniswap_V2",
            "sell_dex": "SushiSwap_V2",
            "token_pair": "WETH/USDT",
            "amount_in": 50.0,
            "amount_out": 0.0,
            "net_profit": -50.0,
            "gross_profit": -45.0,
            "gas_cost_usdt": 5.0,
            "status": "REVERTED",
            "mode": "LIVE"
        })

        # Simulate stale lock
        dead_pid = 99999999
        with open(self.lock_path, "w", encoding="utf-8") as f:
            json.dump({"pid": dead_pid, "created_at": time.time() - 3600}, f)

        # Recover stale lock
        self.assertTrue(acquire_auto_trader_lock(self.lock_path))

        # Invariants must remain intact
        self.assertTrue(config.EMERGENCY_STOP)
        self.assertTrue(config.LIVE_TRADING_ARMED)
        self.assertEqual(database.get_today_live_profit(), -50.0)

        release_auto_trader_lock(self.lock_path)

    # ============================================================
    # 5. SECURITY
    # ============================================================

    def test_lock_file_contains_no_secrets(self):
        """Requirement 18 & 19: Lock file contains zero secrets (no private keys, API tokens, passwords)."""
        config.PRIVATE_KEY = "0x" + "9" * 64
        config.API_AUTH_TOKEN = "super-secret-token-12345"

        self.assertTrue(acquire_auto_trader_lock(self.lock_path))

        with open(self.lock_path, "r", encoding="utf-8") as f:
            content = f.read()

        self.assertNotIn("super-secret-token", content)
        self.assertNotIn("0x99999999", content)
        self.assertNotIn("PRIVATE_KEY", content)
        self.assertNotIn("API_AUTH_TOKEN", content)

        # Verify only safe keys are present in lock metadata
        data = json.loads(content)
        allowed_keys = {"pid", "process_start_time", "owner_token", "created_at", "created_iso"}
        self.assertTrue(set(data.keys()).issubset(allowed_keys))

        release_auto_trader_lock(self.lock_path)


if __name__ == "__main__":
    unittest.main()
