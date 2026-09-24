"""vrc-monitor watchdog — 崩溃自动修复（建议由计划任务每分钟运行一次）。

行为（判据见下方常量注释，三者是**独立的**三道闸）：
  - 服务健康（http://127.0.0.1:8799/health 返回 200）→ 清零连续失败计数，静默退出。
  - **启动宽限**：`starting_age() < GRACE_SECONDS` → 视为"正在启动"，本轮不介入。
    `starting_age()` 取两个戳记中较新的一个：本 watchdog 拉起时写的
    `service-logs/.vrcmon-watchdog-launch`，以及**服务自己**在 `storage.init` 前写的
    `.vrcmon-service-start`（start-monitor.js；落在服务自己的日志目录——`VRC_MONITOR_LOGGER_DIR`
    或默认 `<项目>/logs`，watchdog 在候选目录 `VRC_MONITOR_LOGGER_DIR` / `VRC_MONITOR_LOG_DIR`
    （`service-logs/`）/ `<项目>/logs` 里找最新的一枚）。因此**任何拉起渠道**
    （计划任务 watchdog / `vrcmon_service_launcher.py` / 手动 `node start-monitor.js` /
    Hermes 插件 `vrc_start`）拉起的实例都能获得宽限；大库 storage.init 实测 50-70s+
    也不会被误杀。判据只看"开始启动的时刻"，**不看端口状态**——init 期间端口可能已
    Listen 但处理器阻塞在 DB 上（表现为请求超时），若把"端口未监听"当宽限条件仍会误杀。
  - **连续失败**：同类不健康连续 `FAIL_THRESHOLD` 次（窗口 `FAIL_WINDOW`）才判定宕机。
    事件循环被小时级任务阻塞时 `/health` 会单次超时，单次采样不足以判定死亡。
  - 上述闸门都放行后：杀掉 :8799 残留监听进程（仅 Windows）→ 以独立进程重新启动 →
    等待 25 秒验证 → 成功则在修复日志追加一行（`… repair`）。
    验证失败时**先判进程是否真的消失**（用我们自己拉起的子进程 PID，端口探测仅兜底）：
    进程已消失（拉起即崩溃）⇒ 清除启动戳记 + 回拨失败计数，下一轮立即重试；
    进程仍在（大概率仍在 init —— 25 秒验证在 init 50-70s+ 的部署上是**假阴性**）⇒
    **保留宽限**，交回 `GRACE_SECONDS` 兜底（否则会强杀仍在初始化的进程、把重启风暴引回来）。
    两种情况都追加一行 `… repair (unverified: …)` 到修复日志，避免"每分钟重启"被每日报告
    统计成 0 次（审查指出的可观测性缺口）。

  - 全程无 stdout 输出（接入通知系统时：空输出 = 静默，可零成本轮询）。

边界（如实声明）：两个启动戳记都不存在时（例如把仓库拷到新机器后直接 `node start-monitor.js`、
本 watchdog 从未拉起过它）不使用启动宽限，此时仍由"连续失败"闸兜底——实测外部拉起 +
init≈70s 为 0 次误杀，init > ~120s 时最坏被误杀一次。

路径配置（环境变量，与 start-monitor.js 的 .env 约定一致）：
  VRC_MONITOR_DIR       项目根目录（默认：本脚本所在目录的上一级）
  VRC_MONITOR_NODE      node 可执行文件（默认：PATH 中的 node）
  VRC_MONITOR_LOG_DIR   日志目录（默认：<项目>/service-logs）
    修复日志：<LOG_DIR>/vrcmon-repairs.log（每日报告脚本消费）
    watchdog 日志：<LOG_DIR>/vrcmon-watchdog.log
    服务日志：<LOG_DIR>/vrcmon-service.log

平台：kill 残留进程用 netstat/taskkill，仅 Windows 启用（sys.platform 门控）；
非 Windows 跳过该步直接重启，其余逻辑跨平台。
"""
import subprocess, sys, os, time, datetime, urllib.request

HEALTH_URL = "http://127.0.0.1:8799/health"
HEALTH_TIMEOUT = 8       # 单次健康检查超时（秒）。4s 在磁盘/事件循环忙时太紧，容易误判；
                         # 注意它只是"降低误判概率"，不改变宽限语义：大库 init 窗口内
                         # /health 本就不可用，那个窗口由 GRACE_SECONDS 负责（见下）。
