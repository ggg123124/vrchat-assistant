# vrc-monitor 常驻服务（Linux）

让 vrc-monitor 服务在 Linux 上**开机自启、崩溃自动重启、日志集中采集**，不需要人工干预，也不会因为终端关闭或 Hermes gateway 重启而中断记录。方案基于 **systemd 用户服务**（`systemctl --user`），无 GUI 依赖，适用于无头服务器 / VPS / NAS（glibc 发行版）。

## 组件

| 文件 | 作用 |
|------|------|
| `vrc-monitor.service` | systemd 用户单元模板：`Restart=always` 崩溃自愈 + journald 日志 + `%h` 路径占位 |
| `setup-linux.sh` | 一键安装 / 卸载：解析仓库路径 / node / python 生成真实单元并 `enable --now`，开启 linger |
| `README.md` | 本说明 |

## 快速开始

```bash
bash service-linux/setup-linux.sh
```

脚本会自动：

1. 解析仓库目录（脚本所在目录的上一级）与 `node` / `python` 可执行文件
2. 由模板生成 `~/.config/systemd/user/vrc-monitor.service`（`%h/vrchat-assistant` → 实际仓库路径，node 路径烘焙进 `ExecStart`；仓库或 node 路径含空格时自动对 `ExecStart` 含空格 token 加引号，避免 systemd 按空白拆分截断；node 不在 PATH 的 env 模式（`/usr/bin/env node`）保持两个 token，仅对仓库路径加引号）
3. `systemctl --user daemon-reload` + `enable --now`（立即启动 + 开机自启）
4. `loginctl enable-linger`（**登出后服务继续运行**，无头服务器必需）

> 前置条件：系统使用 systemd（glibc 发行版）。容器 / WSL 无 systemd 用户实例时不适用，可改用 Hermes 插件或手动 `node start-monitor.js`。

## 手动安装（可选）

仓库位于 `~/vrchat-assistant` 时，模板可直接使用：

```bash
mkdir -p ~/.config/systemd/user
cp service-linux/vrc-monitor.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now vrc-monitor
loginctl enable-linger    # 登出后继续运行
```

## 环境变量配置

服务读取的 `VRC_MONITOR_*` 环境变量（与 AGENTS.md 约定一致）。systemd 用户服务有两种配置方式：

1. **编辑单元文件**：`systemctl --user edit vrc-monitor`（drop-in，推荐，升级仓库不会覆盖）
2. **仓库根 `.env`**：`start-monitor.js` 启动时自动加载 `VRC_MONITOR_*` 变量（与手动启动行为一致）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `VRC_MONITOR_DIR` | `start-monitor.js` 基于自身脚本目录自动探测 | 项目根目录（systemd 方案无需手动设置） |
| `VRC_MONITOR_NODE` | 安装脚本烘焙的 node 路径 | node 可执行文件路径 |
| `VRC_MONITOR_PYTHON` | PATH 中的 `python` | 执行 scripts/fetch-otp.py 的解释器。**systemd 用户服务 PATH 较精简，安装脚本检测到 PATH 无 `python` 时会自动注入 `python3` 路径**；若手动安装且 PATH 无 python，必须自行设置，否则 OTP 自动登录失败会陷入重试循环 |
| `VRC_MONITOR_DB_PATH` | `<仓库>/data/vrc-monitor.sqlite3` | 数据库文件位置（可迁移到独立数据盘） |
| `VRC_MONITOR_BACKUP_DIR` | `<仓库>/data/backups` | 自动备份目录 |
| `VRC_MONITOR_LOGGER_LEVEL` | `info` | 文件/控制台日志最低级别（`debug`/`info`/`warn`/`error`/`silent`） |
| `VRC_MONITOR_LOGGER_DIR` | `<仓库>/logs` | 文件日志目录（`VRC_MONITOR_LOGGER_FILE=0` 时忽略） |
| `VRC_MONITOR_LOGGER_FILE` | `1` | 是否写文件日志；`0` = 仅 stdout/journald（避免「文件 + journald」双份） |
| `VRC_MONITOR_LOGGER_SYSLOG_PREFIX` | `0`（模板已设 `1`） | 给 stdout 行加 `<N>` 优先级前缀，使 `journalctl -p` 按级别过滤生效 |
| `HTTPS_PROXY` / `HTTP_PROXY` | 无 | 网络代理（服务自动直连 6s 失败后回退 WS 代理） |

示例（drop-in）：

```bash
systemctl --user edit vrc-monitor
```

```ini
[Service]
Environment=VRC_MONITOR_PYTHON=/usr/bin/python3
Environment=HTTPS_PROXY=http://127.0.0.1:7892
Environment=VRC_MONITOR_DB_PATH=/data/vrc-monitor.sqlite3
```

## 日志与 journald 协同

服务日志有**三条链路，职责分离**：

