# vrc-monitor 常驻服务（Windows）

让 vrc-monitor 服务**开机自动启动、崩溃自动修复**，不需要人工干预，也不会因为 Hermes gateway 重启或终端关闭而中断记录。

## 组件

| 文件 | 作用 |
|------|------|
| `vrcmon_service_launcher.py` | 以独立（detached）进程启动服务；幂等（已在运行则跳过）。用于登录自启动 |
| `vrcmon_watchdog.py` | 崩溃自愈：每分钟检查健康端点，经「启动宽限 + 连续失败」两道闸判定后杀掉残留进程并重启，把修复记录写入 `service-logs/vrcmon-repairs.log`。**全程静默**（无输出）。判据与状态文件见下节 |
| `vrcmon_daily_report.py` | 每日修复报告：统计昨天的修复次数，**昨天有修复才打印一行**（否则完全静默），可接任意通知渠道 |
| `setup-windows.cmd` | 一键注册计划任务 + 登录自启动（含权限不足时回退 Startup 文件夹） |

## 判定逻辑与状态文件（watchdog）

三道**独立**的闸，全部放行才会杀进程重启（常量都在 `vrcmon_watchdog.py` 顶部）：

| 闸 | 常量 | 作用 |
|----|------|------|
| 健康检查 | `HEALTH_TIMEOUT = 8`（秒） | 单次 `/health` 超时。它只**降低误判概率**，不解决"初始化期间端点本就不可用" |
| 启动宽限 | `GRACE_SECONDS = 300`（秒） | 服务"开始启动"至今不足 300s ⇒ 视为启动中，不介入（大库 `storage.init` 实测 50-70s+） |
| 连续失败 | `FAIL_THRESHOLD = 2` / `FAIL_WINDOW = 600`（秒） | 同类不健康连续 2 次（= 相邻两个每分钟探测点，≈120s）才判宕机；单次超时（事件循环被小时级任务阻塞）不再误杀 |

状态文件（都在本地、不进仓库）：

| 文件 | 位置 | 说明 |
|------|------|------|
| `.vrcmon-watchdog-launch` | `service-logs/` | 本 watchdog 上次拉起服务的时刻戳（`GRACE_SECONDS` 判定用） |
| `.vrcmon-watchdog-unhealthy` | `service-logs/` | 连续探测失败计数（内容 `count epoch`）；探活成功即删除 |
| `.vrcmon-service-start` | 服务日志目录（`VRC_MONITOR_LOGGER_DIR`；默认 `<项目>/logs`） | **服务自己**在 `storage.init` 前写的启动戳记（`start-monitor.js`）。有它以后，**任何拉起渠道**（本 watchdog / launcher / 手动 / Hermes 插件 `vrc_start`）拉起的实例都能获得启动宽限 |

边界（如实声明）：

- 两枚启动戳记都不存在时（例如把仓库拷到新机器后直接 `node start-monitor.js`，本 watchdog 从未拉起过它）**不使用启动宽限**，此时仍由"连续失败"闸兜底 —— 实测外部拉起 + init≈70s 为 0 次误杀，init > ~120s 时最坏被误杀一次。
- 拉起后 25s 验证失败时**先判进程是否真的消失**：进程已消失（拉起即崩溃）⇒ 清除两枚戳记 + 回拨失败计数，下一轮立即重试；**进程仍在**（大概率仍在 init —— 25s 对 init 50-70s+ 的部署是假阴性）⇒ **保留宽限**，交回 `GRACE_SECONDS` 兜底。
- 服务侧日志目录变量 `VRC_MONITOR_LOGGER_DIR` 既可写在环境变量里，也可只写在仓库 `.env`（`start-monitor.js` 会无条件加载它）—— watchdog 两处都读。watchdog 自己的 `VRC_MONITOR_LOG_DIR` 则**必须**在环境变量里（计划任务看不到 `.env`）。

### 修复日志格式

`service-logs/vrcmon-repairs.log` 每行以日期开头，`vrcmon_daily_report.py` 按日期前缀计数：

```
2026-09-23 16:55:28 repair                                    # 拉起后 25s 验证健康
2026-09-23 17:12:03 repair (unverified: not healthy after 25s, 进程仍在)      # 仍在 init
2026-09-23 17:12:03 repair (unverified: not healthy after 25s, 进程已消失)    # 拉起即崩溃
```

后两种也计入每日报告 —— 否则"每分钟重启但始终没起来"会被统计成"昨天 0 次修复"。

