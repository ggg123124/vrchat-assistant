"""stdlib unittest coverage for hermes-plugin log rotation (delivery C, round 2).

Covers ``process_manager.rotate_log_if_needed``:
  * below threshold → file untouched, no rotation
  * at/above threshold → rotation, .log.gz created (content preserved),
    active file empty; ``method == "rename"``
  * rename 被占用（Windows WinError 32 等）→ 回退 copytruncate：
    .log.gz 内容与原文一致、active 被 truncate 为 0、``method == "copytruncate"``
  * copytruncate 竞态缓解：S2 != S1（期间有新写入）时重读，稳定后才截断
  * prune: .gz 与未压缩遗留 .log 共享 keep 预算（总数口径），按 mtime 删最旧；
    active monitor.log 不被 glob 命中、绝不被误删
  * failures (locked file etc.) never raise, reported via return dict
  * env override ``VRC_MONITOR_CAPTURE_LOG_MAX_SIZE``；旧名
    ``VRC_MONITOR_LOG_MAX_SIZE`` 不再生效
  * status() 钩子：跳过分支静默（连续两次调用不产生「日志轮转跳过」行）且
    返回 ``log_capture`` 字段；轮转成功/失败各写一行

Run from the repo root:
  python -m unittest discover -s hermes-plugin/tests -v

Self-contained: ``hermes_constants`` (Hermes runtime dep) is stubbed before
import so the tests do not require a Hermes installation.
"""

