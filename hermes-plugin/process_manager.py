"""Subprocess lifecycle manager for the vrc-monitor Node.js service.

Single active process at a time. Stores the running pid + metadata in
``$HERMES_HOME/workspace/vrc-monitor/.active.json`` so tool calls across
turns can find the process and ``on_session_start`` can idempotently
launch it.

The service runs as a detached subprocess — we don't hold file
descriptors open, so the parent agent loop can't block on it.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
import urllib.request
from pathlib import Path
from typing import Any, Dict, Optional

from hermes_constants import get_hermes_home

# ── file layout ────────────────────────────────────────────────────────
#
#   $HERMES_HOME/workspace/vrc-monitor/
#       .active.json       # {pid, started_at, log_file}
#       monitor.log        # stdout + stderr of the Node process

# ── path resolution ────────────────────────────────────────────────────

MONITOR_SCRIPT = "start-monitor.js"
HEALTH_URL = "http://127.0.0.1:8799/health"


def _config_path() -> Path:
    """Absolute path to the plugin-local config.json."""
    return _root() / "config.json"


def _resolve_monitor_dir() -> Optional[str]:
    """Resolve ``monitor_dir`` (priority):
    1. env ``VRC_MONITOR_DIR``
    2. auto-detect: current working directory if start-monitor.js exists
    3. None  → caller must report error
    """
    env_val = os.environ.get("VRC_MONITOR_DIR")
    if env_val:
        return env_val
    cwd = os.getcwd()
    if (Path(cwd) / MONITOR_SCRIPT).is_file():
        return cwd
    return None


def _resolve_node_exe() -> Optional[str]:
    """Resolve ``node_exe`` (priority):
    1. env ``VRC_MONITOR_NODE``
    2. ``shutil.which("node")``
    3. None  → caller must report error
    """
    env_val = os.environ.get("VRC_MONITOR_NODE")
    if env_val:
        return env_val
    resolved = shutil.which("node")
    if resolved:
        return resolved
    return None


def _root() -> Path:
    return Path(get_hermes_home()) / "workspace" / "vrc-monitor"


def _state_file() -> Path:
    return _root() / ".active.json"


def _log_file() -> Path:
    return _root() / "monitor.log"


# ── helpers ────────────────────────────────────────────────────────────


def _pid_alive(pid: int) -> bool:
    """Cross-platform check: does a process with *pid* exist?

    Delegates to ``gateway.status._pid_exists`` — do NOT hand-roll with
    ``os.kill(pid, 0)`` because on Windows that routes through
    GenerateConsoleCtrlEvent and is not a no-op.
    """
    from gateway.status import _pid_exists

    return _pid_exists(pid)


def _read_state() -> Optional[Dict[str, Any]]:
    p = _state_file()
    if not p.is_file():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def _write_state(data: Dict[str, Any]) -> None:
    p = _state_file()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    tmp.replace(p)


def _clear_state() -> None:
    try:
        _state_file().unlink()
    except FileNotFoundError:
        pass


def _health_check(timeout: float = 3.0) -> Dict[str, Any]:
    """GET :8799/health and return parsed JSON, or an error dict."""
    try:
        req = urllib.request.Request(HEALTH_URL)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body)
    except Exception as e:
        return {"error": str(e)}


def _find_monitor_pid() -> Optional[int]:
    """Locate the process running start-monitor.js.

    Tries two methods:
    1. ``netstat -ano`` — find the pid LISTENING on 127.0.0.1:8799.
       Most reliable: works even when the state file has no pid, wmic
       is unavailable, or the command line doesn't mention the script.
    2. ``wmic process where name='node.exe' get processid,commandline``
       — match by command line containing start-monitor.js.

    Returns None when the process cannot be found. Defensive: never raises.
    """
    # Method 1: port listener (netstat).
    try:
        out = subprocess.run(
            ["netstat", "-ano"], capture_output=True, text=True, timeout=10
        )
        if out.returncode == 0:
            for line in out.stdout.splitlines():
                if "127.0.0.1:8799" in line and "LISTENING" in line.upper():
                    tail = line.strip().split()[-1]
                    if tail.isdigit():
                        return int(tail)
    except Exception:
        pass

    # Method 2: wmic command-line match.
    try:
        out = subprocess.run(
            [
                "wmic",
                "process",
                "where",
                "name='node.exe'",
                "get",
                "processid,commandline",
                "/format:csv",
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if out.returncode != 0:
            return None
        for line in out.stdout.splitlines():
            if MONITOR_SCRIPT not in line:
                continue
            # CSV: ProcessId is the last column, so the field after the
            # final comma is the pid even if the command line has commas.
            tail = line.rsplit(",", 1)[-1].strip()
            if tail.isdigit():
                return int(tail)
        return None
    except Exception:
        return None


# ── public API ─────────────────────────────────────────────────────────


def status() -> Dict[str, Any]:
    """Return the current process state and health.

    Returns a dict::

        {
            "ok": true|false,
            "running": true|false,
            "pid": int|None,
            "health": {...} or None,
            "started_at": float|None,
            "log_file": str|None,
            "inferred": true|false,  # running detected via health probe, no known pid
        }

    All exceptions are caught — this function never raises.
    """
    try:
        active = _read_state()
    except Exception as e:
        return {
            "ok": False,
            "running": False,
            "pid": None,
            "health": None,
            "started_at": None,
            "log_file": None,
            "inferred": False,
            "error": str(e),
        }

    pid = 0
    started_at = None
    log_file = None
    if active:
        try:
            pid = int(active.get("pid", 0))
        except Exception:
            pid = 0
        started_at = active.get("started_at")
        log_file = active.get("log_file")

    try:
        alive = _pid_alive(pid) if pid else False
    except Exception:
        alive = False

    # If the recorded pid is dead (or the state file is missing entirely),
    # fall back to a health probe: the service may still be running, e.g.
    # it was started manually before the plugin was installed.
    inferred = False
    health = None
    try:
        probed = _health_check()
    except Exception:
        probed = None
    if probed is not None and "error" not in probed:
        health = probed
        if not alive:
            inferred = True
            pid = None

    return {
        "ok": True,
        "running": alive or inferred,
        "pid": pid,
        "health": health,
        "started_at": started_at,
        "log_file": log_file,
        "inferred": inferred,
        "resolved": {
            "monitor_dir": _resolve_monitor_dir(),
            "node_exe": _resolve_node_exe(),
        },
    }


def start() -> Dict[str, Any]:
    """Spawn the vrc-monitor Node.js process (detached).

    Idempotent: if already running, returns current status.
    All exceptions are caught — this function never raises.
    """
    try:
        current = status()
        if current.get("running"):
            # Already running (pid alive or health probe) — refresh the
            # state record so later calls can find it; when inferred there
            # is no known pid, so record pid: null rather than spawning a
            # duplicate instance that would fight over port 8799.
            record = {
                "pid": current.get("pid"),
                "started_at": current.get("started_at"),
                "log_file": current.get("log_file"),
            }
            # Inferred state: status() reports running via health probe but
            # has no pid. Backfill the real pid so a later stop() can target
            # the process directly; if it can't be found, keep pid: null.
            if not record["pid"]:
                try:
                    record["pid"] = _find_monitor_pid()
                except Exception:
                    record["pid"] = None
            try:
                _write_state(record)
            except Exception:
                pass
            return {
                "ok": True,
                "already_running": True,
                **current,
            }
    except Exception as e:
        return {
            "ok": False,
            "error": f"pre-start status check failed: {e}",
        }

    # Ensure workspace directory exists.
    try:
        _root().mkdir(parents=True, exist_ok=True)
    except Exception as e:
        return {
            "ok": False,
            "error": f"failed to create workspace dir: {e}",
        }

    log_path = _log_file()
    try:
        log_fh = open(str(log_path), "ab", buffering=0)
    except Exception as e:
        return {
            "ok": False,
            "error": f"failed to open log file {log_path}: {e}",
        }

    node_exe = _resolve_node_exe()
    if not node_exe:
        log_fh.close()
        return {
            "ok": False,
            "error": "未找到 node：请安装 Node.js 或设置 VRC_MONITOR_NODE",
        }
    monitor_dir = _resolve_monitor_dir()
    if not monitor_dir:
        log_fh.close()
        return {
            "ok": False,
            "error": "未找到服务目录：请设置环境变量 VRC_MONITOR_DIR 指向克隆的仓库目录，或参考仓库 AGENTS.md 配置",
        }

    try:
        proc = subprocess.Popen(
            [node_exe, MONITOR_SCRIPT],
            cwd=monitor_dir,
            stdin=subprocess.DEVNULL,
            stdout=log_fh,
            stderr=subprocess.STDOUT,
            start_new_session=True,
            close_fds=True,
        )
    except Exception as e:
        log_fh.close()
        return {
            "ok": False,
            "error": f"failed to spawn node process: {e}",
        }
    finally:
        log_fh.close()

    record = {
        "pid": proc.pid,
        "started_at": time.time(),
        "log_file": str(log_path),
    }
    try:
        _write_state(record)
    except Exception as e:
        return {
            "ok": True,
            "pid": proc.pid,
            "started_at": record["started_at"],
            "log_file": record["log_file"],
            "warning": f"process started but state file write failed: {e}",
        }

    return {
        "ok": True,
        "pid": proc.pid,
        "started_at": record["started_at"],
        "log_file": record["log_file"],
    }


def stop() -> Dict[str, Any]:
    """Terminate the vrc-monitor process.

    Uses ``taskkill /PID <pid> /T /F`` on Windows for reliable
    tree termination.  Idempotent — no-ops cleanly if nothing is
    running.

    All exceptions are caught — this function never raises.
    """
    try:
        active = _read_state()
    except Exception as e:
        return {"ok": False, "error": f"failed to read state: {e}"}

    if not active:
        # State file missing, but the service may still be running
        # (e.g. started manually). Try to locate the real pid.
        try:
            pid = _find_monitor_pid()
        except Exception:
            pid = None
        if not pid:
            health = _health_check()
            if health is not None and "error" not in health:
                return {
                    "ok": False,
                    "error": "服务在运行但无法定位 pid, 请手动 taskkill 或重启 Hermes",
                }
            return {"ok": True, "reason": "no active process (state missing)"}

    pid = active.get("pid") if active else pid

    # pid may be null (inferred state: service started manually, plugin
    # never learned its pid). Try to locate the real pid before giving up.
    if not pid:
        try:
            pid = _find_monitor_pid()
        except Exception:
            pid = None
        if not pid:
            health = _health_check()
            if health is not None and "error" not in health:
                return {
                    "ok": False,
                    "error": "服务在运行但无法定位 pid, 请手动 taskkill 或重启 Hermes",
                }
            _clear_state()
            return {"ok": True, "reason": "not running — cleared stale state"}

    if not _pid_alive(pid):
        _clear_state()
        return {"ok": True, "reason": f"pid {pid} already dead — cleared state"}

    # Windows: use taskkill for reliable tree termination.
    try:
        subprocess.run(
            ["taskkill", "/PID", str(pid), "/T", "/F"],
            capture_output=True,
            timeout=10,
        )
    except Exception as e:
        return {
            "ok": False,
            "error": f"taskkill failed: {e}",
        }

    # Brief wait for the process to actually exit.
    for _ in range(10):
        if not _pid_alive(pid):
            break
        time.sleep(0.3)

    # Verify the process actually died. If it is still alive after the
    # wait, report failure instead of a false "terminated" — otherwise
    # restart() would believe stop succeeded, health probe still answers,
    # and start() would return already_running with the old process intact.
    if _pid_alive(pid):
        _clear_state()
        return {
            "ok": False,
            "error": f"进程 {pid} 在 taskkill 后仍然存活（3 秒等待超时），无法停止",
        }

    _clear_state()
    return {
        "ok": True,
        "reason": "process terminated",
        "pid": pid,
    }


def restart() -> Dict[str, Any]:
    """Stop the current process (if any) and start a new one.

    True restart semantics: the old process must actually be gone
    before a new one is spawned. If the old process cannot be stopped
    (e.g. pid could not be located and the service is still alive),
    returns an error instead of silently no-op'ing — previously a
    failed stop() was swallowed and start() then returned
    ``already_running`` because the health probe still answered, so
    code changes never took effect.

    All exceptions are caught — this function never raises.
    """
    try:
        st = stop()
    except Exception as e:
        return {"ok": False, "error": f"stop failed during restart: {e}"}

    if not st.get("ok"):
        # stop() failed — check whether the service is actually gone.
        if st.get("error") and "无法定位 pid" in str(st.get("error")):
            return {"ok": False, "error": st["error"]}
        # Any other stop failure: verify by health probe.
        health = _health_check()
        if health is not None and "error" not in health:
            return {"ok": False, "error": f"旧进程未能停止: {st.get('error') or 'unknown'}"}
        # Service is actually down — proceed to start.

    # Give the port a moment to fully release before spawning.
    for _ in range(20):
        health = _health_check(timeout=1.0)
        if health is None or "error" in health:
            break
        time.sleep(0.3)
    else:
        # The loop completed without the health probe failing — the old
        # process is still answering. Do NOT start() a new one (start()
        # would see the running service and return already_running,
        # making the restart a silent no-op).
        return {
            "ok": False,
            "error": "旧进程未能在 6 秒内停止（health probe 持续响应），重启中止",
        }

    return start()