GRACE_SECONDS = 300      # 启动宽限：服务"开始启动"至今不足该秒数 → 视为启动中，不介入
STAMP_NAME = ".vrcmon-watchdog-launch"        # 本 watchdog 上次拉起服务的时刻戳
SERVICE_START_NAME = ".vrcmon-service-start"  # 服务自写启动戳记（start-monitor.js 于 storage.init 前落盘）
FAIL_NAME = ".vrcmon-watchdog-unhealthy"      # 连续不健康计数（内容 "count epoch"）
FAIL_THRESHOLD = 2       # 连续探测失败达到该次数才判定宕机。与计划任务默认每分钟调度
                         # 合起来 = "两个相邻探测点都失败"（≈120s 才动手）：真宕机的重新
                         # 拉起由 60s 推迟到 ≈120s（可接受），换来单次超时不再误杀。
                         # 调大它等于再放宽一整个探测周期，调参时勿只改这里而不看语义。
FAIL_WINDOW = 600        # 两次失败间隔超过该秒数则重新计数（秒）


def project_dir():
    env = os.environ.get("VRC_MONITOR_DIR")
    if env:
        return os.path.abspath(env)
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def node_bin():
    return os.environ.get("VRC_MONITOR_NODE") or "node"


def log_dir():
    env = os.environ.get("VRC_MONITOR_LOG_DIR")
    if env:
        return os.path.abspath(env)
    return os.path.join(project_dir(), "service-logs")


def healthy():
    try:
        with urllib.request.urlopen(HEALTH_URL, timeout=HEALTH_TIMEOUT) as r:
            return r.status == 200
    except Exception:
        return False


def stamp_path():
    return os.path.join(log_dir(), STAMP_NAME)


def stamp_age():
    """距上次由本 watchdog 拉起服务的秒数；没有戳记返回 None。"""
    try:
        return time.time() - os.path.getmtime(stamp_path())
    except OSError:
        return None


def touch_stamp():
    try:
        os.makedirs(log_dir(), exist_ok=True)
        with open(stamp_path(), "w", encoding="utf-8") as f:
            f.write(datetime.datetime.now().isoformat())
    except Exception:
        pass


def fail_path():
    return os.path.join(log_dir(), FAIL_NAME)


def read_fail():
    """返回 (连续失败次数, 上次失败时刻)。"""
    try:
        with open(fail_path(), encoding="utf-8") as f:
            count, ts = f.read().split()
        return int(count), float(ts)
    except Exception:
        return 0, 0.0


def bump_fail():
    """记录一次探测失败并返回累计次数；距上次失败超过 FAIL_WINDOW 则重新计数。"""
    count, last = read_fail()
    if time.time() - last > FAIL_WINDOW:
        count = 0
    count += 1
    try:
        os.makedirs(log_dir(), exist_ok=True)
        with open(fail_path(), "w", encoding="utf-8") as f:
            f.write(f"{count} {time.time()}")
    except Exception:
        pass
    return count


def clear_fail():
    try:
        os.remove(fail_path())
    except OSError:
        pass


def seed_fail(count):
    """把连续失败计数直接置为 count（拉起后 25s 验证失败时用：本轮尝试已知失败，
    让下一轮即可重试，不必再等满一个探测周期）。"""
    try:
        os.makedirs(log_dir(), exist_ok=True)
        with open(fail_path(), "w", encoding="utf-8") as f:
            f.write(f"{count} {time.time()}")
    except Exception:
        pass


