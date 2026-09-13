"""Subprocess lifecycle manager for the vrc-monitor Node.js service.

Single active process at a time. Stores the running pid + metadata in
``$HERMES_HOME/workspace/vrc-monitor/.active.json`` so tool calls across
turns can find the process and ``on_session_start`` can idempotently
launch it.

The service runs as a detached subprocess — we don't hold file
descriptors open, so the parent agent loop can't block on it.
"""

from __future__ import annotations

import gzip
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

# stdout capture file (monitor.log) grows unbounded without rotation (3.7MB
# observed in the wild). Threshold/keep align with core/logger.js defaults
# (maxSize 10MB / maxFiles 5); archive naming matches logger.js doRotate():
# monitor-<UTC YYYYMMDD-HHMMSS>-<pid>.log.gz. Threshold overridable via env
# VRC_MONITOR_CAPTURE_LOG_MAX_SIZE (bytes) — 只管本插件捕获的
# $HERMES_HOME/workspace/vrc-monitor/monitor.log，与 logger 模块结构化日志的
# VRC_MONITOR_LOGGER_MAX_SIZE 不同名不同义，勿混用（PR #189 审查 ⚠️2 改名）。
MAX_LOG_SIZE = 10 * 1024 * 1024
MAX_ARCHIVES = 5


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


# ── log rotation ───────────────────────────────────────────────────────


def _max_log_size_from_env() -> int:
    """VRC_MONITOR_CAPTURE_LOG_MAX_SIZE 覆盖捕获文件轮转阈值（字节）。

    只认新名：旧名 VRC_MONITOR_LOG_MAX_SIZE 是 PR #189 审查前的未发布命名
    （从未登记进文档），直接废弃不兼容——PR 未合并，无兼容负担。
    """
    raw = os.environ.get("VRC_MONITOR_CAPTURE_LOG_MAX_SIZE")
    if raw:
        try:
            value = int(raw)
            if value > 0:
                return value
        except ValueError:
            pass
    return MAX_LOG_SIZE


def _prune_archives(directory: Path, keep: int) -> list:
    """Delete oldest archives beyond *keep* (mtime order, shared budget).

    Matches both ``monitor-*.log.gz`` and uncompressed ``monitor-*.log`` —
    gzip 失败会遗留未压缩的 monitor-<ts>-<pid>.log，只 glob .gz 会让它永久
    残留（PR #189 审查 💡1）。两类共享同一个 keep 预算（总数口径），避免
    各留 N 份。active 文件 monitor.log 不含 "monitor-<ts>-" 前缀，两个
    glob 都匹配不到它，永远不会被误删。
    """
    candidates = list(directory.glob("monitor-*.log.gz")) + list(
        directory.glob("monitor-*.log")
    )
    candidates.sort(key=lambda f: f.stat().st_mtime)
    removed = []
    while len(candidates) > keep:
        oldest = candidates.pop(0)
        oldest.unlink()
        removed.append(oldest.name)
    return removed


def _copytruncate_rotate(p: Path, keep_n: int, size: int) -> Dict[str, Any]:
    """rename 被占用时的运行中轮转兜底：copy → gzip 归档 → truncate(0)。

    竞态（微秒级，与 Unix logrotate copytruncate 同性质）：拷贝与清空之间
    子进程新写入的行会随 truncate 一起消失。缓解：最多 3 次「stat 得 S1 →
    读内容 → 再 stat 得 S2」，仅当 S2 == S1（期间无新写入）才执行归档与
    truncate；3 次都稳定不下来说明子进程在持续高频写入，此时仍用最后一次
    读到的快照执行（否则文件无限增长、轮转失去意义），最多丢失最后一次读
    与 truncate 之间的窗口行。归档命名与 rename 路径一致（对齐
    core/logger.js doRotate()）。
    """
    ts = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
    gz_path = p.with_name(f"monitor-{ts}-{os.getpid()}.log.gz")
    data = b""
    for _ in range(3):
        s1 = p.stat().st_size
        with open(p, "rb") as f_in:
            data = f_in.read()
        s2 = p.stat().st_size
        if s2 == s1:
            break
    # 先写归档、后 truncate：gzip 失败时 active 文件保持原样，零损失。
    with gzip.open(gz_path, "wb") as f_out:
        f_out.write(data)
    with open(p, "r+b") as f:
        f.truncate(0)
    try:
        removed = _prune_archives(p.parent, keep_n)
    except Exception:
        # 归档清理失败不影响本次轮转结果（与 rename 路径同策略）。
        removed = []
    return {
        "ok": True,
        "rotated": True,
        "archive": gz_path.name,
        "size": size,
        "kept": keep_n,
        "removed": removed,
        "method": "copytruncate",
    }


