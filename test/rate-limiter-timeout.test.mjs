/**
 * rate-limiter-timeout.test.mjs — rateLimiter 任务级超时 & API socket 超时回归测试（无凭据，自包含，供 CI/PR）
 *
 * 背景（commit 6e8c2e0，2026-08-31）：
 *   get_prints 等走 api.vrchat.fetch→rateLimiter 的工具曾卡 420s 无响应。
 *   根因：vrchat-api.js 的 https.request 无超时（socket 半通永挂）+ rateLimiter
 *         无任务级超时 → 队头死任务锁死整条队列（_processing 永不释放）。
 *
 * 本测试验证两层修复：
 *   1. rate-limiter.js 的 taskTimeoutMs 兜底：超时任务被 reject、队列恢复、后续任务正常。
 *   2. vrchat-api.js 的 socket 超时：静态断言五处 https.request 均配了 req.setTimeout。
 *
 * 运行：node --test test/rate-limiter-timeout.test.mjs
 * 无需 VRChat 凭据/网络（纯本地逻辑 + 源码静态校验）。
 *
 * 注：死任务用“挂起 > taskTimeoutMs 才 resolve”模拟而非“永不 resolve”，
 *     避免未清理的 pending Promise 阻止 node:test 的 event-loop 判定导致整个批次被 cancel。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..');

test('rateLimiter taskTimeoutMs：超时任务被 reject，队列不锁死，后续任务照常执行', async () => {
  const { RateLimiter } = await import(pathToFileURL(path.join(REPO, 'core', 'rate-limiter.js')).href);
  const rl = new RateLimiter({ minInterval: -1, maxQueueSize: 50, taskTimeoutMs: 400 });

  // 模拟“网络挂死”：比 taskTimeoutMs(400) 更久才完成 → 被超时兜底踢掉
  const slow = () => new Promise(r => setTimeout(r, 1200));

  const p1 = rl.execute(slow);                       // 应被超时 reject
  const p2 = rl.execute(async () => 'ok-2');         // 正常任务应执行

  const err1 = await p1.then(v => null, e => e);
  const v2 = await p2.then(v => v, null);

  assert.ok(err1, '超时任务应当被 reject');
  assert.match(String(err1.message), /超时/, `错误信息应含“超时”: ${err1.message}`);
  assert.equal(v2, 'ok-2', '后续正常任务应正常执行');

  await new Promise(r => setTimeout(r, 250));
  assert.equal(rl._queue.length, 0, '队列应清空');
  assert.equal(rl._processing, false, '_processing 应恢复 false（不锁死）');
});

test('rateLimiter 无 taskTimeoutMs 时保持默认开启（不小于 0 且默认 30000）', () => {
  // 默认构造应对任务级超时开启（这是本次修复的默认安全值）
  const defaults = [
    { label: '通过 src 默认值', src: readFileSync(path.join(REPO, 'core', 'rate-limiter.js'), 'utf8') },
  ];
  for (const { src } of defaults) {
    const m = src.match(/taskTimeoutMs\s*=\s*options\.taskTimeoutMs\s*\?\?\s*(\d+)/);
    assert.ok(m, 'rate-limiter 应默认设置 taskTimeoutMs=30000（防死任务锁队列）');
    const val = Number(m[1]);
    assert.ok(val > 0, `默认 taskTimeoutMs 应为正整数（当前 ${val}）`);
  }
});

test('rateLimiter per-task 超时覆盖：聚合任务可声明更大预算不被默认 30s 误杀', async () => {
  const { RateLimiter } = await import(pathToFileURL(path.join(REPO, 'core', 'rate-limiter.js')).href);
  // 实例默认超时极短(200ms)，但本任务显式声明 2000ms → 应能跑完不被默认误杀
  const rl = new RateLimiter({ minInterval: -1, maxQueueSize: 50, taskTimeoutMs: 200 });

  // 模拟聚合 handler：0.8s 完成，默认 200ms 会误杀，但 per-task 2000ms 足够
  const agg = () => new Promise(r => setTimeout(r, 800));
  const v = await rl.execute(agg, { taskTimeoutMs: 2000 }).then(x => x, e => e);
  assert.equal(v, undefined, 'per-task 大预算的任务应正常完成（不被默认 200ms 误杀）');

  await new Promise(r => setTimeout(r, 100));
  assert.equal(rl._queue.length, 0, '队列应清空');
  assert.equal(rl._processing, false, '_processing 应恢复 false');
});

test('rateLimiter per-task 超时覆盖：taskTimeoutMs=0 关闭该任务超时兜底', async () => {
  const { RateLimiter } = await import(pathToFileURL(path.join(REPO, 'core', 'rate-limiter.js')).href);
  const rl = new RateLimiter({ minInterval: -1, maxQueueSize: 50, taskTimeoutMs: 200 });

  // 0.6s 完成 > 实例默认 200ms，但本任务显式关闭超时(0) → 应正常完成
  const v = await rl.execute(() => new Promise(r => setTimeout(r, 600)), { taskTimeoutMs: 0 }).then(x => x, e => e);
  assert.equal(v, undefined, '关闭超时的任务应正常完成，不受实例默认 200ms 影响');
});

test('rateLimiter per-task 超时覆盖：显式更小预算会提前 reject', async () => {
  const { RateLimiter } = await import(pathToFileURL(path.join(REPO, 'core', 'rate-limiter.js')).href);
  const rl = new RateLimiter({ minInterval: -1, maxQueueSize: 50, taskTimeoutMs: 5000 });
  const slow = () => new Promise(r => setTimeout(r, 1500));
  const err = await rl.execute(slow, { taskTimeoutMs: 300 }).then(v => null, e => e);
  assert.ok(err, '显式更小预算的任务应被 reject');
  assert.match(String(err.message), /超时/, `错误信息应含“超时”: ${err.message}`);
});

test('vrchat-api.js：全部 https.request 均配置 req.setTimeout 超时兜底', () => {
  const src = readFileSync(path.join(REPO, 'vrchat-api.js'), 'utf8');
  const requestSites = [...src.matchAll(/https\.request\(/g)].length;
  const setTimeoutSites = [...src.matchAll(/req\.setTimeout\(REQUEST_TIMEOUT_MS/g)].length;

  assert.ok(requestSites >= 1, 'vrchat-api.js 应至少有一处 https.request');
  assert.equal(
    setTimeoutSites,
    requestSites,
    `每一处 https.request 都需配 req.setTimeout(REQUEST_TIMEOUT_MS)：request=${requestSites}, setTimeout=${setTimeoutSites}`
  );
});

test('vrchat-api.js：REQUEST_TIMEOUT_MS 常量已定义且为合理正整数', () => {
  const src = readFileSync(path.join(REPO, 'vrchat-api.js'), 'utf8');
  const m = src.match(/const REQUEST_TIMEOUT_MS\s*=\s*(\d+)/);
  assert.ok(m, '应定义 REQUEST_TIMEOUT_MS 常量');
  const val = Number(m[1]);
  assert.ok(Number.isFinite(val) && val > 0 && val <= 120000, `REQUEST_TIMEOUT_MS 应为 1s~120s 间的正整数: ${val}`);
});
