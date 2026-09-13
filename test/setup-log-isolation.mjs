// 测试日志隔离（交付 B2）——经 `node --test --import` 以第一条 import 的语义生效。
// 把 VRC_MONITOR_LOGGER_DIR 钉到每次运行唯一的系统临时目录，防止任何测试进程（含子进程）
// 把日志写进继承自 shell 的 VRC_MONITOR_DIR/logs（生产日志目录）。
// 污染实测：主仓库生产日志累计 96 行 wrld_kbtest-* 测试夹具（生产 DB 查无此 world）。
// 若 --import 未透传到某子进程，core/logger.js resolveDir 的 NODE_TEST_CONTEXT 兜底（B1）
// 仍会把日志落到 os.tmpdir()/vrc-monitor-test-logs，双层防御都保证不碰生产目录。
import os from 'node:os';
import path from 'node:path';

process.env.VRC_MONITOR_LOGGER_DIR = path.join(
  os.tmpdir(),
  `vrc-monitor-test-logs-${process.pid}-${Date.now()}`
);