def rotate_log_if_needed(path, max_size=None, keep=None) -> Dict[str, Any]:
    """Rotate *path* once if it reached the size threshold. Pure function.

    Checked at process start AND on every ``status()`` call (long-running
    service without restart would otherwise never cross the threshold again).
    Rotation tries ``rename`` first (atomic, lossless) and falls back to
    ``copytruncate`` when the file is held open by the child (Windows:
    rename fails with WinError 32). Never raises — failures are reported via
    the return dict so the caller can degrade to plain append:

      {"ok": True,  "rotated": False, "reason": "missing"|"below_threshold",
       "size": int, "threshold": int}
      {"ok": True,  "rotated": True,  "archive": "<name>.gz", "size": int,
       "kept": int, "removed": [<names>], "method": "rename"|"copytruncate"}
      {"ok": False, "rotated": False, "error": "<reason>"}

    After a successful rotation the active file is empty (rename: recreated;
    copytruncate: truncated in place), ready for continued append-mode writes.
    """
    p = Path(path)
    limit = max_size if max_size is not None else _max_log_size_from_env()
    keep_n = keep if keep is not None else MAX_ARCHIVES
    try:
        if not p.is_file():
            return {
                "ok": True,
                "rotated": False,
                "reason": "missing",
                "size": 0,
                "threshold": limit,
            }
        size = p.stat().st_size
        if size < limit:
            return {
                "ok": True,
                "rotated": False,
                "reason": "below_threshold",
                "size": size,
                "threshold": limit,
            }
        # UTC YYYYMMDD-HHMMSS + pid, same naming as core/logger.js doRotate()
        ts = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
        rotated = p.with_name(f"monitor-{ts}-{os.getpid()}.log")
        try:
            p.rename(rotated)
        except OSError:
            # Windows 下子进程持有 stdout 句柄时运行中 rename 必失败
            # （WinError 32「另一个程序正在使用此文件」，已实测）；启动时
            # （无句柄）才会走到上面这条 rename 原子路径。回退 copytruncate。
            return _copytruncate_rotate(p, keep_n, size)
        gz_path = Path(str(rotated) + ".gz")
        with open(rotated, "rb") as f_in, gzip.open(gz_path, "wb") as f_out:
            shutil.copyfileobj(f_in, f_out)
        rotated.unlink()
        try:
            removed = _prune_archives(p.parent, keep_n)
        except Exception:
            # 归档清理失败（占用/权限）不影响本次轮转结果，与 core/logger.js
            # cleanupOldLogs() 同策略：清理是尽力而为，不降级、不阻断、不误报轮转失败。
            removed = []
        p.touch()  # recreate the active file so append-mode open can proceed
        return {
            "ok": True,
            "rotated": True,
            "archive": gz_path.name,
            "size": size,
            "kept": keep_n,
            "removed": removed,
            "method": "rename",
        }
    except Exception as e:
        return {"ok": False, "rotated": False, "error": str(e)}


