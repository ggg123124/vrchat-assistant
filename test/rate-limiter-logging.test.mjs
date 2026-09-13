/**
 * test/rate-limiter-logging.test.mjs — R2 限流器可观测性回归测试
 *
 * 覆盖：
 *   - 等待 >1000ms → INFO 一行「限流等待」+ slowWaits 计数（minInterval=1100）
 *   - 等待 ≤1000ms → 不记日志仅计数（slowWaits=0，totalWaitedMs 照常累计）
 *   - 队列满 → WARN + ops_log('ops','warn') + queueFull 计数 + maxQueueLen 峰值
 *   - 任务超时 → WARN + ops_log + taskTimeouts 计数，后续任务照常执行
 *   - getStats：既有字段不变 + 新增 queueFull/taskTimeouts/slowWaits/maxQueueLen
 *
 * 自包含：纯本地逻辑，无 VRChat 凭据/网络依赖。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..');

// 先初始化 logger（临时目录 + debug 级别）：防止惰性初始化污染仓库 logs/
const { initLogger } = await import(pathToFileURL(path.join(REPO, 'core', 'logger.js')).href);
const tmpLogDir = mkdtempSync(path.join(os.tmpdir(), 'vrc-rl-obs-'));
initLogger({ dir: tmpLogDir, level: 'debug' });

const { RateLimiter } = await import(pathToFileURL(path.join(REPO, 'core', 'rate-limiter.js')).href);
const { setOpsLogSink } = await import(pathToFileURL(path.join(REPO, 'core', 'ops-log.js')).href);

const ops = [];
setOpsLogSink((kind, level, message) => ops.push({ kind, level, message }));

after(() => {
  setOpsLogSink(null);
  rmSync(tmpLogDir, { recursive: true, force: true });
});

function captureConsole() {
  const lines = { debug: [], info: [], warn: [], error: [] };
  const orig = { debug: console.debug, info: console.info, warn: console.warn, error: console.error };
  console.debug = (...a) => { lines.debug.push(a.join(' ')); };
  console.info = (...a) => { lines.info.push(a.join(' ')); };
  console.warn = (...a) => { lines.warn.push(a.join(' ')); };
  console.error = (...a) => { lines.error.push(a.join(' ')); };
  return {
    lines,
    restore() {
      console.debug = orig.debug; console.info = orig.info;
      console.warn = orig.warn; console.error = orig.error;
    },
  };
}

test('等待 >1000ms：INFO 一行留痕 + slowWaits 计数（minInterval=1100）', async () => {
  const rl = new RateLimiter({ minInterval: 1100, maxQueueSize: 10, taskTimeoutMs: 5000 });
  const cap = captureConsole();
  await rl.execute(async () => 'a');
  await rl.execute(async () => 'b');
  cap.restore();

  const s = rl.getStats();
  assert.equal(s.slowWaits, 1, '第二次调用等待 ~1100ms 应计 1 次慢等待');
  assert.match(cap.lines.info.join('\n'), /限流等待 1\d{3}ms（队列 \d+ 个任务）/);
  assert.equal(cap.lines.warn.length, 0);
});

test('等待 ≤1000ms：不记日志仅计数（minInterval=40）', async () => {
  const rl = new RateLimiter({ minInterval: 40, maxQueueSize: 10, taskTimeoutMs: 5000 });
  const cap = captureConsole();
  await rl.execute(async () => 'a');
  await rl.execute(async () => 'b');
  cap.restore();

  const s = rl.getStats();
  assert.equal(s.slowWaits, 0, '≤1000ms 等待不应计慢等待');
  assert.ok(!/限流等待/.test(cap.lines.info.join('\n')), '≤1000ms 不应输出慢等待 INFO');
  assert.ok(s.totalWaitedMs > 0, '等待时间仍应累计（既有字段不受影响）');
});

test('队列满：WARN 留痕 + ops_log + queueFull 计数 + maxQueueLen 峰值', async () => {
  const rl = new RateLimiter({ minInterval: 0, maxQueueSize: 1, taskTimeoutMs: 5000 });
  let release;
  const gate = new Promise((r) => { release = r; });
  const p1 = rl.execute(() => gate.then(() => 'done-1'));
  const p2 = rl.execute(async () => 'done-2');

  const cap = captureConsole();
  const err3 = await rl.execute(async () => 'never').then((v) => null, (e) => e);
  cap.restore();

  assert.match(String(err3.message), /queue full/, '第三个任务应因队列满被拒');
  const s = rl.getStats();
  assert.equal(s.queueFull, 1);
  assert.equal(s.maxQueueLen, 1);
  assert.match(cap.lines.warn.join('\n'), /限流队列已满，拒绝新任务/);
  const qOps = ops.filter((o) => o.kind === 'ops' && /队列已满/.test(o.message));
  assert.equal(qOps.length, 1);
  assert.equal(qOps[0].level, 'warn');

  release();
  assert.equal(await p1, 'done-1');
  assert.equal(await p2, 'done-2');
});

test('任务超时：WARN 留痕 + ops_log + taskTimeouts 计数，后续任务照常', async () => {
  const rl = new RateLimiter({ minInterval: 0, maxQueueSize: 10, taskTimeoutMs: 100 });
  // 挂死任务用「500ms 后才 resolve」模拟（比 taskTimeoutMs=100 久）：
  // 不用「永不 resolve」，否则 pending Promise 会让 node:test 判定 event loop 已清空而取消整个文件
  const slow = () => new Promise((r) => setTimeout(r, 500));

  const cap = captureConsole();
  const err = await rl.execute(slow).then((v) => null, (e) => e);
  const v2 = await rl.execute(async () => 'after');
  cap.restore();

  assert.match(String(err.message), /任务超时/, '挂死任务应被任务级超时 reject');
  assert.equal(v2, 'after', '后续任务应照常执行');
  const s = rl.getStats();
  assert.equal(s.taskTimeouts, 1);
  assert.match(cap.lines.warn.join('\n'), /\[限流\] Rate limiter 任务超时 \(100ms\)/);
  const tOps = ops.filter((o) => o.kind === 'ops' && /任务超时/.test(o.message));
  assert.equal(tOps.length, 1);
  assert.equal(tOps[0].level, 'warn');

  // 等挂起的 slow 任务结算，避免本文件其余测试被 cancelledByParent
  await new Promise((r) => setTimeout(r, 600));
});

test('getStats：既有字段保留 + 新增四字段', () => {
  const rl = new RateLimiter({ minInterval: 2500 });
  const s = rl.getStats();
  assert.equal(s.totalCalls, 0);
  assert.equal(s.totalWaitedMs, 0);
  assert.equal(s.queueLength, 0);
  assert.equal(s.isProcessing, false);
  assert.equal(s.minInterval, 2500);
  assert.equal(s.queueFull, 0);
  assert.equal(s.taskTimeouts, 0);
  assert.equal(s.slowWaits, 0);
  assert.equal(s.maxQueueLen, 0);
});