| 链路 | 内容 | 查询方式 |
|------|------|----------|
| journald | stdout 全量（启动 / WS / 认证 / API 失败 / 外部调用降级等） | `journalctl --user -u vrc-monitor` |
| 应用文件日志（可选） | 同一批行的文件副本（`core/logger.js`，自带 10MB×5 轮转） | `<VRC_MONITOR_LOGGER_DIR>/monitor.log` |
| `ops_log` 表 | 最近 500 条关键事件（认证 / WS / API / 外部调用） | MCP 工具 `get_ops_log` |

> 排查原则：**全量历史 → journald / 文件**；**最近关键事件 → `get_ops_log`**。三者可经 `GET /health.logging` 与 `GET /health.api` 交叉核对。

### 按级别过滤（依赖 `VRC_MONITOR_LOGGER_SYSLOG_PREFIX`）

模板已默认设 `Environment=VRC_MONITOR_LOGGER_SYSLOG_PREFIX=1`：stdout 行会带 `<N>` 前缀（3=err 4=warn 6=info 7=debug），systemd 的 `SyslogLevelPrefix=` 默认开启，会把它解析成 journald 的 `PRIORITY` 字段，于是：

```bash
journalctl --user -u vrc-monitor -p warning      # 只看带级别的 warn / err（覆盖边界见下）
journalctl --user -u vrc-monitor -p err -n 50
```

> ⚠️ **覆盖边界（重要）**：`<N>` 前缀只由 `core/logger.js` 产出。`start-monitor.js` 的 `console.error` **直写**（`[崩溃] Uncaught Exception` / `Unhandled Rejection`、端口 8799 被占用、`credentials.json` 缺失 / 解析失败 / 缺字段等启动与致命路径，共 24 处）**不经 logger、不带前缀**；而 systemd **不会**按 stderr 推断级别——未带前缀的行 stdout / stderr 一律取默认 `PRIORITY=6`(info)。因此 `journalctl -p warning` **看不到这些行**，其中恰有最不该漏的崩溃与致命启动错误。排查这类问题请去掉 `-p`（或用 `-p info`），再按 `_COMM` / `SYSLOG_IDENTIFIER` 与正文关键字过滤。

若 `-p` 过滤不到，先看 `/health.logging.syslogPrefix` 是否为 `true`（未开启则所有行都是默认 `info` 优先级）。

### 避免「一份日志存两处」

模板默认同时写 journald 与本地文件（`<仓库>/logs/monitor.log`）。若不需要文件留存（journald 已持久化 `/var/log/journal`）：

```ini
[Service]
Environment=VRC_MONITOR_LOGGER_FILE=0        # 只留 journald（stdout 永远保留）
```

> 副作用：关闭文件输出后，桌面 dashboard 日志页的**「文件」来源会一直显示未启用**（该来源按 `<LOG_DIR>/monitor.log` 是否存在判定），且它与 journald 来源不再有可交叉核对的同一批行；此时请改用 journald 来源 / `journalctl` 查看。`/health.logging` 的 `file` 会同步为 `false`、`filePath` 为空串。

反向（文件为准、journald 仅兜底）可设 `Environment=VRC_MONITOR_LOGGER_CONSOLE=0`——**不推荐**：容器 / 无文件场景会丢日志（DEVELOPMENT.md §3.8「stdout 永远保留」）。

日志目录建议交给 systemd 管理（systemd ≥ 235；用户服务下落在 `$XDG_STATE_HOME/log/`，`%L` 为其根，避免把运行数据写进仓库）：

```ini
LogsDirectory=vrc-monitor
Environment=VRC_MONITOR_LOGGER_DIR=%L/vrc-monitor
```

### 时区口径

应用日志时间戳是 **ISO UTC**（`...Z`），`journalctl` 默认按**本地时区**显示。跨两处对时间需换算——应用内事件时间同样存 UTC、展示层再转本地（DEVELOPMENT.md §3.6）。

### 日志量控制

- `VRC_MONITOR_LOGGER_LEVEL=warn`：只留 warn/error，降量最直接；
- `VRC_MONITOR_LOGGER_SUPPRESS=ping,keepalive`：命中子串的行整条丢弃；
- 单元已设 `LogRateLimitIntervalSec=30s` / `LogRateLimitBurst=20000`：超出部分被 journald 丢弃并记 `dropped` 计数（默认值 30s/10000 偏紧）。

### 结构化检索（供 Agent / jq）

两种方式让日志可被程序精确检索：

- **journald 原生 JSON**（无需改应用配置）：`journalctl` 的 `-o json` 每条输出带 `PRIORITY` / `_PID` / `__REALTIME_TIMESTAMP` / `SYSLOG_IDENTIFIER` 等字段，可直接按字段过滤：
  ```bash
  journalctl --user -u vrc-monitor -o json -n 500 \
    | jq -r 'select(.PRIORITY <= "4") | .MESSAGE'      # 只看带级别的 warn(4)/err(3)
  ```
  （`PRIORITY` 依赖 `VRC_MONITOR_LOGGER_SYSLOG_PREFIX=1`，见上；未开时所有行默认 `6`。**开启前缀后，不经 `core/logger.js` 的直写行（`console.error`）仍为 `6`**——覆盖边界见「按级别过滤」。）