def env_file_value(key, default=None):
    """从仓库根 `.env` 读一个键（`start-monitor.js` 会**无条件**加载它，见其 L58-71）。

    计划任务启动的 watchdog 只继承机器/用户环境变量，看不到 `.env`；因此服务侧若把
    `VRC_MONITOR_LOGGER_DIR` 写在 `.env` 里，这里必须补读，否则"任何拉起渠道都有宽限"
    的承诺会在那种部署上静默失效（审查 💡）。仅支持 KEY=VALUE 行，容忍 `export`/引号/注释。
    """
    try:
        with open(os.path.join(project_dir(), ".env"), encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if line.startswith("export "):
                    line = line[len("export "):].strip()
                k, sep, v = line.partition("=")
                if sep and k.strip() == key:
                    return v.strip().strip('"').strip("'") or default
    except OSError:
        pass
    return default


def service_start_candidates():
    """服务启动戳记的候选目录（按优先级、去重）。

    两套日志目录约定刻意不同名（core/logger.js 注释写明）：
      服务：`VRC_MONITOR_LOGGER_DIR`（环境变量或仓库 `.env`），默认 `<项目>/logs`
      watchdog：`VRC_MONITOR_LOG_DIR`，默认 `<项目>/service-logs`
    ⇒ 戳记落在服务自己的日志目录，watchdog 在三处候选里找；服务侧变量写在 `.env` 里也认。
    """
    cands = []
    env = os.environ.get("VRC_MONITOR_LOGGER_DIR") or env_file_value("VRC_MONITOR_LOGGER_DIR")
    if env:
        cands.append(os.path.abspath(env))
    for d in (log_dir(), os.path.join(project_dir(), "logs")):
        if d not in cands:
            cands.append(d)
    return cands


def service_start_age():
    """服务自写启动戳记的年龄（秒）；一处都没找到返回 None（取最新的一枚）。

    由 start-monitor.js 在 storage.init 之前落盘，因此与"谁拉起的服务"无关：
    计划任务 watchdog / vrcmon_service_launcher.py / 手动 / Hermes 插件 vrc_start
    拉起的实例都受它保护。服务启动即崩溃时戳记会留在磁盘上，由 reset_stamps() 清除。
    """
    ages = []
    for d in service_start_candidates():
        try:
            ages.append(time.time() - os.path.getmtime(os.path.join(d, SERVICE_START_NAME)))
        except OSError:
            pass
    return min(ages) if ages else None


def starting_age():
    """"开始启动"至今的秒数：取两枚启动戳记中**较新**的一个；都没有则 None。

    watchdog 戳记只覆盖"它自己发起过的拉起"，服务戳记覆盖其它拉起渠道 —— 两者取较新者，
    宽限才能对任何拉起路径成立（审查 ⚠️2：外部拉起 + init > ~120s 曾被误杀一次）。
    """
    ages = [a for a in (stamp_age(), service_start_age()) if a is not None]
    return min(ages) if ages else None


def reset_stamps():
    """清除启动戳记（watchdog 戳记 + 各候选目录里的服务戳记）。

    拉起抛异常 / 拉起后 25s 验证失败时调用：否则"戳记很新但服务其实已死"会让下一轮
    静默等满 GRACE_SECONDS（审查 ⚠️1）。
    """
    targets = [stamp_path()] + [os.path.join(d, SERVICE_START_NAME) for d in service_start_candidates()]
    for p in targets:
        try:
            os.remove(p)
        except OSError:
            pass


def port_pid(port=8799):
    """Windows: 返回监听指定端口的 PID（netstat 输出按本机代码页解码，兼容中文系统）。"""
    if sys.platform != "win32":
        return None
    try:
        out = subprocess.run(["netstat", "-ano", "-p", "tcp"], capture_output=True, timeout=15).stdout
        for line in out.decode("utf-8", errors="ignore").splitlines():
            if f":{port}" in line and "LISTENING" in line:
                parts = line.split()
                if parts:
                    return int(parts[-1])
    except Exception:
        pass
    return None


def _append(path, text):
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:
            f.write(text)
    except Exception:
        pass


def pid_alive(pid):
    """PID 是否存活：True / False / None（判不出来）。跨平台，仅用标准库。"""
    if pid is None:
        return None
    try:
        if sys.platform == "win32":
            out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH"],
                                 capture_output=True, timeout=15).stdout
            return str(pid) in out.decode("utf-8", "ignore")
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True                     # 存在但无权限发信号 ⇒ 活着
    except OSError:
        return False
    except Exception:
        return None


