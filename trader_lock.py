"""Auto-Trader Lock Management Module.

Provides process-safe and thread-safe locking for the background auto-trader engine.
Strictly adheres to Phase 6 requirements:
- Prevents duplicate auto-trader instances across processes and threads.
- Inspects and verifies whether the PID holding an existing lock is actively running.
- Safely recovers stale locks left behind by crashed or killed processes.
- Ensures lock release on normal termination, unhandled exceptions, and via atexit/try-finally.
- Logs explicit status messages for: lock acquired, lock already exists, stale lock recovered, lock released.
"""

import os
import sys
import time
import json
import atexit
import signal
import threading
from typing import Optional, Dict, Any
from contextlib import contextmanager

try:
    import config
except ImportError:
    config = None


_in_process_lock = threading.Lock()
_is_locked_by_current_process = False
_active_lock_path: Optional[str] = None
_atexit_registered = False


def is_pid_running(pid: int) -> bool:
    """Check whether a process with the given PID is actively running."""
    if pid <= 0:
        return False

    if os.name == "nt":
        # Windows API process check
        import ctypes
        from ctypes import wintypes
        kernel32 = ctypes.windll.kernel32
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        STILL_ACTIVE = 259

        handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            ERROR_ACCESS_DENIED = 5
            return kernel32.GetLastError() == ERROR_ACCESS_DENIED

        try:
            exit_code = wintypes.DWORD()
            if kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
                return exit_code.value == STILL_ACTIVE
            return True
        finally:
            kernel32.CloseHandle(handle)
    else:
        # POSIX kill(pid, 0)
        try:
            os.kill(pid, 0)
            return True
        except OSError as err:
            import errno
            return err.errno == errno.EPERM


def _resolve_lock_path(path: Optional[str] = None) -> str:
    """Resolve target auto-trader lock path."""
    if path:
        return os.path.abspath(path)
    if config and hasattr(config, "AUTO_TRADER_LOCK_PATH") and config.AUTO_TRADER_LOCK_PATH:
        return os.path.abspath(config.AUTO_TRADER_LOCK_PATH)
    data_dir = getattr(config, "DATA_DIR", "data") if config else "data"
    return os.path.abspath(os.path.join(data_dir, "auto_trader.lock"))


def read_lock_info(path: str) -> Optional[Dict[str, Any]]:
    """Read PID and metadata from an existing lock file."""
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            content = f.read().strip()
        if not content:
            return None
        # Try JSON format first
        try:
            data = json.loads(content)
            if isinstance(data, dict) and "pid" in data:
                return data
        except json.JSONDecodeError:
            pass

        # Legacy plain integer PID format
        pid = int(content)
        return {"pid": pid, "created_at": os.path.getmtime(path)}
    except Exception:
        return None


