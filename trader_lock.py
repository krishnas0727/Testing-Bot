"""Auto-Trader Lock Management Module.

Provides process-safe and thread-safe locking for the background auto-trader engine.
Strictly adheres to Phase 6 requirements:
- Prevents duplicate auto-trader instances across processes and threads.
- Inspects and verifies whether the PID holding an existing lock is actively running.
- Protects against PID reuse using process start time / creation timestamps.
- Safely recovers stale locks left behind by crashed or killed processes using an atomic recovery protocol.
- Ensures lock release on normal termination, unhandled exceptions, and via atexit/try-finally.
- Never stores secrets (private keys, API tokens, passwords) in lock files or logs.
- Logs explicit status messages for: lock acquired, lock already exists, stale lock recovered, lock released.
"""

import os
import sys
import time
import json
import uuid
import atexit
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
        try:
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
        except Exception:
            return False
    else:
        # POSIX kill(pid, 0)
        try:
            os.kill(pid, 0)
            return True
        except OSError as err:
            import errno
            return err.errno == errno.EPERM


def get_process_start_time(pid: int) -> Optional[float]:
    """Retrieve process creation timestamp to protect against PID reuse.

    Returns a high-precision timestamp of when the process with `pid` was created,
    or None if the process does not exist or process times cannot be queried.
    """
    if pid <= 0:
        return None

    if os.name == "nt":
        try:
            import ctypes
            from ctypes import wintypes
            kernel32 = ctypes.windll.kernel32
            PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
            handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
            if not handle:
                return None
            try:
                ft_create = wintypes.FILETIME()
                ft_exit = wintypes.FILETIME()
                ft_kernel = wintypes.FILETIME()
                ft_user = wintypes.FILETIME()
                if kernel32.GetProcessTimes(
                    handle,
                    ctypes.byref(ft_create),
                    ctypes.byref(ft_exit),
                    ctypes.byref(ft_kernel),
                    ctypes.byref(ft_user)
                ):
                    val = (ft_create.dwHighDateTime * 4294967296) + ft_create.dwLowDateTime
                    return float(val)
            finally:
                kernel32.CloseHandle(handle)
        except Exception:
            return None
    else:
        # Linux / POSIX: query /proc/[pid]/stat or /proc/[pid] directory ctime
        try:
            stat_path = f"/proc/{pid}/stat"
            if os.path.exists(stat_path):
                with open(stat_path, "r") as f:
                    parts = f.read().split()
                    if len(parts) >= 22:
                        return float(parts[21])
            proc_dir = f"/proc/{pid}"
            if os.path.exists(proc_dir):
                return float(os.stat(proc_dir).st_ctime)
        except Exception:
            pass

    return None


def is_lock_owner_active(lock_info: Dict[str, Any]) -> bool:
    """Verify whether the lock owner identified in `lock_info` is an actively running process.

    Implements PID-reuse safety:
    If `process_start_time` is recorded in the lock file and the running process with that PID
    has a different start time, PID reuse has occurred and the lock is considered STALE.
    """
    if not lock_info or not isinstance(lock_info, dict):
        return False

    pid = lock_info.get("pid")
    if not pid or not isinstance(pid, int) or pid <= 0:
        return False

    # 1. First check if PID is running
    if not is_pid_running(pid):
        return False

    # 2. Check process start time to guard against PID reuse
    recorded_start_time = lock_info.get("process_start_time")
    if recorded_start_time is not None:
        current_start_time = get_process_start_time(pid)
        if current_start_time is not None and abs(current_start_time - recorded_start_time) > 1000:
            # PID was reused by another unrelated process! Lock is stale.
            return False

    return True


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