- **应用 JSONL**：设 `VRC_MONITOR_LOGGER_FORMAT=json` 后，**文件**日志变为每行一个 JSON（`ts`/`level`/`name`/`msg`/`pid`），便于离线解析与留档；stdout 侧（journald）的 `MESSAGE` 也会是同一 JSON 文本。

## 与 Windows 方案的差异

| 能力 | Windows（service-windows/） | Linux（本目录） |
|------|----------------------------|-----------------|
| 开机自启 | 计划任务 VrcMonLauncher（onlogon） | systemd 用户服务 + linger |
| 崩溃自愈 | VrcMonWatchdog 每分钟轮询健康端点 | systemd `Restart=always`（进程退出 5s 后自动重启） |
| 日志 | `service-logs/` 文件（`VRC_MONITOR_LOG_DIR`） | journald（`journalctl --user -u vrc-monitor`） |
| 每日修复报告 | `vrcmon_daily_report.py`（昨天有修复才输出一行） | 可复用同一脚本（见下） |

**每日修复报告（可选）**：`service-windows/vrcmon_daily_report.py` 是跨平台的（README 注明非 Windows 可用），用 cron 指向它即可，空输出时 cron 静默不投递：

```bash
# crontab: 每天 09:00
0 9 * * * python3 <仓库>/service-windows/vrcmon_daily_report.py
```

> systemd 方案下崩溃自愈由 systemd 承担，`vrcmon_repairs.log` 通常不会有修复记录——报告主要面向 Windows watchdog 场景。

## 常用命令

| 操作 | 命令 |
|------|------|
| 查看状态 | `systemctl --user status vrc-monitor` |
| 实时日志 | `journalctl --user -u vrc-monitor -f` |
| 最近日志 | `journalctl --user -u vrc-monitor -n 100 --no-pager` |
| 重启服务 | `systemctl --user restart vrc-monitor` |
| 停止服务 | `systemctl --user stop vrc-monitor` |
| 健康检查 | `curl http://127.0.0.1:8799/health` |

## 卸载

```bash
bash service-linux/setup-linux.sh --uninstall
```

会停止服务并删除用户单元文件。如需同时关闭 linger（影响所有用户服务）：

```bash
loginctl disable-linger <用户名>
```

## 故障排查

**Q: 服务启动后登录失败（OTP 一直重试）？**
A: 大概率是 systemd 用户服务 PATH 中没有 python。用 `systemctl --user edit vrc-monitor` 添加 `Environment=VRC_MONITOR_PYTHON=/usr/bin/python3`（安装脚本已自动处理常见情况）。

**Q: 登出后服务就停了？**
A: 执行 `loginctl enable-linger` 让用户服务在无登录会话时继续运行。

**Q: `systemctl --user` 报错不可达？**
A: 无 systemd 用户实例（容器 / WSL / SSH 无会话）。在桌面会话中执行，或用 Hermes 插件 / 手动启动。

**Q: 日志在哪里？**
A: 默认两处——journald（`journalctl --user -u vrc-monitor -f`）与文件 `<仓库>/logs/monitor.log`（应用 `core/logger.js` 自带轮转）。当前生效配置见 `curl -s http://127.0.0.1:8799/health | jq .logging`（level/format/dir/filePath/file/console/syslogPrefix）。不需要文件留存时设 `VRC_MONITOR_LOGGER_FILE=0` 只留 journald。注意 `VRC_MONITOR_LOG_DIR` 是 Windows 方案的目录，与本服务的 `VRC_MONITOR_LOGGER_DIR` **不同名不同义**，勿混用。

**Q: `journalctl -p warning` 过滤不到日志？**
A: 两种成因。①**尚未启用前缀**：确认 `/health.logging.syslogPrefix` 为 `true`；模板已默认设 `VRC_MONITOR_LOGGER_SYSLOG_PREFIX=1`，手动安装的旧单元需补上并 `daemon-reload`。②**该行本就无级别**：`start-monitor.js` 的 `console.error` 直写（崩溃、端口占用、`credentials.json` 缺失/解析失败等启动与致命路径）不经 `core/logger.js`，systemd 不按 fd 推断级别、一律记为 `PRIORITY=6`(info)，`-p warning` 天然过滤掉——排查这类问题请去掉 `-p`（见「按级别过滤」的覆盖边界）。

**Q: 服务反复崩溃后 systemd 停止重启了？**
A: 模板已设启动护栏 `StartLimitIntervalSec=60` + `StartLimitBurst=5`（60s 内最多启 5 次），防止崩溃循环刷屏。确认配置无误后用 `systemctl --user reset-failed vrc-monitor` 清除计数再启动；确需放宽可 drop-in 设 `StartLimitIntervalSec=0`（关闭护栏）。