def _rotate_log_with_notice(
    log_path: Path, write_skip: bool = True
) -> Dict[str, Any]:
    """One rotation check, one log line per non-skip branch (into the active
    capture file), result dict always returned.

    ``write_skip=True``（start() 钩子）：低频事件，允许写「跳过（未达阈值）」
    行。``write_skip=False``（status() 钩子）：vrc_status 是 Agent 高频调用，
    若每次都写一行「跳过」，捕获文件会变成新的刷屏源——该分支静默，结果改由
    status() 返回的 ``log_capture`` 字段可见。轮转成功 / 失败两个分支在两个
    钩子里都各写一行（禁静默降级）。任何异常——包括写 notice 行本身失败——
    都被吞掉：轮转问题必须永不阻断启动或状态查询，降级为纯追加。
    """
    try:
        result = rotate_log_if_needed(log_path)
    except Exception as e:
        result = {"ok": False, "rotated": False, "error": str(e)}
    if result.get("ok") is False:
        line = f"[plugin] 日志轮转失败（不阻断启动/不影响本次状态查询，继续追加）：{result.get('error')}"
    elif result.get("rotated"):
        size_mb = result.get("size", 0) / (1024 * 1024)
        method = result.get("method", "rename")
        if method == "copytruncate":
            line = (
                f"[plugin] 日志轮转: monitor.log ({size_mb:.1f}MB) → "
                f"{result.get('archive')}（方式 copytruncate，运行中无法 rename，"
                f"保留 {result.get('kept')} 个归档）"
            )
        else:
            line = (
                f"[plugin] 日志轮转: monitor.log ({size_mb:.1f}MB) → "
                f"{result.get('archive')}（方式 rename，保留 {result.get('kept')} 个归档）"
            )
    elif write_skip:
        size_mb = result.get("size", 0) / (1024 * 1024)
        limit_mb = result.get("threshold", MAX_LOG_SIZE) / (1024 * 1024)
        line = f"[plugin] 日志轮转跳过（未达阈值 {limit_mb:.1f}MB，当前 {size_mb:.1f}MB）"
    else:
        return result
    try:
        with open(str(log_path), "ab", buffering=0) as fh:
            fh.write(
                f"[{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}] {line}\n".encode(
                    "utf-8"
                )
            )
    except Exception:
        pass
    return result


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


def _read_auth_token() -> Optional[str]:
    """Read ``VRC_MONITOR_AUTH_TOKEN`` from the monitor dir ``.env``.

    The auth-guard plugin (2026-09-06) authenticates every HTTP path,
    ``/health`` included, so a bare probe only ever gets ``401`` — useless
    for liveness detection (that used to make a live service look down).
    """
    monitor_dir = _resolve_monitor_dir()
    if not monitor_dir:
        return None
    try:
        for raw in (Path(monitor_dir) / ".env").read_text(
            encoding="utf-8", errors="replace"
        ).splitlines():
            line = raw.strip()
            if line.startswith("VRC_MONITOR_AUTH_TOKEN="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    except Exception:
        pass
    return None


def _health_check(timeout: float = 3.0) -> Dict[str, Any]:
    """GET :8799/health and return parsed JSON, or an error dict."""
    try:
        req = urllib.request.Request(HEALTH_URL)
        token = _read_auth_token()
        if token:
            req.add_header("Authorization", "Bearer " + token)
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
        # errors="replace" + explicit utf-8: netstat prints in the OEM code
        # page on zh-CN Windows (GBK) and strict decoding made the reader
        # thread raise, so stdout came back empty and method 1 never matched.
        out = subprocess.run(
            ["netstat", "-ano"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=10,
        )
        if out.returncode == 0:
            for line in out.stdout.splitlines():
                #   TCP    0.0.0.0:8799     0.0.0.0:0      LISTENING    29096
                parts = line.split()
                if len(parts) < 5 or parts[-2].upper() != "LISTENING":
                    continue
                # Port match on the LOCAL address only — the bind address is
                # configurable (VRC_MONITOR_HOST), so do not hardcode 127.0.0.1.
                if not parts[1].endswith(":8799"):
                    continue
                if parts[-1].isdigit():
                    return int(parts[-1])
    except Exception:
        pass

    # Method 2: command-line match. wmic first (still present on older
    # Windows), then PowerShell CIM — wmic was REMOVED from Windows 11 24H2+,
    # so the wmic-only version silently found nothing on current systems.
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
            encoding="utf-8",
            errors="replace",
            timeout=10,
        )
        if out.returncode == 0:
            for line in out.stdout.splitlines():
                if MONITOR_SCRIPT not in line:
                    continue
                # CSV: ProcessId is the last column, so the field after the
                # final comma is the pid even if the command line has commas.
                tail = line.rsplit(",", 1)[-1].strip()
                if tail.isdigit():
                    return int(tail)
    except Exception:
        pass

    try:
        out = subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-Command",
                "Get-CimInstance Win32_Process -Filter \"name='node.exe'\" | "
                "ForEach-Object { \"$($_.ProcessId)|$($_.CommandLine)\" }",
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=20,
        )
        if out.returncode == 0:
            for line in out.stdout.splitlines():
                if MONITOR_SCRIPT not in line:
                    continue
                head = line.split("|", 1)[0].strip()
                if head.isdigit():
                    return int(head)
    except Exception:
        pass

    return None