def service_process_alive(child=None):
    """拉起后的判活：优先用我们自己的子进程 PID，其次看端口监听者。

    为什么不能只看端口：init 早段端口**尚未** Listen、中段可能已 Listen 但处理器阻塞
    （两种状态实测都出现过）⇒ 以端口为准会把"仍在初始化"误判为"已死"。
    未知时退回端口探测（与审核方 harness 的模型一致）。
    """
    alive = pid_alive(getattr(child, "pid", None) if child is not None else None)
    if alive is not None:
        return alive
    return port_pid() is not None


def _launch_detached():
    os.makedirs(log_dir(), exist_ok=True)
    logf = open(os.path.join(log_dir(), "vrcmon-service.log"), "ab")
    flags = 0
    if sys.platform == "win32":
        flags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS
        try:
            flags |= subprocess.CREATE_NO_WINDOW
        except AttributeError:
            pass
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    return subprocess.Popen(
        [node_bin(), "start-monitor.js"],
        cwd=project_dir(),
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=logf,
        stderr=logf,
        creationflags=flags,
        close_fds=True,
    )


def main():
    if healthy():
        clear_fail()    # 健康即清零：偶发的短时阻塞不会累积成误判
        return 0  # 一切正常，静默

    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    # 启动宽限：服务"开始启动"至今不足 GRACE_SECONDS → 视为启动中，本轮不介入。
    # starting_age() = max(本 watchdog 拉起戳记, 服务自写戳记) 取新 ⇒ 任何拉起渠道
    # （launcher / 手动 / Hermes 插件）拉起的实例都在保护内。判据只看启动时刻、不看端口状态：
    # init 期间端口可能已 Listen 但处理器阻塞在 DB 上（表现为请求超时），
    # 若把"端口未监听"当宽限条件仍会误杀（第一版实现即因此失败）。
    age = starting_age()
    if age is not None and age < GRACE_SECONDS:
        return 0

    # 连续失败判定：单次超时可能只是事件循环被小时级大任务阻塞（实测「追踪非好友刷新」
    # 期间 /health 会 >8s 无响应），此时杀进程＝把正常服务打断并重启（每次还要重建
    # 380MB 备份）。要求连续 FAIL_THRESHOLD 次探测失败（FAIL_WINDOW 内）才判定宕机。
    count = bump_fail()
    if count < FAIL_THRESHOLD:
        return 0

    pid = port_pid()
    if pid is not None:
        try:
            subprocess.run(["taskkill", "/PID", str(pid), "/F"], capture_output=True, timeout=15)
        except Exception:
            pass
        time.sleep(2)

    child = None
    try:
        child = _launch_detached()
    except Exception as e:
        # 拉起失败：保留失败计数、清掉可能存在的旧戳记 ⇒ 下一轮立即重试，不白等一个探测点
        _append(os.path.join(log_dir(), "vrcmon-watchdog.log"), f"{now} launch error: {e}\n")
        reset_stamps()
        return 0

    touch_stamp()   # 记录拉起时刻，供下一轮宽限判定
    clear_fail()    # 拉起成功后才清零（失败分支不应吞掉计数）

    time.sleep(25)
    repairs_log = os.path.join(log_dir(), "vrcmon-repairs.log")
    if healthy():
        _append(repairs_log, f"{now} repair\n")
    else:
        _append(os.path.join(log_dir(), "vrcmon-watchdog.log"), f"{now} repair attempt failed (not healthy after 25s)\n")
        # 25 秒验证在「init 比它长」的部署上是**假阴性**（本 PR 的目标场景 init 50-70s+）。
        # 因此只有进程**确实消失**才放弃宽限；进程仍在（大概率仍在 init）必须保留宽限，
        # 否则下一个探测点起 starting_age() 为 None ⇒ 强杀仍在初始化的进程 ⇒ 重启风暴回归。
        # （审查 🔴1：两个独立 harness 均复现 init 65s+ 时 kills=13/14 的死循环。）
        alive = service_process_alive(child)
        if alive:
            _append(repairs_log, f"{now} repair (unverified: not healthy after 25s, 进程仍在)\n")
        else:
            _append(repairs_log, f"{now} repair (unverified: not healthy after 25s, 进程已消失)\n")
            reset_stamps()                 # 放弃宽限，下一轮即可重试
            seed_fail(FAIL_THRESHOLD - 1)  # 本轮尝试已知失败 ⇒ 不必再等满一个周期
    return 0


if __name__ == "__main__":
    sys.exit(main())
