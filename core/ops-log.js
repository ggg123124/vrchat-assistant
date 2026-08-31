/**
 * 服务运维日志（ops_log）记录入口 —— 认证/WS 生命周期关键事件。
 *
 * 独立于 events 表（动态流语义），自带保留策略（storage.insertOpsLog 内裁剪最近 500 条）。
 * 设计：零导入 + sink 注入（start-monitor 启动时接线到 storage）——
 * 未接线（单测/早期启动）或写入失败时静默 no-op，运维日志绝不影响主流程。
 */
let sink = null;

/** 由 start-monitor.js 启动时接线：fn(kind, level, message) */
export function setOpsLogSink(fn) {
  sink = typeof fn === 'function' ? fn : null;
}

/**
 * 记录一条运维日志。
 * @param {'auth'|'ws'|'ops'} kind 类别
 * @param {'info'|'warn'|'error'} level 级别
 * @param {string} message 消息（不含敏感值——调用方禁止传入 authToken/cookie）
 */
export function recordOpsLog(kind, level, message) {
  if (!sink) return;
  try {
    sink(kind, level, String(message));
  } catch { /* no-op */ }
}