# ── public API ─────────────────────────────────────────────────────────


def status(check_log_rotation: bool = True) -> Dict[str, Any]:
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
            "log_capture": {
                "path": str, "size": int, "threshold": int,
                "rotated": bool, "method": "rename"|"copytruncate"|None,
                "removed": [...], "error": str|None
            },
        }

    ``log_capture`` 是 PR #189 审查后新增的字段（只增不改，既有字段语义
    不动）：每次 status() 顺路做一次捕获文件轮转检查（常驻服务数周不重启
    时这是唯一的阈值检查时机）。「跳过（未达阈值）」分支不写日志行（防
    高频调用刷屏），结果经本字段可见；轮转成功/失败各写一行进 active
    文件。``check_log_rotation=False`` 仅供 start() 内部使用（start() 有
    自己的显式检查，避免同一进程启动时双检双行）。

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

    # 运行中轮转检查（PR #189 审查 ⚠️1）：常驻服务数周不重启时仅靠 start()
    # 的一次性检查，阈值永远不再被检查、捕获文件无界增长。vrc_status 是
    # Agent 高频调用，这里顺路做一次检查（内部只读一次 stat，不引入额外
    # I/O 抖动）。「跳过」分支不写日志行（防刷屏），结果经 log_capture
    # 字段返回；轮转成功/失败各写一行（禁静默降级）。轮转异常绝不污染
    # status 主流程。
    capture_path = Path(log_file) if log_file else _log_file()
    log_capture: Dict[str, Any] = {
        "path": str(capture_path),
        "size": 0,
        "threshold": _max_log_size_from_env(),
        "rotated": False,
        "method": None,
        "removed": [],
        "error": None,
    }
    if check_log_rotation:
        try:
            result = _rotate_log_with_notice(capture_path, write_skip=False)
            log_capture = {
                "path": str(capture_path),
                "size": result.get("size", 0),
                "threshold": result.get("threshold", log_capture["threshold"]),
                "rotated": bool(result.get("rotated")),
                "method": result.get("method"),
                "removed": result.get("removed", []),
                "error": result.get("error") if result.get("ok") is False else None,
            }
        except Exception as e:
            # _rotate_log_with_notice 自身已吞异常，此处是最后的保险。
            log_capture["error"] = str(e)

    return {
        "ok": True,
        "running": alive or inferred,
        "pid": pid,
        "health": health,
        "started_at": started_at,
        "log_file": log_file,
        "inferred": inferred,
        "log_capture": log_capture,
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
        # check_log_rotation=False：start() 下方有自己的一次性显式检查
        # （open 日志之前），这里再查会双检双行（轮转成功行 + 跳过行）。
        current = status(check_log_rotation=False)
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
    # Rotation check BEFORE opening the log. 双钩子之一（start()，低频）：
    # 允许写「跳过」行；另一处是 status()（高频，跳过分支静默、经
    # log_capture 字段可见）——常驻服务不重启时靠 status() 触发阈值检查。
    # Never blocks startup.
    _rotate_log_with_notice(log_path)
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
