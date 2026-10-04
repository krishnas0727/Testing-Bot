"""Unit Tests for Auto-Trader Lock System (Phase 6).

Strictly verifies Phase 6 requirements:
1. First process acquires lock successfully.
2. Second process / thread is blocked while lock is held.
3. Normal shutdown releases the lock safely.
4. Stale lock recovery works when holding process terminates abnormally.
5. Two auto-trader instances cannot trade simultaneously.
6. Does not remove lock if another process is actively running.
7. Logs clear information for all lock events (acquired, already exists, stale lock recovered, released).
"""

import os
import sys
import json
import time
import io
import unittest
import tempfile
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import config
from trader_lock import (
    acquire_auto_trader_lock,
    release_auto_trader_lock,
    auto_trader_lock_context,
    is_pid_running,
    read_lock_info,
)


class TestAutoTraderLock(unittest.TestCase):
    def setUp(self):
        self.tmp_dir = tempfile.TemporaryDirectory()
        self.lock_path = os.path.join(self.tmp_dir.name, "test_auto_trader.lock")
        # Ensure any previous state is clean
        release_auto_trader_lock(self.lock_path, force=True)

    def tearDown(self):
        release_auto_trader_lock(self.lock_path, force=True)
        self.tmp_dir.cleanup()

    def test_first_process_acquires_lock(self):
        """Requirement 9: First process acquires lock successfully."""
        captured_stdout = io.StringIO()
        with patch("sys.stdout", captured_stdout):
            success = acquire_auto_trader_lock(self.lock_path)

        self.assertTrue(success)
        self.assertTrue(os.path.exists(self.lock_path))

        # Check lock file metadata
        info = read_lock_info(self.lock_path)
        self.assertIsNotNone(info)
        self.assertEqual(info["pid"], os.getpid())

        # Check log message (Requirement 8)
        log_output = captured_stdout.getvalue()
        self.assertIn("lock acquired", log_output)

    def test_second_process_is_blocked(self):
        """Requirement 6 & 9: Second process is blocked while lock is held."""
        # First acquisition succeeds
        self.assertTrue(acquire_auto_trader_lock(self.lock_path))

        # Second acquisition attempt must fail
        captured_stdout = io.StringIO()
        with patch("sys.stdout", captured_stdout):
            second_attempt = acquire_auto_trader_lock(self.lock_path)

        self.assertFalse(second_attempt)

        # Check log message (Requirement 8)
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

        # Check log message (Requirement 8)
        log_output = captured_stdout.getvalue()
        self.assertIn("lock released", log_output)

        # After release, lock can be acquired again
        self.assertTrue(acquire_auto_trader_lock(self.lock_path))

    def test_context_manager_try_finally_releases_lock(self):
        """Requirement 4: Use try/finally or an equivalent cleanup mechanism."""
        self.assertFalse(os.path.exists(self.lock_path))

        with auto_trader_lock_context(self.lock_path):
            self.assertTrue(os.path.exists(self.lock_path))

        # Released automatically on block exit
        self.assertFalse(os.path.exists(self.lock_path))

    def test_stale_lock_recovery_with_dead_pid(self):
        """Requirement 5, 7, & 9: Handle stale locks safely after abnormal termination."""
        dead_pid = 99999999  # Guaranteed inactive PID
        self.assertFalse(is_pid_running(dead_pid))

        # Simulate stale lock file left behind by crashed process
        with open(self.lock_path, "w", encoding="utf-8") as f:
            json.dump({"pid": dead_pid, "created_at": time.time() - 3600}, f)

        self.assertTrue(os.path.exists(self.lock_path))

        captured_stdout = io.StringIO()
        with patch("sys.stdout", captured_stdout):
            acquired = acquire_auto_trader_lock(self.lock_path)

        self.assertTrue(acquired)
        info = read_lock_info(self.lock_path)
        self.assertEqual(info["pid"], os.getpid())

        # Check log output confirms stale lock recovery (Requirement 8)
        log_output = captured_stdout.getvalue()
        self.assertIn("stale lock recovered", log_output)
        self.assertIn("lock acquired", log_output)

    def test_stale_lock_recovery_with_legacy_format(self):
        """Verify recovery of legacy plain integer PID lock file (e.g. old auto_trader.lock)."""
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

    def test_active_process_lock_is_not_removed(self):
        """Requirement 7: Verify whether another process is actually running before removing."""
        other_active_pid = 12345
        with open(self.lock_path, "w", encoding="utf-8") as f:
            json.dump({"pid": other_active_pid, "created_at": time.time()}, f)

        # Mock is_pid_running to simulate an active running process
        with patch("trader_lock.is_pid_running", return_value=True):
            captured_stdout = io.StringIO()
            with patch("sys.stdout", captured_stdout):
                acquired = acquire_auto_trader_lock(self.lock_path)

            self.assertFalse(acquired)
            # The active lock must NOT be deleted
            self.assertTrue(os.path.exists(self.lock_path))
            info = read_lock_info(self.lock_path)
            self.assertEqual(info["pid"], other_active_pid)

            log_output = captured_stdout.getvalue()
            self.assertIn("lock already exists", log_output)

    def test_two_autotrader_instances_cannot_trade_simultaneously(self):
        """Requirement 6 & 9: Two auto-trader instances cannot trade simultaneously."""
        executions = []

        def mock_worker(worker_id):
            if acquire_auto_trader_lock(self.lock_path):
                try:
                    executions.append(f"worker_{worker_id}_started")
                    time.sleep(0.05)
                    executions.append(f"worker_{worker_id}_finished")
                finally:
                    release_auto_trader_lock(self.lock_path)
            else:
                executions.append(f"worker_{worker_id}_blocked")

        import threading
        t1 = threading.Thread(target=mock_worker, args=(1,))
        t2 = threading.Thread(target=mock_worker, args=(2,))

        t1.start()
        time.sleep(0.01)  # Ensure t1 acquires first
        t2.start()

        t1.join()
        t2.join()

        # Worker 1 ran, Worker 2 was blocked
        self.assertIn("worker_1_started", executions)
        self.assertIn("worker_1_finished", executions)
        self.assertIn("worker_2_blocked", executions)
        self.assertNotIn("worker_2_started", executions)


if __name__ == "__main__":
    unittest.main()
