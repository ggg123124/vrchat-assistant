"""vrcmon_watchdog 判据单测与长 init 回归 harness（纯打桩，无副作用）。

用法：python service-windows/tests/test_vrcmon_watchdog.py     # 退出码 0=全通过

为什么要有它：watchdog 的判据现在有 3 个状态文件（watchdog 戳记 / 连续失败计数 /
服务自写启动戳记）× 多条分支（启动宽限 / 连续失败 / 验证失败判活 / 拉起异常），
单靠人读很容易把语义改坏。本文件既覆盖单元分支，也用「虚拟时钟 + 计划任务语义
（每 60s 探测一次）」复现真实时间线，用于回归"init 比验证窗口长"这类只在时间轴上
才暴露的缺陷（PR #243 审查 🔴1：init ≥ 65s 时曾进入每分钟强杀死循环）。

全部外部副作用都被打桩：healthy() / port_pid() / pid_alive() / _launch_detached() /
taskkill（subprocess.run）——不触碰真实服务、端口、计划任务与生产目录。
"""
import importlib.util
import os
import shutil
import sys
import tempfile

# Windows CI（cp1252 控制台）下 print 中文会抛 UnicodeEncodeError ⇒ 统一成 UTF-8；
# 重设失败也不影响判据测试本身。
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

HERE = os.path.dirname(os.path.abspath(__file__))
WD_PATH = os.path.join(os.path.dirname(HERE), "vrcmon_watchdog.py")

TMP = tempfile.mkdtemp(prefix="vrcmon-watchdog-test-")
os.environ["VRC_MONITOR_LOG_DIR"] = TMP
os.environ.pop("VRC_MONITOR_LOGGER_DIR", None)

spec = importlib.util.spec_from_file_location("vrcmon_watchdog", WD_PATH)
wd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wd)

# ---------- 全局隔离：不读写真部署目录 ----------
wd.log_dir = lambda: TMP
wd.project_dir = lambda: TMP
wd.service_start_candidates = lambda: [TMP]
wd.env_file_value = lambda *a, **k: None
wd.node_bin = lambda: "node"
wd._append = lambda *a, **k: None

LAUNCHED = []
RESULTS = []


def check(name, cond, extra=""):
    RESULTS.append((name, bool(cond)))
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}{('  ' + extra) if extra else ''}")


def reset_state():
    for p in (wd.stamp_path(), wd.fail_path(), os.path.join(TMP, wd.SERVICE_START_NAME)):
        try:
            os.remove(p)
        except OSError:
            pass
    LAUNCHED.clear()


def seed_watchdog_stamp(age):
    with open(wd.stamp_path(), "w", encoding="utf-8") as f:
        f.write("t")
    os.utime(wd.stamp_path(), (time_now() - age,) * 2)


def seed_service_stamp(age):
    p = os.path.join(TMP, wd.SERVICE_START_NAME)
    with open(p, "w", encoding="utf-8") as f:
        f.write("t")
    os.utime(p, (time_now() - age,) * 2)


def seed_fail(count, age=0):
    with open(wd.fail_path(), "w", encoding="utf-8") as f:
        f.write(f"{count} {time_now() - age}")


# ---------- 虚拟时钟 ----------
class FakeTime:
    def __init__(self):
        self.now = 1_700_000_000.0

    def time(self):
        return self.now

    def sleep(self, s):
        self.now += float(s)


FT = FakeTime()
wd.time = FT
time_now = FT.time


# ---------- 单元分支场景（健康/计数/宽限各自独立打桩） ----------
def unit_scenarios():
    wd._launch_detached = lambda: LAUNCHED.append(1) or None
    wd.port_pid = lambda *a, **k: None
    health = {"v": False}
    wd.healthy = lambda: health["v"]

    print("① 偶发一次超时（无任何戳记）→ 不介入，计数=1")
    reset_state()
    wd.main()
    check("首次失败不介入", LAUNCHED == [] and wd.read_fail()[0] == 1)

    print("② 第二次连续失败 → 到达阈值，拉起并留存失败计数（验证失败分支决定后续）")
    wd.main()
    check("第二次失败触发拉起", len(LAUNCHED) == 1, f"launched={len(LAUNCHED)}")

    print("③ 探活成功 → 清计数、不介入")
    reset_state()
    health["v"] = True
    wd.main()
    check("健康时清零且不介入", LAUNCHED == [] and not os.path.exists(wd.fail_path()))

    print("④ 失败间隔超过 FAIL_WINDOW → 计数重置（单次不介入）")
    reset_state()
    health["v"] = False
    seed_fail(1, age=wd.FAIL_WINDOW + 10)
    wd.main()
    check("过期计数重置为 1", wd.read_fail()[0] == 1 and LAUNCHED == [])

    print("⑤ 启动宽限（watchdog 戳记新鲜）→ 即使已达阈值也不介入")
    reset_state()
    seed_fail(wd.FAIL_THRESHOLD - 1)
    seed_watchdog_stamp(10)
    wd.main()
    check("宽限内不介入", LAUNCHED == [])

    print("⑥ 宽限过期 + 已达阈值 → 仍能拉起（真宕机不会被放过）")
    reset_state()
    seed_fail(wd.FAIL_THRESHOLD - 1)
    seed_watchdog_stamp(wd.GRACE_SECONDS + 10)
    wd.main()
    check("宽限过期后仍能拉起", len(LAUNCHED) == 1)

    print("⑦ 只有服务自写戳记（外部拉起：launcher / 手动 / 插件）→ 同样享宽限")
    reset_state()
    seed_fail(wd.FAIL_THRESHOLD - 1)
    seed_service_stamp(20)
    wd.main()
    check("服务戳记在宽限内不介入", LAUNCHED == [])

    print("⑧ 拉起抛异常 → 保留失败计数并清戳记（下一轮立即重试）")
    reset_state()
    seed_fail(wd.FAIL_THRESHOLD - 1)

    def boom():
        raise RuntimeError("boom")

    wd._launch_detached = boom
    wd.main()
    check("拉起异常保留计数", os.path.exists(wd.fail_path()) and wd.read_fail()[0] >= wd.FAIL_THRESHOLD)
    check("拉起异常清戳记", not os.path.exists(wd.stamp_path()))
    wd._launch_detached = lambda: LAUNCHED.append(1) or None


