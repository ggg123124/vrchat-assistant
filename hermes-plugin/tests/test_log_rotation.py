"""stdlib unittest coverage for hermes-plugin log rotation (delivery C).

Covers ``process_manager.rotate_log_if_needed``:
  * below threshold → file untouched, no rotation
  * at/above threshold → rotation, .log.gz created (content preserved),
    active file recreated empty
  * prune: archives beyond ``keep`` deleted oldest-first (mtime order)
  * failures (locked file etc.) never raise, reported via return dict
  * env override ``VRC_MONITOR_LOG_MAX_SIZE``

Run from the repo root:
  python -m unittest discover -s hermes-plugin/tests -v

Self-contained: ``hermes_constants`` (Hermes runtime dep) is stubbed before
import so the tests do not require a Hermes installation.
"""

import gzip
import os
import re
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

# Stub the Hermes runtime dependency BEFORE importing process_manager
# (module-level ``from hermes_constants import get_hermes_home``).
hermes_constants_stub = types.ModuleType("hermes_constants")
hermes_constants_stub.get_hermes_home = lambda: tempfile.gettempdir()
sys.modules["hermes_constants"] = hermes_constants_stub

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import process_manager  # noqa: E402


class RotateLogIfNeededTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.log = self.dir / "monitor.log"

    def write_active(self, size):
        self.log.write_bytes(b"x" * size)
        return size

    def make_archive(self, name, age_days=0):
        p = self.dir / name
        p.write_bytes(b"old archive")
        ts = 1600000000 - age_days * 86400
        os.utime(p, (ts, ts))
        return p

    def test_below_threshold_leaves_file_untouched(self):
        self.write_active(1024)
        before = self.log.read_bytes()
        res = process_manager.rotate_log_if_needed(self.log, max_size=10 * 1024)
        self.assertTrue(res["ok"])
        self.assertFalse(res["rotated"])
        self.assertEqual(res["reason"], "below_threshold")
        self.assertEqual(self.log.read_bytes(), before, "file must be untouched")
        self.assertEqual(list(self.dir.glob("monitor-*.log.gz")), [], "no archives expected")

    def test_at_threshold_rotates_gzips_and_recreates_active(self):
        payload = b"y" * (10 * 1024)
        self.log.write_bytes(payload)
        res = process_manager.rotate_log_if_needed(self.log, max_size=10 * 1024)
        self.assertTrue(res["ok"])
        self.assertTrue(res["rotated"])
        archives = list(self.dir.glob("monitor-*.log.gz"))
        self.assertEqual(len(archives), 1)
        self.assertRegex(
            archives[0].name, r"^monitor-\d{8}-\d{6}-\d+\.log\.gz$",
            "name must be monitor-<UTC YYYYMMDD-HHMMSS>-<pid>.log.gz",
        )
        with gzip.open(archives[0], "rb") as f:
            self.assertEqual(f.read(), payload, "gz content must equal original")
        self.assertEqual(self.log.stat().st_size, 0, "active file must be recreated empty")
        self.assertEqual(res["archive"], archives[0].name)

    def test_prune_deletes_oldest_beyond_keep(self):
        for i in range(5):
            self.make_archive(f"monitor-2026010{i}-000000-{100 + i}.log.gz", age_days=5 - i)
        self.write_active(10 * 1024)
        res = process_manager.rotate_log_if_needed(self.log, max_size=10 * 1024, keep=5)
        self.assertTrue(res["ok"])
        self.assertTrue(res["rotated"])
        self.assertIn("monitor-20260100-000000-100.log.gz", res["removed"],
                      "oldest archive (mtime) must be removed")
        remaining = sorted(p.name for p in self.dir.glob("monitor-*.log.gz"))
        self.assertEqual(len(remaining), 5, "must keep exactly 5 archives")
        self.assertNotIn("monitor-20260100-000000-100.log.gz", remaining)

    def test_failure_returns_error_and_never_raises(self):
        self.write_active(10 * 1024)
        with mock.patch.object(Path, "stat", side_effect=PermissionError("file locked")):
            res = process_manager.rotate_log_if_needed(self.log, max_size=10 * 1024)
        self.assertFalse(res["ok"])
        self.assertFalse(res["rotated"])
        self.assertIn("locked", res["error"])

    def test_env_override_threshold(self):
        self.write_active(32)
        old = os.environ.get("VRC_MONITOR_LOG_MAX_SIZE")
        os.environ["VRC_MONITOR_LOG_MAX_SIZE"] = "16"
        try:
            res = process_manager.rotate_log_if_needed(self.log)
        finally:
            if old is None:
                os.environ.pop("VRC_MONITOR_LOG_MAX_SIZE", None)
            else:
                os.environ["VRC_MONITOR_LOG_MAX_SIZE"] = old
        self.assertTrue(res["rotated"], "env threshold 16B must rotate a 32B file")


class RotateNoticeTest(unittest.TestCase):
    """One log line per branch, written into the active monitor.log."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.log = self.dir / "monitor.log"

    def test_skip_branch_writes_notice_into_active_log(self):
        self.log.write_bytes(b"abc")
        process_manager._rotate_log_with_notice(self.log)
        content = self.log.read_text(encoding="utf-8")
        self.assertIn("[plugin] 日志轮转跳过（未达阈值", content)
        self.assertIn("abc", content, "original content must be preserved (append)")

    def test_rotate_branch_writes_notice_into_new_active_log(self):
        self.log.write_bytes(b"z" * (10 * 1024))
        with mock.patch.object(process_manager, "_max_log_size_from_env", return_value=10 * 1024):
            process_manager._rotate_log_with_notice(self.log)
        content = self.log.read_text(encoding="utf-8")
        self.assertIn("[plugin] 日志轮转: monitor.log", content)
        self.assertIn("→ monitor-", content)
        self.assertEqual(len(list(self.dir.glob("monitor-*.log.gz"))), 1)


if __name__ == "__main__":
    unittest.main()