import contextlib
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
        self.assertEqual(res["method"], "rename", "无占用句柄时正常路径必须走 rename")
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

    def test_copytruncate_fallback_on_rename_permission_error(self):
        """Windows 运行中 rename 必失败（WinError 32）→ copytruncate 兜底。

        mock Path.rename 抛 PermissionError（等价实测的「另一个程序正在使用
        此文件」），断言：走 copytruncate、归档 .gz 内容与原文一致、active
        文件被清空为 0 字节、返回 method == "copytruncate"。
        """
        payload = b"z" * (10 * 1024)
        self.log.write_bytes(payload)
        with mock.patch.object(Path, "rename", side_effect=PermissionError("file in use")):
            res = process_manager.rotate_log_if_needed(self.log, max_size=10 * 1024)
        self.assertTrue(res["ok"])
        self.assertTrue(res["rotated"])
        self.assertEqual(res["method"], "copytruncate", "rename 被占用必须回退 copytruncate")
        archives = list(self.dir.glob("monitor-*.log.gz"))
        self.assertEqual(len(archives), 1)
        with gzip.open(archives[0], "rb") as f:
            self.assertEqual(f.read(), payload, "copytruncate 归档内容必须与原文一致")
        self.assertEqual(self.log.stat().st_size, 0, "active 文件必须被 truncate 为 0 字节")
        self.assertEqual(res["archive"], archives[0].name)

    def test_copytruncate_retries_until_stable_size(self):
        """竞态缓解：S2 != S1（拷贝期间有新写入）时重读，稳定后才截断。

        前两次读（S1=10240→S2=10250、S1=10250→S2=10260）模拟期间有新写入，
        第三次稳定（S1==S2==10260）才执行归档 + truncate——共 7 次 stat。
        """
        payload = b"x" * (10 * 1024)
        self.log.write_bytes(payload)
        real_stat = Path.stat
        active_log = self.log
        calls = {"n": 0}
        sizes = {1: 10240, 2: 10240, 3: 10250, 4: 10250, 5: 10260, 6: 10260, 7: 10260}

        def fake_stat(inst):
            real = real_stat(inst)
            if inst == active_log:
                calls["n"] += 1
                st = mock.Mock()
                st.st_size = sizes.get(calls["n"], 10260)
                st.st_mode = real.st_mode
                return st
            return real

        # is_file 一并 mock：pathlib 3.13+ 的 is_file() 内部也调 self.stat()，
        # 钉死后 stat 调用序列在各 Python 版本下确定（call1=阈值检查，call2-7=循环）。
        # stat 用 autospec=True：patch.object 默认不绑定实例参数（fake 收不到 self）。
        with mock.patch.object(Path, "is_file", return_value=True), \
                mock.patch.object(Path, "rename", side_effect=PermissionError("in use")), \
                mock.patch.object(Path, "stat", autospec=True, side_effect=fake_stat):
            res = process_manager.rotate_log_if_needed(self.log, max_size=10 * 1024)
        self.assertEqual(calls["n"], 7, "前两次不稳定（S2>S1）应重读，第三次稳定才截断")
        self.assertEqual(res["method"], "copytruncate")
        archives = list(self.dir.glob("monitor-*.log.gz"))
        self.assertEqual(len(archives), 1)
        with gzip.open(archives[0], "rb") as f:
            self.assertEqual(f.read(), payload, "归档必须是最新一次读到的稳定快照")
        self.assertEqual(self.log.stat().st_size, 0)

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

    def test_prune_covers_uncompressed_leftovers_with_shared_budget(self):
        """gzip 失败遗留的未压缩 monitor-*.log 也纳入清理预算（两类合计）。"""
        self.make_archive("monitor-20260101-000000-101.log.gz", age_days=5)
        self.make_archive("monitor-20260102-000000-102.log.gz", age_days=3)
        self.make_archive("monitor-20260103-000000-201.log", age_days=4)
        self.make_archive("monitor-20260104-000000-202.log", age_days=2)
        self.make_archive("monitor-20260105-000000-203.log", age_days=1)
        self.write_active(10 * 1024)
        res = process_manager.rotate_log_if_needed(self.log, max_size=10 * 1024, keep=3)
        self.assertTrue(res["ok"])
        self.assertTrue(res["rotated"])
        gz_left = sorted(p.name for p in self.dir.glob("monitor-*.log.gz"))
        plain_left = sorted(p.name for p in self.dir.glob("monitor-*.log"))
        self.assertEqual(
            len(gz_left) + len(plain_left), 3,
            f"两类归档共享 keep 预算（总数口径），合计应恰好 3 份: gz={gz_left} plain={plain_left}",
        )
        # 最旧的 .gz（age 5）与最旧的未压缩件（age 4）必须被删除——未压缩件
        # 只 glob .gz 的话会永久残留
        self.assertIn("monitor-20260101-000000-101.log.gz", res["removed"])
        self.assertIn("monitor-20260103-000000-201.log", res["removed"])
        # active 文件 monitor.log 无 "monitor-<ts>-" 前缀，两个 glob 都不命中，绝不能被误删
        self.assertTrue(self.log.exists(), "active monitor.log 绝不能被误删")

    def test_failure_returns_error_and_never_raises(self):
        self.write_active(10 * 1024)
        with mock.patch.object(Path, "stat", side_effect=PermissionError("file locked")):
            res = process_manager.rotate_log_if_needed(self.log, max_size=10 * 1024)
        self.assertFalse(res["ok"])
        self.assertFalse(res["rotated"])
        self.assertIn("locked", res["error"])

    def test_env_override_threshold(self):
        self.write_active(32)
        old = os.environ.get("VRC_MONITOR_CAPTURE_LOG_MAX_SIZE")
        os.environ["VRC_MONITOR_CAPTURE_LOG_MAX_SIZE"] = "16"
        try:
            res = process_manager.rotate_log_if_needed(self.log)
        finally:
            if old is None:
                os.environ.pop("VRC_MONITOR_CAPTURE_LOG_MAX_SIZE", None)
            else:
                os.environ["VRC_MONITOR_CAPTURE_LOG_MAX_SIZE"] = old
        self.assertTrue(res["rotated"], "新名 env 阈值 16B 必须能轮转 32B 文件")

    def test_old_env_name_no_longer_takes_effect(self):
        """R2 干净改名：旧名 VRC_MONITOR_LOG_MAX_SIZE 不再识别（PR 未合并，无兼容负担）。"""
        self.write_active(32)
        old_new = os.environ.get("VRC_MONITOR_CAPTURE_LOG_MAX_SIZE")
        old_old = os.environ.get("VRC_MONITOR_LOG_MAX_SIZE")
        os.environ.pop("VRC_MONITOR_CAPTURE_LOG_MAX_SIZE", None)
        os.environ["VRC_MONITOR_LOG_MAX_SIZE"] = "16"
        try:
            res = process_manager.rotate_log_if_needed(self.log)
        finally:
            if old_new is None:
                os.environ.pop("VRC_MONITOR_CAPTURE_LOG_MAX_SIZE", None)
            else:
                os.environ["VRC_MONITOR_CAPTURE_LOG_MAX_SIZE"] = old_new
            if old_old is None:
                os.environ.pop("VRC_MONITOR_LOG_MAX_SIZE", None)
            else:
                os.environ["VRC_MONITOR_LOG_MAX_SIZE"] = old_old
        self.assertFalse(res["rotated"], "旧名 VRC_MONITOR_LOG_MAX_SIZE 必须不再生效")
        self.assertEqual(res["reason"], "below_threshold")


