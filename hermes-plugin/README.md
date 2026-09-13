# hermes-plugin（vrc-monitor 进程托管）

Hermes 插件：托管 vrc-monitor Node.js 服务的启停与状态查询（工具 `vrc_start` / `vrc_stop` / `vrc_restart` / `vrc_status`），并把 node 子进程的 stdout/stderr 合并捕获到日志文件。

## stdout 捕获文件与轮转

- **捕获文件位置**：`$HERMES_HOME/workspace/vrc-monitor/monitor.log`（Hermes home 默认 Windows `%LOCALAPPDATA%\hermes`、Linux/macOS `~/.hermes`）。该文件是子进程 stdout/stderr 的合并重定向，只追加、从不清理——不轮转会无限增长（曾实测 3.7MB）。
- **轮转时机（双钩子）**：
  1. `vrc_start` 启动进程前检查一次（低频事件；未达阈值时写一行「跳过」日志，含当前大小）；
  2. `vrc_status` 每次状态查询时检查一次——常驻服务数周不重启时这是唯一的阈值检查时机（`status()` 的「跳过」分支**不写日志行**，防 Agent 高频调用把捕获文件变成新的刷屏源，结果经返回值的 `log_capture` 字段可见）。
- **阈值 / 保留份数**：默认 10MB / 5 份（与 `core/logger.js` 的 maxSize/maxFiles 默认一致）。阈值可用环境变量 `VRC_MONITOR_CAPTURE_LOG_MAX_SIZE`（字节）覆盖——注意它只管本插件捕获文件，与 logger 模块结构化日志（`<VRC_MONITOR_DIR>/logs/monitor.log`）的 `VRC_MONITOR_LOGGER_MAX_SIZE` **不同名不同义**。
- **归档命名**：`monitor-<UTC YYYYMMDD-HHMMSS>-<pid>.log.gz`，对齐 `core/logger.js doRotate()`。清理时 `.gz` 与 gzip 失败遗留的未压缩 `monitor-*.log` 两类归档**共享同一个保留预算**（总数口径，按 mtime 删最旧）；active 文件 `monitor.log` 不带 `monitor-<ts>-` 前缀，两个 glob 都匹配不到，不会被误删。
- **轮转方式（rename 优先 + copytruncate 兜底）**：先 rename → gzip → 删未压缩件（原子、无损）；Windows 下子进程持有 stdout 句柄时运行中 rename 必失败（`WinError 32` 另一个程序正在使用此文件），自动回退 **copytruncate**（复制成 .gz 归档 → 清空 active 文件，子进程后续写入正常落在新 EOF）。copytruncate 有微秒级竞态：拷贝与清空之间子进程新写入的行会随清空丢失（与 Unix `logrotate copytruncate` 同性质），已用「最多 3 次 stat→读→再 stat，两次 size 一致（期间无新写入）才清空」最小化。
- **留痕**：轮转成功 / 失败两个分支在两个钩子里都各写一行 `[plugin] 日志轮转: …` / `[plugin] 日志轮转失败（不阻断启动/不影响本次状态查询，继续追加）：…` 进（新的）active 文件（禁静默降级）；任何轮转异常都不阻断启动 / 状态查询。
- **`vrc_status` 新增 `log_capture` 字段**（只增不改，`log_file` 等既有字段语义不变）：

  ```json
  {
    "path": "…/workspace/vrc-monitor/monitor.log",
    "size": 3670016,
    "threshold": 10485760,
    "rotated": false,
    "method": null,
    "removed": [],
    "error": null
  }
  ```

  `method` 取值 `rename` | `copytruncate` | `null`（未轮转）；`error` 仅轮转失败时非空。

## 测试

```
python -m unittest discover -s hermes-plugin/tests -v
```

`tests/test_log_rotation.py` 自带 `hermes_constants` stub，不依赖 Hermes 运行时；覆盖 rename / copytruncate（mock `PermissionError`）两条路径、竞态缓解重试、未压缩遗留归档清理与共享预算、env 改名（新名生效 / 旧名不生效）、`status()` 双钩子防刷屏与 `log_capture` 字段。
