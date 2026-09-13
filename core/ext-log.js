/**
 * 外部服务调用留痕（单一来源）—— PlanetVRC / X 抓取 / BOOTH / Google Calendar / IMAP-OTP 等
 * 非 VRChat 官方 API 的外部调用统一走这里，保证「失败 / 降级 / 兜底」在日志里各留一行，
 * 且同时落 ops_log（kind='ext'，可查询、有界 500 条），避免各插件/模块各写一套文案。
 *
 * 设计约定（与 core/logger.js、core/ops-log.js 的分工）：
 *   - 文件日志：失败 → WARN，降级/兜底 → INFO，成功 → debug（>2000ms 的慢调用升 INFO）。
 *     成功的快调用默认静默：外部抓取是高频路径，成功逐条 INFO 会把日志重新变成噪音源。
 *   - ops_log：只记失败（warn）与降级（info），供 get_ops_log / 看板日志页检索。
 *   - 统计：getExtStats() 供 /health 暴露，有界累积（服务表上限 MAX_SERVICES），长跑不涨内存。
 *
 * 禁止静默降级：调用方在「缓存命中 / 远端成功 / 跳过 / 失败」每个分支都要调用对应函数，
 * 一次触发恰好一行。任何写入异常都被吞掉——留痕本身绝不能影响主流程。
 */
import { getLogger } from './logger.js';
import { recordOpsLog } from './ops-log.js';

const log = getLogger('ext');

// 慢调用阈值（毫秒，代码常量）：外部抓取成功但耗时超过该值 → 升格 INFO 可见
const EXT_SLOW_MS = 2000;

// 统计表上限：服务条目超过则逐出计数最小项（有界）
const MAX_SERVICES = 50;

const stats = {
  failures: 0,
  fallbacks: 0,
  slow: 0,
  byService: new Map(), // service -> { failures, fallbacks, last, lastAt }
  lastFailure: null,    // { service, op, reason, at }
};

function clip(text, max = 200) {
  return String(text ?? '').replace(/[\r\n]+/g, ' ').slice(0, max);
}

function bumpService(service, field, detail = '') {
  const key = clip(service, 60) || 'unknown';
  const entry = stats.byService.get(key) || { failures: 0, fallbacks: 0, last: '', lastAt: null };
  entry[field] += 1;
  if (detail) {
    entry.last = clip(detail, 120);
    entry.lastAt = new Date().toISOString();
  }
  stats.byService.set(key, entry);
  if (stats.byService.size > MAX_SERVICES) {
    let minKey = null;
    let minCount = Infinity;
    for (const [k, v] of stats.byService) {
      const total = v.failures + v.fallbacks;
      if (total < minCount) { minCount = total; minKey = k; }
    }
    if (minKey !== null) stats.byService.delete(minKey);
  }
}

/**
 * 外部调用失败留痕（WARN + ops_log）。
 * @param {string} service 服务名（PlanetVRC / X / BOOTH / GoogleCalendar / IMAP-OTP …）
 * @param {string} op 操作描述（如 `抓取排行 popular`、`拉取 OTP`）
 * @param {Error|string} err 错误对象或原因
 * @param {{durationMs?:number, attempt?:number, level?:'warn'|'error'}} [opts]
 * @returns {string} 实际写出的文案（便于测试断言/复用）
 */
export function logExtFailure(service, op, err, opts = {}) {
  const durationMs = Number(opts.durationMs) || 0;
  const attempt = Number(opts.attempt) || 0;
  const reason = clip(err && err.message ? err.message : err, 200) || '未知错误';
  const attemptText = attempt > 1 ? `，第 ${attempt} 次` : '';
  const line = `${service} ${op} 失败: ${reason}（耗时 ${durationMs}ms${attemptText}）`;
  try {
    if (opts.level === 'error') log.error(line);
    else log.warn(line);
    recordOpsLog('ext', 'warn', `[ext] ${line}`);
    stats.failures += 1;
    stats.lastFailure = { service: clip(service, 60), op: clip(op, 80), reason, at: new Date().toISOString() };
    bumpService(service, 'failures', reason);
  } catch { /* 留痕失败不影响主流程 */ }
  return line;
}

/**
 * 降级 / 兜底 / 缓存命中留痕（INFO + ops_log）。
 * 覆盖语义：缓存命中、远端不可达转本地、跳过（前置条件不满足）、部分失败保留旧数据。
 * @returns {string}
 */
export function logExtFallback(service, op, reason) {
  const line = `${service} ${op} 降级: ${clip(reason, 200) || '未提供原因'}`;
  try {
    log.info(line);
    recordOpsLog('ext', 'info', `[ext] ${line}`);
    stats.fallbacks += 1;
    bumpService(service, 'fallbacks', reason);
  } catch { /* no-op */ }
  return line;
}

/**
 * 外部调用成功留痕：默认 debug（静默）；耗时超过 EXT_SLOW_MS 时升格 INFO（成功但慢才是信号）。
 * @returns {string}
 */
export function logExtSuccess(service, op, opts = {}) {
  const durationMs = Number(opts.durationMs) || 0;
  try {
    if (durationMs > EXT_SLOW_MS) {
      stats.slow += 1;
      log.info(`${service} ${op} 成功但慢（${durationMs}ms > ${EXT_SLOW_MS}ms）`);
    } else {
      log.debug(`${service} ${op} 成功（${durationMs}ms）`);
    }
  } catch { /* no-op */ }
  return `${service} ${op} 成功（${durationMs}ms）`;
}

/** 统计快照（/health 用）。字段只增不改。 */
export function getExtStats() {
  return {
    failures: stats.failures,
    fallbacks: stats.fallbacks,
    slow: stats.slow,
    lastFailure: stats.lastFailure,
    topFailures: [...stats.byService.entries()]
      .filter(([, v]) => v.failures > 0)
      .map(([service, v]) => ({ service, failures: v.failures, fallbacks: v.fallbacks, last: v.last, lastAt: v.lastAt }))
      .sort((a, b) => b.failures - a.failures)
      .slice(0, 5),
  };
}

/** 测试用：清空统计（生产不调用）。 */
export function resetExtStats() {
  stats.failures = 0;
  stats.fallbacks = 0;
  stats.slow = 0;
  stats.byService.clear();
  stats.lastFailure = null;
}
