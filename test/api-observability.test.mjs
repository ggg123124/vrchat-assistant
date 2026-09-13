/**
 * test/api-observability.test.mjs — R1 外部调用可观测性：vrchat-api.js 单点留痕回归测试
 *
 * 覆盖：
 *   - 200 快请求 → debug 一行（默认不升 INFO，不产生 WARN/ops_log）
 *   - 200 慢请求（>2000ms）→ INFO「慢调用」+ slow 计数
 *   - 非 2xx（500/429）→ WARN + ops_log('api','warn') + byStatus + topFailures 路径归一化（/users/:id）
 *   - DNS 失败 → WARN「请求失败」+ failed 计数（error 分类，不误计入 timeouts）
 *   - socket 超时 → WARN「超时」+ ops_log + timeouts 计数（VRC_MONITOR_API_TIMEOUT_MS=300 加速）
 *   - VRC_MONITOR_LOG_API_SUCCESS=1 → 成功请求升 INFO；未设 → 仅 debug
 *   - getApiStats：total/ok/failed/avgMs/p95Ms 形状与合理性；ops_log 消息不含 cookie/token
 *
 * 自包含：本地 node:http stub server + VRC_MONITOR_API_BASE 环境变量指向 stub，
 * 不依赖真实 VRChat 凭据/网络。VRC_MONITOR_API_TIMEOUT_MS 缩小超时以加速测试。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..');

// 先初始化 logger（临时目录 + debug 级别）：防止惰性初始化污染仓库 logs/，并让 debug 留痕可见
const { initLogger, setLevel } = await import(pathToFileURL(path.join(REPO, 'core', 'logger.js')).href);
const tmpLogDir = mkdtempSync(path.join(os.tmpdir(), 'vrc-api-obs-'));
initLogger({ dir: tmpLogDir, level: 'debug' });
setLevel('debug');

const { VrchatApiClient, normalizeApiPath } = await import(pathToFileURL(path.join(REPO, 'vrchat-api.js')).href);
const { setOpsLogSink } = await import(pathToFileURL(path.join(REPO, 'core', 'ops-log.js')).href);

const USR_ID = 'usr_01234567-0123-4123-8123-0123456789ab';

// ── 本地 stub server ──
const stub = http.createServer((req, res) => {
  if (req.url.startsWith('/users/fast')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"id":"fast"}');
    return;
  }
  if (req.url.startsWith('/users/slow')) {
    setTimeout(() => { res.writeHead(200); res.end('{"id":"slow"}'); }, 2300);
    return;
  }
  if (req.url.startsWith(`/users/${USR_ID}/server-error`)) {
    res.writeHead(500); res.end('{"error":"boom"}');
    return;
  }
  if (req.url.startsWith(`/users/${USR_ID}/rate-limited`)) {
    res.writeHead(429); res.end('{"error":"rate"}');
    return;
  }
  if (req.url.startsWith('/users/hang')) {
    // 不回包：触发客户端 socket 超时
    return;
  }
  res.writeHead(404); res.end('{"error":"not found"}');
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const PORT = stub.address().port;

process.env.VRC_MONITOR_API_BASE = `http://127.0.0.1:${PORT}`;
delete process.env.VRC_MONITOR_API_TIMEOUT_MS;
delete process.env.VRC_MONITOR_LOG_API_SUCCESS;

const ops = [];
setOpsLogSink((kind, level, message) => ops.push({ kind, level, message }));

after(() => {
  setOpsLogSink(null);
  delete process.env.VRC_MONITOR_API_BASE;
  delete process.env.VRC_MONITOR_API_TIMEOUT_MS;
  delete process.env.VRC_MONITOR_LOG_API_SUCCESS;
  stub.close();
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

test('200 快请求：debug 一行留痕，不升 INFO、不产生 WARN/ops_log', async () => {
  const client = new VrchatApiClient(null, null);
  const cap = captureConsole();
  const res = await client._request('GET', '/users/fast');
  cap.restore();

  assert.equal(res.status, 200);
  assert.equal(res.data.id, 'fast');
  assert.match(cap.lines.debug.join('\n'), /GET \/users\/fast → 200（\d+ms）/);
  assert.equal(cap.lines.info.length, 0, '默认快成功不应升 INFO');
  assert.equal(cap.lines.warn.length, 0);
  const s = client.getApiStats();
  assert.equal(s.total, 1);
  assert.equal(s.ok, 1);
  assert.equal(s.failed, 0);
  assert.deepEqual(s.byStatus, { 200: 1 });
  assert.equal(ops.length, 0, '快成功不应写 ops_log');
});

test('200 慢请求（>2000ms）：INFO 慢调用 + slow 计数', async () => {
  const client = new VrchatApiClient(null, null);
  const cap = captureConsole();
  const res = await client._request('GET', '/users/slow');
  cap.restore();

  assert.equal(res.status, 200);
  assert.match(cap.lines.info.join('\n'), /GET \/users\/slow → 200（\d+ms 慢调用）/);
  const s = client.getApiStats();
  assert.equal(s.slow, 1);
  assert.equal(s.ok, 1);
  assert.equal(s.failed, 0);
});

test('非 2xx（500/429）：WARN + ops_log(api,warn) + byStatus + topFailures 路径归一化', async () => {
  const client = new VrchatApiClient(null, null);
  const cap = captureConsole();
  const r1 = await client._request('GET', `/users/${USR_ID}/server-error`);
  const r2 = await client._request('GET', `/users/${USR_ID}/rate-limited`);
  cap.restore();

  assert.equal(r1.status, 500);
  assert.equal(r2.status, 429);
  const warns = cap.lines.warn.join('\n');
  assert.match(warns, /GET \/users\/:id\/server-error → 500（\d+ms）/);
  assert.match(warns, /GET \/users\/:id\/rate-limited → 429（\d+ms）/);

  const s = client.getApiStats();
  assert.equal(s.failed, 2);
  assert.deepEqual(s.byStatus, { 500: 1, 429: 1 });
  assert.ok(Array.isArray(s.topFailures) && s.topFailures.length >= 2, 'topFailures 应含两条失败路径');
  assert.ok(s.topFailures.every((f) => f.path.startsWith('/users/:id/')), '路径应归一化为 /users/:id/...');
  assert.match(String(s.lastFailure), /:id\/rate-limited/);

  const apiOps = ops.filter((o) => o.kind === 'api');
  assert.equal(apiOps.length, 2);
  assert.ok(apiOps.every((o) => o.level === 'warn' && /GET \/users\/:id\//.test(o.message)));
  assert.ok(apiOps.every((o) => !/auth=|cookie|token/i.test(o.message)), 'ops_log 消息不应含 cookie/token');
});

test('DNS 失败：WARN 请求失败 + ops_log + failed 计数（error 分类，不误计 timeouts）', async () => {
  const prevBase = process.env.VRC_MONITOR_API_BASE;
  process.env.VRC_MONITOR_API_BASE = 'http://no-such-host.invalid';
  try {
    const client = new VrchatApiClient(null, null);
    const cap = captureConsole();
    await assert.rejects(client._request('GET', '/auth/user'), /getaddrinfo|ENOTFOUND/);
    cap.restore();

    const s = client.getApiStats();
    assert.equal(s.failed, 1);
    assert.equal(s.timeouts, 0, 'DNS 失败不应计入超时');
    assert.match(cap.lines.warn.join('\n'), /GET \/auth\/user 请求失败: .+（耗时 \d+ms）/);
    const apiOps = ops.filter((o) => o.kind === 'api' && /请求失败/.test(o.message));
    assert.equal(apiOps.length, 1);
    assert.equal(apiOps[0].level, 'warn');
  } finally {
    process.env.VRC_MONITOR_API_BASE = prevBase;
  }
});

test('socket 超时：WARN 超时留痕 + ops_log + timeouts 计数（VRC_MONITOR_API_TIMEOUT_MS=300）', async () => {
  process.env.VRC_MONITOR_API_TIMEOUT_MS = '300';
  try {
    const client = new VrchatApiClient(null, null);
    const cap = captureConsole();
    await assert.rejects(client._request('GET', '/users/hang'), /超时/);
    cap.restore();

    const s = client.getApiStats();
    assert.equal(s.timeouts, 1);
    assert.equal(s.failed, 1);
    assert.match(cap.lines.warn.join('\n'), /GET \/users\/hang 超时（\d+ms）/);
    const apiOps = ops.filter((o) => o.kind === 'api' && /超时/.test(o.message));
    assert.equal(apiOps.length, 1);
    assert.equal(apiOps[0].level, 'warn');
  } finally {
    delete process.env.VRC_MONITOR_API_TIMEOUT_MS;
  }
});

test('VRC_MONITOR_LOG_API_SUCCESS=1：成功请求升 INFO；未设：仅 debug', async () => {
  const client = new VrchatApiClient(null, null);
  const cap1 = captureConsole();
  await client._request('GET', '/users/fast');
  cap1.restore();
  assert.equal(cap1.lines.info.length, 0, '未设开关时快成功不升 INFO');
  assert.match(cap1.lines.debug.join('\n'), /GET \/users\/fast → 200（\d+ms）/);

  process.env.VRC_MONITOR_LOG_API_SUCCESS = '1';
  try {
    const cap2 = captureConsole();
    await client._request('GET', '/users/fast');
    cap2.restore();
    assert.match(cap2.lines.info.join('\n'), /GET \/users\/fast → 200（\d+ms）/);
    assert.ok(!/GET \/users\/fast → 200/.test(cap2.lines.debug.join('\n')), '升 INFO 后不应重复 debug');
  } finally {
    delete process.env.VRC_MONITOR_LOG_API_SUCCESS;
  }
});

test('getApiStats：total/ok/failed/avgMs/p95Ms 形状与合理性', async () => {
  const client = new VrchatApiClient(null, null);
  await client._request('GET', '/users/fast');   // ~几 ms
  await client._request('GET', '/users/slow');   // ~2300ms
  const s = client.getApiStats();
  assert.equal(s.total, 2);
  assert.equal(s.ok, 2);
  assert.equal(typeof s.avgMs, 'number');
  assert.ok(s.avgMs >= 1000 && s.avgMs <= 1400, `avgMs 应落在快慢之间: ${s.avgMs}`);
  assert.ok(s.p95Ms >= 2000, `p95Ms 应覆盖慢请求: ${s.p95Ms}`);
});

test('normalizeApiPath：ID 段归一化 + 查询串剥离', () => {
  assert.equal(normalizeApiPath(`/users/${USR_ID}/boop`), '/users/:id/boop');
  assert.equal(normalizeApiPath('/worlds/wrld_abc123'), '/worlds/:id');
  assert.equal(normalizeApiPath('/users/usr_abc?n=10'), '/users/:id');
  assert.equal(normalizeApiPath('/auth/user'), '/auth/user');
});