def _write_lock_file(
    path: str,
    pid: int,
    start_time: Optional[float] = None,
    owner_token: Optional[str] = None
) -> bool:
    """Write lock file with atomic O_CREAT | O_EXCL semantics."""
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    payload_dict = {
        "pid": pid,
        "process_start_time": start_time if start_time is not None else get_process_start_time(pid),
        "owner_token": owner_token or uuid.uuid4().hex,
        "created_at": time.time(),
        "created_iso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    }
    payload = json.dumps(payload_dict)
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


def _recover_stale_lock(target_path: str, current_pid: int) -> bool:
    """Atomically recover a stale lock file and acquire ownership.

    Uses an atomic recovery gate (`.recovery.lock`) with double-check validation to guarantee:
    1. Exactly one process can recover the stale lock during simultaneous attempts.
    2. A newly acquired lock belonging to another process is never deleted.
    3. Stale recovery gate files from crashed processes are cleaned up safely.
    """
    recovery_gate = f"{target_path}.recovery.lock"
    gate_fd = None

    try:
        # 1. Attempt to acquire the recovery gate atomically
        try:
            gate_fd = os.open(recovery_gate, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(gate_fd, f"{current_pid}:{time.time()}".encode("utf-8"))
        except FileExistsError:
            # Another process is currently recovering or a stale gate exists
            gate_info = None
            try:
                with open(recovery_gate, "r", encoding="utf-8") as gf:
                    gate_content = gf.read().strip()
                if ":" in gate_content:
                    parts = gate_content.split(":")
                    gate_pid = int(parts[0])
                    gate_time = float(parts[1])
                    if not is_pid_running(gate_pid) or (time.time() - gate_time > 5.0):
                        # Stale recovery gate left by crashed process
                        try:
                            os.remove(recovery_gate)
                        except OSError:
                            pass
            except Exception:
                pass

            # Wait briefly for contested recovery to finish
            time.sleep(0.05)

            # Double-check if the winner established a valid active lock
            if os.path.exists(target_path):
                current_info = read_lock_info(target_path)
                if current_info and is_lock_owner_active(current_info):
                    return False

            # If still contested, try once more to acquire gate
            try:
                gate_fd = os.open(recovery_gate, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.write(gate_fd, f"{current_pid}:{time.time()}".encode("utf-8"))
            except (FileExistsError, OSError):
                return False

        # 2. Inside recovery gate: DOUBLE-CHECK target_path before modifying!
        if os.path.exists(target_path):
            current_info = read_lock_info(target_path)
            if current_info and is_lock_owner_active(current_info):
                # Another active process now owns the lock! Do NOT remove it.
                return False

            # Safe to remove stale/corrupted lock file
            try:
                os.remove(target_path)
            except OSError as e:
                print(f"[Auto-Trader Lock] Warning: Could not remove stale lock file: {e}", flush=True)

        # 3. Write new lock file for current process
        return _write_lock_file(target_path, current_pid)

    finally:
        if gate_fd is not None:
            try:
                os.close(gate_fd)
            except OSError:
                pass
        try:
            if os.path.exists(recovery_gate):
                os.remove(recovery_gate)
        except OSError:
            pass


def _cleanup_atexit():
    """Release lock on normal interpreter exit."""
    global _active_lock_path
    if _active_lock_path and _is_locked_by_current_process:
        release_auto_trader_lock(_active_lock_path)


def acquire_auto_trader_lock(path: Optional[str] = None) -> bool:
    """Acquire auto-trader execution lock.

    Guarantees:
    - Thread-safety within process (only 1 thread can hold).
    - Process-safety across processes using atomic O_CREAT | O_EXCL.
    - Inspects process table and creation timestamp to prevent PID reuse.
    - Recovers safely from stale locks without race conditions.
    - Releases in-process mutex on any rejected path.
    - Logs clear messages for all lock events.
    """
    global _is_locked_by_current_process, _active_lock_path, _atexit_registered

    target_path = _resolve_lock_path(path)
    current_pid = os.getpid()

    # 1. In-process mutual exclusion: prevent two threads in the same process from running trader
    acquired_thread_lock = _in_process_lock.acquire(blocking=False)
    if not acquired_thread_lock:
        print(
            f"[Auto-Trader Lock] lock already exists: In-process thread already holds lock. "
            f"Auto-trader startup blocked.",
            flush=True
        )
        return False

    # 2. Register normal cleanup hook once
    if not _atexit_registered:
        atexit.register(_cleanup_atexit)
        _atexit_registered = True

    try:
        # 3. Try to acquire the file lock atomically
        if _write_lock_file(target_path, current_pid):
            _is_locked_by_current_process = True
            _active_lock_path = target_path
            print(f"[Auto-Trader Lock] lock acquired (PID: {current_pid}, Path: {target_path})", flush=True)
            return True

        # 4. Lock file already exists: inspect whether the holding PID is alive or stale
        lock_info = read_lock_info(target_path)

        if lock_info is None or "pid" not in lock_info:
            # Check if file was modified in the last 1.0s (might be concurrent write)
            try:
                mtime = os.path.getmtime(target_path)
                if time.time() - mtime < 1.0:
                    time.sleep(0.05)
                    lock_info = read_lock_info(target_path)
            except OSError:
                pass

        if lock_info is None or "pid" not in lock_info:
            # Corrupted or zero-byte lock file left behind by sudden kill
            print(f"[Auto-Trader Lock] stale lock recovered: Unreadable/corrupted lock file at {target_path}", flush=True)
            if _recover_stale_lock(target_path, current_pid):
                _is_locked_by_current_process = True
                _active_lock_path = target_path
                print(f"[Auto-Trader Lock] lock acquired (PID: {current_pid}, Path: {target_path})", flush=True)
                return True
            else:
                return False

        holder_pid = lock_info["pid"]

        if holder_pid == current_pid:
            # Same process already created this file lock
            print(f"[Auto-Trader Lock] lock already exists: Already held by current process (PID: {current_pid})", flush=True)
            return False

        # Check whether the holder process is actually active (and not a reused PID)
        if is_lock_owner_active(lock_info):
            # The other process is actively running: do NOT remove lock!
            print(
                f"[Auto-Trader Lock] lock already exists: Active process PID {holder_pid} is running. "
                f"Auto-trader startup blocked.",
                flush=True
            )
            return False

        # Holder process is dead or PID was reused: stale lock recovered!
        print(
            f"[Auto-Trader Lock] stale lock recovered: Process PID {holder_pid} is no longer running. "
            f"Removing stale lock at {target_path}.",
            flush=True
        )

        if _recover_stale_lock(target_path, current_pid):
            _is_locked_by_current_process = True
            _active_lock_path = target_path
            print(f"[Auto-Trader Lock] lock acquired (PID: {current_pid}, Path: {target_path})", flush=True)
            return True

        # Another process won the recovery race
        print(f"[Auto-Trader Lock] lock already exists: Contested race condition. Auto-trader startup blocked.", flush=True)
        return False

    finally:
        # If lock was not successfully acquired, release the in-process thread lock
        if not _is_locked_by_current_process:
            if _in_process_lock.locked():
                try:
                    _in_process_lock.release()
                except RuntimeError:
                    pass


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


def is_auto_trader_locked(path: Optional[str] = None) -> bool:
    """Return True if an active, valid auto-trader lock currently exists."""
    target_path = _resolve_lock_path(path)
    if not os.path.exists(target_path):
        return False
    lock_info = read_lock_info(target_path)
    return is_lock_owner_active(lock_info)


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