# ---------- 虚拟时钟 harness（计划任务语义：每 60s 探测一次） ----------
class Model:
    """服务生命周期模型：谁拉起、init 多长、拉起后是否立刻崩溃、端口何时 Listen。"""

    def __init__(self, init_seconds, crash_on_launch=False, pre_alive=False, pre_init_age=0):
        self.init_seconds = init_seconds
        self.crash_on_launch = crash_on_launch
        self.alive = pre_alive
        self.init_until = FT.now + pre_init_age if pre_alive else 0.0
        self.kills = 0
        self.launches = 0
        self.trace = []

    # 端口：init 后段才开始 Listen（实测 init 期间既有"未 Listen"也有"已 Listen 但不响应"）
    def port_pid(self, port=8799):
        if self.alive and FT.now >= self.listen_from():
            return 4321
        return None

    def listen_from(self):
        return self.init_until - min(30.0, self.init_seconds * 0.5)

    def healthy(self):
        return self.alive and FT.now >= self.init_until

    def pid_alive(self, pid):
        return True if (pid is not None and self.alive) else (False if pid is not None else None)

    def launch(self):
        self.launches += 1
        self.trace.append(f"launch@{FT.now - T0:.0f}s")
        if self.crash_on_launch:
            self.alive = False
            return None                       # 进程立刻消失
        self.alive = True
        self.init_until = FT.now + self.init_seconds
        return type("Child", (), {"pid": 4321})()

    def taskkill(self):
        self.kills += 1
        self.trace.append(f"kill@{FT.now - T0:.0f}s")
        self.alive = False


def install(model):
    wd.healthy = model.healthy
    wd.port_pid = model.port_pid
    wd.service_process_alive = lambda child=None: (
        model.pid_alive(getattr(child, "pid", None)) if child is not None
        else (model.pid_alive(4321) if model.alive else (model.port_pid() is not None))
    )
    wd._launch_detached = model.launch
    wd.reset_stamps = lambda: [os.remove(p) for p in (wd.stamp_path(),
                                                      os.path.join(TMP, wd.SERVICE_START_NAME))
                               if os.path.exists(p)]

    def fake_run(cmd, *a, **k):
        if cmd and cmd[0] == "taskkill":
            model.taskkill()
        return type("R", (), {"stdout": b"", "returncode": 0})()

    wd.subprocess.run = fake_run


def timeline(label, init_seconds, window=300, expect_kills=None, expect_launches=None,
             crash=False, pre_alive=False, pre_init_age=0):
    global T0
    reset_state()
    FT.now = 1_700_000_000.0
    model = Model(init_seconds, crash_on_launch=crash, pre_alive=pre_alive, pre_init_age=pre_init_age)
    install(model)
    T0 = FT.now
    t = 0
    while t <= window:
        FT.now = T0 + t
        wd.main()
        t += 60
    ok = True
    if expect_kills is not None and model.kills != expect_kills:
        ok = False
    if expect_launches is not None and model.launches != expect_launches:
        ok = False
    detail = f"init={init_seconds}s kills={model.kills} launches={model.launches} healthy={model.healthy()}"
    check(label, ok, detail + ("  trace=" + " ".join(model.trace[:8]) if model.trace else ""))
    return model


def harness_scenarios():
    print("⑨ 【🔴1 回归】服务已死 + init 70s（> 验证窗口 25s）→ 不得反复强杀")
    timeline("init 70s：0 杀 / 1 拉起 / 最终健康", 70, expect_kills=0, expect_launches=1)

    print("⑩ 临界点扫描（init 55 / 65 / 80s）→ 均应 0 杀")
    timeline("init 55s", 55, expect_kills=0, expect_launches=1)
    timeline("init 65s", 65, expect_kills=0, expect_launches=1)
    timeline("init 80s", 80, expect_kills=0, expect_launches=1)

    print("⑪ 拉起即崩溃（进程确实消失）→ 保留「每轮重试」语义，不出现 300s 静默")
    timeline("拉起即崩溃：0 杀 / 每个探测点都在重试（无静默窗口）", 30, window=300,
             expect_kills=0, expect_launches=5, crash=True)

    print("⑫ 外部拉起（服务自写戳记）+ init 200s → 完全不介入")
    reset_state()
    FT.now = 1_700_000_000.0
    model = Model(200, pre_alive=True, pre_init_age=10)
    install(model)
    seed_service_stamp(age=10)
    for t in range(0, 601, 60):
        FT.now = 1_700_000_000.0 + t
        wd.main()
    check("外部拉起 + init 200s：0 杀 0 拉起", model.kills == 0 and model.launches == 0,
          f"kills={model.kills} launches={model.launches}")


def main():
    print("=== 单元分支 ===")
    unit_scenarios()
    print("\n=== 虚拟时钟时间线（每 60s 探测）===")
    harness_scenarios()
    bad = [n for n, ok in RESULTS if not ok]
    print(f"\n结果：{len(RESULTS) - len(bad)}/{len(RESULTS)} 通过")
    if bad:
        for n in bad:
            print(f"  失败：{n}")
    shutil.rmtree(TMP, ignore_errors=True)
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