class RotateNoticeTest(unittest.TestCase):
    """One log line per branch, written into the active monitor.log."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.log = self.dir / "monitor.log"

    def test_skip_branch_writes_notice_into_active_log(self):
        self.log.write_bytes(b"abc")
        result = process_manager._rotate_log_with_notice(self.log)
        self.assertEqual(result.get("reason"), "below_threshold")
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
        self.assertIn("方式 rename", content, "无占用句柄时 notice 应标注方式 rename")
        self.assertEqual(len(list(self.dir.glob("monitor-*.log.gz"))), 1)


class StatusLogCaptureTest(unittest.TestCase):
    """status() 新增的运行中轮转钩子与 log_capture 字段（PR #189 ⚠️1）。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.log = self.dir / "monitor.log"

    def status_patches(self):
        """让 status() 脱离 Hermes 运行时/网络可跑通。"""
        stack = contextlib.ExitStack()
        stack.enter_context(mock.patch.object(process_manager, "_read_state", return_value=None))
        stack.enter_context(mock.patch.object(
            process_manager, "_health_check", return_value={"error": "probe down"}))
        stack.enter_context(mock.patch.object(process_manager, "_log_file", return_value=self.log))
        stack.enter_context(mock.patch.object(process_manager, "_resolve_monitor_dir", return_value=None))
        stack.enter_context(mock.patch.object(process_manager, "_resolve_node_exe", return_value=None))
        stack.enter_context(mock.patch.object(
            process_manager, "_max_log_size_from_env", return_value=10 * 1024))
        return stack

    def test_status_below_threshold_silent_twice_and_reports_log_capture(self):
        """连续两次 status()：active 文件不得出现「日志轮转跳过」行（防高频刷屏），
        且返回值含 log_capture 字段。"""
        self.log.write_bytes(b"abc")
        with self.status_patches():
            res1 = process_manager.status()
            res2 = process_manager.status()
        content = self.log.read_text(encoding="utf-8")
        self.assertEqual(content, "abc", "跳过分支必须完全静默，文件内容不得变化")
        self.assertNotIn("[plugin]", content)
        for res in (res1, res2):
            self.assertIn("log_capture", res, "status() 返回值必须含 log_capture 字段")
            lc = res["log_capture"]
            self.assertEqual(lc["path"], str(self.log))
            self.assertEqual(lc["size"], 3)
            self.assertEqual(lc["threshold"], 10 * 1024)
            self.assertFalse(lc["rotated"])
            self.assertIsNone(lc["method"])
            self.assertEqual(lc["removed"], [])
            self.assertIsNone(lc["error"])

    def test_status_rotation_writes_one_line_and_reports_rename(self):
        self.log.write_bytes(b"z" * (10 * 1024))
        with self.status_patches():
            res = process_manager.status()
        content = self.log.read_text(encoding="utf-8")
        self.assertEqual(content.count("[plugin] 日志轮转:"), 1,
                         "status() 钩子轮转成功必须恰好写一行（禁静默降级，也不重复）")
        self.assertIn("方式 rename", content)
        lc = res["log_capture"]
        self.assertTrue(lc["rotated"])
        self.assertEqual(lc["method"], "rename")
        self.assertIsNone(lc["error"])
        self.assertEqual(lc["size"], 10 * 1024)
        self.assertEqual(len(list(self.dir.glob("monitor-*.log.gz"))), 1)

    def test_status_rotation_failure_writes_one_line_and_reports_error(self):
        self.log.write_bytes(b"z" * (10 * 1024))
        with self.status_patches(), \
                mock.patch.object(Path, "stat", side_effect=PermissionError("file locked")):
            res = process_manager.status()
        self.assertTrue(res["ok"], "轮转失败绝不影响 status 主流程")
        content = self.log.read_text(encoding="utf-8")
        self.assertIn("[plugin] 日志轮转失败（不阻断启动/不影响本次状态查询", content)
        self.assertEqual(content.count("[plugin] 日志轮转失败"), 1)
        lc = res["log_capture"]
        self.assertFalse(lc["rotated"])
        self.assertIsNone(lc["method"])
        self.assertIsNotNone(lc["error"])
        self.assertIn("locked", lc["error"])


if __name__ == "__main__":
    unittest.main()
