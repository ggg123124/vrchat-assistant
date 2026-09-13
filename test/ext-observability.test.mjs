/**
 * test/ext-observability.test.mjs — 外部服务调用留痕回归（core/ext-log.js + 真实调用点）
 *
 * 覆盖：
 *   - logExtFailure → WARN 恰好一行（含服务/操作/原因/耗时）+ ops_log(kind='ext',level='warn') 落库
 *   - logExtFallback → INFO 恰好一行 + ops_log(kind='ext',level='info') 落库
 *   - logExtSuccess 快 → 仅 debug（默认不写 INFO、不落 ops_log）；慢（>2000ms）→ 升 INFO「成功但慢」
 *   - getExtStats：failures/fallbacks/slow/lastFailure/topFailures 形状
 *   - 真实调用点 core/otp-fetcher.js：IMAP 拉取失败 → WARN 留痕，且**抛出与日志都不得含 IMAP 授权码**（脱敏）
 *
 * 自包含：临时 SQLite + 临时 logger 目录 + 临时脚本/凭据文件，不依赖网络与真实凭据。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..');

// 先初始化 logger（临时目录 + debug），避免惰性初始化把日志写进仓库 logs/
const { initLogger, setLevel } = await import(pathToFileURL(path.join(REPO, 'core', 'logger.js')).href);
const tmpLogDir = mkdtempSync(path.join(os.tmpdir(), 'vrc-ext-obs-'));
initLogger({ dir: tmpLogDir, level: 'debug' });
setLevel('debug');

const ext = await import(pathToFileURL(path.join(REPO, 'core', 'ext-log.js')).href);
const { setOpsLogSink } = await import(pathToFileURL(path.join(REPO, 'core', 'ops-log.js')).href);
const { Storage } = await import(pathToFileURL(path.join(REPO, 'core', 'storage.js')).href);
const { ctx } = await import(pathToFileURL(path.join(REPO, 'core', 'server-context.js')).href);

// 临时库 + 真实 ops_log 写入链路（与 start-monitor.js 的 sink 接线同形）
const tmpDb = path.join(__dirname, 'test-ext-observability.sqlite3');
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) { try { rmSync(f, { force: true }); } catch {} }
const storage = new Storage();
await storage.init(tmpDb);
setOpsLogSink((kind, level, message) => storage.insertOpsLog({ kind, level, message }));

after(() => {
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) { try { rmSync(f, { force: true }); } catch {} }
  try { rmSync(tmpLogDir, { recursive: true, force: true }); } catch {}
});

// console 出口收集（logger 的 writeToConsole 走 console.info/warn/debug/error）
function captureConsole() {
  const lines = { info: [], warn: [], debug: [], error: [] };
  const orig = { info: console.info, warn: console.warn, debug: console.debug, error: console.error };
  console.info = (m) => lines.info.push(String(m));
  console.warn = (m) => lines.warn.push(String(m));
  console.debug = (m) => lines.debug.push(String(m));
  console.error = (m) => lines.error.push(String(m));
  return {
    lines,
    restore() { Object.assign(console, orig); },
  };
}

function extRows() {
  return storage.getOpsLog({ limit: 100, kind: 'ext' });
}

test('logExtFailure：WARN 恰好一行 + ops_log(kind=ext,warn) 落库 + 统计递增', () => {
  ext.resetExtStats();
  const cap = captureConsole();
  let line;
  try {
    line = ext.logExtFailure('PlanetVRC', '抓取排行列表', new Error('HTTP 503'), { durationMs: 1234, attempt: 2 });
  } finally { cap.restore(); }

  assert.match(line, /^PlanetVRC 抓取排行列表 失败: HTTP 503（耗时 1234ms，第 2 次）$/);
  assert.equal(cap.lines.warn.length, 1, `WARN 应恰好一行，实际 ${JSON.stringify(cap.lines.warn)}`);
  assert.equal(cap.lines.info.length, 0, '失败分支不得写 INFO');
  assert.ok(cap.lines.warn[0].includes('PlanetVRC 抓取排行列表 失败'));

  const rows = extRows().filter((r) => r.message.includes('PlanetVRC 抓取排行列表 失败'));
  assert.equal(rows.length, 1, 'ops_log 应恰好一条 ext 失败记录');
  assert.equal(rows[0].kind, 'ext');
  assert.equal(rows[0].level, 'warn');

  const s = ext.getExtStats();
  assert.equal(s.failures, 1);
  assert.equal(s.lastFailure.service, 'PlanetVRC');
  assert.equal(s.topFailures[0].service, 'PlanetVRC');
  assert.equal(s.topFailures[0].failures, 1);
});

test('logExtFallback：INFO 恰好一行 + ops_log(kind=ext,info) 落库', () => {
  ext.resetExtStats();
  const cap = captureConsole();
  let line;
  try {
    line = ext.logExtFallback('BOOTH', '读取商品 123', '本地缓存命中，跳过远端抓取');
  } finally { cap.restore(); }
  assert.match(line, /^BOOTH 读取商品 123 降级: 本地缓存命中，跳过远端抓取$/);
  assert.equal(cap.lines.info.length, 1, `INFO 应恰好一行，实际 ${JSON.stringify(cap.lines.info)}`);
  assert.equal(cap.lines.warn.length, 0, '降级分支不得写 WARN');

  const rows = extRows().filter((r) => r.message.includes('BOOTH 读取商品 123 降级'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].level, 'info');
  assert.equal(ext.getExtStats().fallbacks, 1);
});

test('logExtSuccess：快成功只落 debug（无 INFO/无 ops_log）；慢调用升 INFO', () => {
  ext.resetExtStats();
  const capFast = captureConsole();
  try { ext.logExtSuccess('X', '@someone 三通道抓取', { durationMs: 120 }); } finally { capFast.restore(); }
  assert.equal(capFast.lines.info.length, 0, '快成功不得写 INFO');
  assert.equal(capFast.lines.debug.length, 1, '快成功应落一行 debug');
  assert.equal(extRows().filter((r) => r.message.includes('@someone')).length, 0, '成功不落 ops_log');

  const capSlow = captureConsole();
  try { ext.logExtSuccess('X', '@someone 三通道抓取', { durationMs: 2500 }); } finally { capSlow.restore(); }
  assert.equal(capSlow.lines.info.length, 1, '慢调用应升一行 INFO');
  assert.match(capSlow.lines.info[0], /成功但慢（2500ms > 2000ms）/);
  assert.equal(ext.getExtStats().slow, 1);
});

test('真实调用点 core/otp-fetcher.js：IMAP 失败 → WARN 留痕，且错误与日志都不含授权码（脱敏）', async () => {
  ext.resetExtStats();
  const AUTH_CODE = 'IMAP_SECRET_SHOULD_NOT_LEAK_12345';
  const workDir = mkdtempSync(path.join(os.tmpdir(), 'vrc-otp-probe-'));
  mkdirSync(path.join(workDir, 'scripts'), { recursive: true });
  writeFileSync(path.join(workDir, 'scripts', 'fetch-otp.py'), '# stub\n', 'utf8');
  const credFile = path.join(workDir, 'credentials.json');
  writeFileSync(credFile, JSON.stringify({ email: 'someone@example.com', imap_auth_code: AUTH_CODE }), 'utf8');

  const savedPaths = ctx.paths;
  const savedPython = process.env.VRC_MONITOR_PYTHON;
  ctx.paths = { __dirname: workDir, CRED_FILE: credFile };
  process.env.VRC_MONITOR_PYTHON = 'definitely-not-an-existing-binary-xyz';
  const cap = captureConsole();
  let thrown = null;
  try {
    const { fetchOtpFromEmail } = await import(pathToFileURL(path.join(REPO, 'core', 'otp-fetcher.js')).href);
    await fetchOtpFromEmail();
  } catch (e) {
    thrown = e;
  } finally {
    cap.restore();
    ctx.paths = savedPaths;
    if (savedPython === undefined) delete process.env.VRC_MONITOR_PYTHON;
    else process.env.VRC_MONITOR_PYTHON = savedPython;
    try { rmSync(workDir, { recursive: true, force: true }); } catch {}
  }

  assert.ok(thrown, 'IMAP 拉取失败必须抛出（不得静默返回空）');
  assert.match(String(thrown.message), /IMAP 拉取失败|IMAP 拉取超时/, `错误应为脱敏文案: ${thrown.message}`);
  assert.ok(!String(thrown.message).includes(AUTH_CODE), '抛出的错误不得含 IMAP 授权码');

  const allLines = [...cap.lines.warn, ...cap.lines.info, ...cap.lines.debug, ...cap.lines.error].join('\n');
  assert.match(allLines, /IMAP-OTP 拉取 VRChat 邮箱验证码 失败/, `应有 ext 失败留痕: ${allLines}`);
  assert.ok(!allLines.includes(AUTH_CODE), '日志（含子进程错误原文）不得含 IMAP 授权码');

  const rows = extRows().filter((r) => r.message.includes('IMAP-OTP'));
  assert.equal(rows.length, 1, 'ops_log 应恰好一条 IMAP-OTP 记录');
  assert.ok(!rows[0].message.includes(AUTH_CODE), 'ops_log 消息不得含授权码');
  assert.equal(ext.getExtStats().failures, 1);
});