### 自测

```bash
python service-windows/tests/test_vrcmon_watchdog.py   # 判据单测 + 长 init 时间线回归（打桩，无副作用）
```

CI 也会跑（见 `.github/workflows/ci.yml`）。**非 Windows 部署**（Linux / docker / systemd）不使用本 watchdog，但主服务同样会写 `logs/.vrcmon-service-start`（每次启动覆盖，仅作启动时刻标记）——看到该文件属正常，可安全忽略。

## 快速开始（Windows）

```bat
service-windows\setup-windows.cmd
```

脚本会自动：
1. 创建 `VrcMonWatchdog` 计划任务（每 1 分钟检查，崩溃自动重启）
2. 创建 `VrcMonLauncher` 登录自启动（onlogon 计划任务；权限不足时回退写入当前用户 Startup 文件夹的 VBS）
3. 立即启动服务（若未运行）

脚本的控制台提示为**英文**——这是刻意的，原因见下节「编码约定」。

## 编码约定：`setup-windows.cmd` 必须是纯 ASCII

`cmd.exe` **按当前控制台代码页解析批处理文件本身**（中文 Windows 默认 CP936、英文 CP1252、日文 CP932），而解析发生在脚本内 `chcp` 生效**之前**。文件里只要出现非 ASCII 字节（中文注释 / 中文提示），多字节序列就可能吞掉同一行后面的 ASCII 字节，把该行拆成「半截命令」执行，报错形如：

```text
'etup-windows.cmd' is not recognized as an internal or external command,
operable program or batch file.
```

实测（Windows 11 中文版，`chcp` = 936，同一份脚本内容）：

| 文件形态 | 结果 |
|----------|------|
| UTF-8（含中文）+ CRLF，即 Windows 默认检出 | 3 行被拆坏；`rem` 注释行与 `echo` 行都可能被当成命令执行 |
| UTF-8（含中文）+ LF，即 `core.autocrlf=false` 检出 | 更严重：`@echo off` 被吞、脚本开始回显、`echo` 行的前缀丢失 |
| **纯 ASCII**（本文件现状） | 所有行解析正常，无任何杂散报错 |

因此：

- `setup-windows.cmd` 的注释与提示一律用 **ASCII（英文）** 写。不要为了「中文友好」把中文加回这个文件——中文说明就放在本 `README.md`。
- 在脚本里加 `chcp 65001` **修不好**这个问题（解析早于 `chcp` 生效；实测「先切码页再 `call`」仍有杂散报错），不要走这个方案。
- 其它 `.cmd` / `.bat` 同理：要么纯 ASCII，要么存成目标平台默认代码页（GBK/CP936）并接受跨语言环境失效的风险。

## 每日修复报告（可选）

每天 09:00 统计昨天的自动修复次数，**昨天没有修复就完全不输出**（零通知、零消耗）：

```bat
schtasks /create /tn VrcMonDailyReport /tr "\"<python路径>\" \"<仓库>\service-windows\vrcmon_daily_report.py\"" /sc daily /st 09:00 /f
```

Hermes 用户也可以建 no_agent cron 指向 `vrcmon_daily_report.py`——脚本空输出时 cron 静默不投递。

## 路径配置（环境变量）

与 `start-monitor.js` 的 `.env` 约定一致，可选：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `VRC_MONITOR_DIR` | 脚本所在目录的上一级 | 项目根目录 |
| `VRC_MONITOR_NODE` | PATH 中的 `node` | node 可执行文件路径 |
| `VRC_MONITOR_LOG_DIR` | `<项目>/service-logs` | 服务日志 / 修复日志 / watchdog 日志目录 |

## 卸载

```bat
schtasks /delete /tn VrcMonWatchdog /f
schtasks /delete /tn VrcMonLauncher /f
rem 若走的是 Startup 回退：删除 %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\VrcMon_Launcher.vbs
```

## 平台说明

- 组件主要面向 **Windows**（detached 启动、netstat/taskkill 残留清理、计划任务/VBS）。
- 非 Windows（macOS / Linux / NAS / Docker）：服务本身跨平台；`vrcmon_service_launcher.py` / `vrcmon_watchdog.py` 的非 Windows 路径同样可用（跳过残留清理，仅做健康检查 + 重启），可用 systemd / cron 接入：
  ```bash
  # systemd timer 示例（每分钟）或 crontab:
  * * * * * python3 <仓库>/service-windows/vrcmon_watchdog.py
  ```