def _write_lock_file(path: str, pid: int) -> bool:
    """Write lock file with atomic O_CREAT | O_EXCL semantics."""
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    payload = json.dumps({
        "pid": pid,
        "created_at": time.time(),
        "created_iso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    })
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(payload)
        return True
    except FileExistsError:
        return False
    except Exception as e:
        print(f"[Auto-Trader Lock] Unexpected error creating lock file: {e}", flush=True)
        return False


def _cleanup_atexit():
    """Release lock on normal interpreter exit."""
    global _active_lock_path
    if _active_lock_path and _is_locked_by_current_process:
        release_auto_trader_lock(_active_lock_path)


def acquire_auto_trader_lock(path: Optional[str] = None) -> bool:
    """Acquire auto-trader execution lock.

    Guarantees:
    - Thread-safety within process.
    - Process-safety across processes using atomic file creation.
    - Inspects process table before removing any stale lock file.
    - Recovers safely from stale locks if holding PID is dead.
    - Logs clear messages for all lock events.
    """
    global _is_locked_by_current_process, _active_lock_path, _atexit_registered

    target_path = _resolve_lock_path(path)
    current_pid = os.getpid()

    # 1. In-process mutual exclusion: prevent two threads in the same process from running trader
    acquired_thread_lock = _in_process_lock.acquire(blocking=False)
    if not acquired_thread_lock:
        print(f"[Auto-Trader Lock] lock already exists: In-process thread already holds lock. Auto-trader startup blocked.", flush=True)
        return False

    # 2. Register normal cleanup hook once
    if not _atexit_registered:
        atexit.register(_cleanup_atexit)
        _atexit_registered = True

    # 3. Try to acquire the file lock atomically
    if _write_lock_file(target_path, current_pid):
        _is_locked_by_current_process = True
        _active_lock_path = target_path
        print(f"[Auto-Trader Lock] lock acquired (PID: {current_pid}, Path: {target_path})", flush=True)
        return True

    # 4. Lock file already exists: inspect whether the holding PID is alive or stale
    lock_info = read_lock_info(target_path)

    if lock_info is None or "pid" not in lock_info:
        # Corrupted or zero-byte lock file left behind by sudden kill
        print(f"[Auto-Trader Lock] stale lock recovered: Unreadable/corrupted lock file at {target_path}", flush=True)
        try:
            os.remove(target_path)
        except OSError:
            pass
        if _write_lock_file(target_path, current_pid):
            _is_locked_by_current_process = True
            _active_lock_path = target_path
            print(f"[Auto-Trader Lock] lock acquired (PID: {current_pid}, Path: {target_path})", flush=True)
            return True
        else:
            _in_process_lock.release()
            return False

    holder_pid = lock_info["pid"]

    if holder_pid == current_pid:
        # Same process already created this file lock
        print(f"[Auto-Trader Lock] lock already exists: Already held by current process (PID: {current_pid})", flush=True)
        return False

    # Check whether the holder PID is actually running
    if is_pid_running(holder_pid):
        # The other process is actively running: do NOT remove lock!
        print(
            f"[Auto-Trader Lock] lock already exists: Active process PID {holder_pid} is running. "
            f"Auto-trader startup blocked.",
            flush=True
        )
        _in_process_lock.release()
        return False

    # Holder PID is dead / not running: stale lock recovered!
    print(
        f"[Auto-Trader Lock] stale lock recovered: Process PID {holder_pid} is no longer running. "
        f"Removing stale lock at {target_path}.",
        flush=True
    )
    try:
        os.remove(target_path)
    except OSError as e:
        print(f"[Auto-Trader Lock] Warning: Could not remove stale lock file: {e}", flush=True)

    # Attempt to acquire after stale lock recovery
    if _write_lock_file(target_path, current_pid):
        _is_locked_by_current_process = True
        _active_lock_path = target_path
        print(f"[Auto-Trader Lock] lock acquired (PID: {current_pid}, Path: {target_path})", flush=True)
        return True

    # Another process took the lock in a race condition
    _in_process_lock.release()
    print(f"[Auto-Trader Lock] lock already exists: Contested race condition. Auto-trader startup blocked.", flush=True)
    return False


def release_auto_trader_lock(path: Optional[str] = None, force: bool = False) -> bool:
    """Release the auto-trader lock if owned by the current process.

    Returns True if successfully removed/released, False otherwise.
    """
    global _is_locked_by_current_process, _active_lock_path

    target_path = _resolve_lock_path(path)
    current_pid = os.getpid()

    released = False
    try:
        if os.path.exists(target_path):
            lock_info = read_lock_info(target_path)
            holder_pid = lock_info.get("pid") if lock_info else None

            if force or holder_pid == current_pid or holder_pid is None:
                try:
                    os.remove(target_path)
                    released = True
                    print(f"[Auto-Trader Lock] lock released (PID: {current_pid}, Path: {target_path})", flush=True)
                except OSError as e:
                    print(f"[Auto-Trader Lock] Error removing lock file during release: {e}", flush=True)
            else:
                print(f"[Auto-Trader Lock] Refusing to release lock held by another active process (PID: {holder_pid})", flush=True)
        else:
            released = True
    finally:
        _is_locked_by_current_process = False
        _active_lock_path = None
        if _in_process_lock.locked():
            try:
                _in_process_lock.release()
            except RuntimeError:
                pass

    return released


@contextmanager
def auto_trader_lock_context(path: Optional[str] = None):
    """Context manager for auto-trader execution with guaranteed try/finally cleanup."""
    acquired = acquire_auto_trader_lock(path=path)
    if not acquired:
        raise RuntimeError("Could not acquire auto-trader lock.")
    try:
        yield
    finally:
        release_auto_trader_lock(path=path)
