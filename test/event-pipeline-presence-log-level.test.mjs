/**
 * test/event-pipeline-presence-log-level.test.mjs — 上线/下线/换世界日志降级回归（交付 R4）
 *
 * 背景（PR #189 审查 💡2 + 生产实测）：剩余热路径里「换世界」占日志 26.0%、
 * 「上线+下线」合计 22.3%（此前头像变更 34.5% 已降 debug）——逐条 INFO 信噪比
 * 过低，三处统一降为 debug。DB 事件流 / SSE / 看板不受影响（events 表照常落库），
 * VRC_MONITOR_LOGGER_LEVEL=debug 可恢复。
 * 覆盖：三行 info 不收、debug 收；事件照旧落库；级别穿透（info 落盘不含、
 * debug 落盘含）；防误伤：bio/status 变更仍走 info。
 * 自包含：临时 SQLite + stub worldCache，不依赖网络/凭据。
 *
 * 说明：event-pipeline 的 logger 是 getLogger('event') 的闭包实例，无法替换导出
 * logger 方法拦截；按 event-pipeline-avatar-log-level.test.mjs 同款思路（临时
 * 替换 console.info/console.debug 收集行 + try/finally 还原）。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..');

const { initLogger } = await import(pathToFileURL(path.join(REPO, 'core', 'logger.js')).href);
const { EventPipeline } = await import(pathToFileURL(path.join(REPO, 'core', 'event-pipeline.js')).href);
const { Storage } = await import(pathToFileURL(path.join(REPO, 'core', 'storage.js')).href);

const USER_ID = 'usr_preslogtest-0000-0000-000000000001';
const NAME = '在线日志测试好友';

const tmpDb = path.join(__dirname, 'test-presence-log-level.sqlite3');
const logRoot = path.join(__dirname, 'presence-log-level-rundir');

for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) { try { rmSync(f, { force: true }); } catch {} }
rmSync(logRoot, { recursive: true, force: true });

const storage = new Storage();
await storage.init(tmpDb);
// 预置好友基线行（bio/status 有值才能触发 diff，供「防误伤」用例）
storage.upsertFriend({
  userId: USER_ID,
  displayName: NAME,
  bio: '旧简介',
  status: 'active',
  statusDescription: '旧状态',
});

const pipeline = new EventPipeline(storage, { get: () => null });

after(() => {
  for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) { try { rmSync(f, { force: true }); } catch {} }
  rmSync(logRoot, { recursive: true, force: true });
});

const makeOnline = () => ({
  type: 'friend-online',
  userId: USER_ID,
  displayName: NAME,
  location: 'private',
  worldId: '',
  receivedAt: '2026-09-13T09:00:00.000Z',
  platform: 'standalonewindows',
});

const makeOffline = () => ({
  type: 'friend-offline',
  userId: USER_ID,
  displayName: NAME,
  receivedAt: '2026-09-13T09:01:00.000Z',
});

const makeLocation = (worldId) => ({
  type: 'friend-location',
  userId: USER_ID,
  displayName: NAME,
  location: `${worldId}:123`,
  worldId,
  receivedAt: '2026-09-13T09:02:00.000Z',
});

const makeUpdate = ({ bio, status, statusDescription }) => ({
  type: 'friend-update',
  userId: USER_ID,
  displayName: NAME,
  receivedAt: '2026-09-13T09:03:00.000Z',
  content: {
    user: {
      currentAvatarImageUrl: '',
      bio: bio ?? '旧简介',
      status: status ?? 'active',
      statusDescription: statusDescription ?? '旧状态',
      userIcon: '',
      pronouns: 'they/them',
    },
  },
});

// 临时替换 console.info/console.debug 收集日志行（同 avatar 测试的 try/finally 还原模式）
async function captureConsole(fn) {
  const infoLines = [];
  const debugLines = [];
  const origInfo = console.info;
  const origDebug = console.debug;
  console.info = (m) => { infoLines.push(String(m)); };
  console.debug = (m) => { debugLines.push(String(m)); };
  try { await fn(); } finally { console.info = origInfo; console.debug = origDebug; }
  return { infoLines, debugLines };
}

test('上线/下线/换世界：info 收不到、debug 收到，且事件照旧落库', async () => {
  initLogger({ dir: path.join(logRoot, 'pres-debug'), format: 'text', level: 'debug' });
  const { infoLines, debugLines } = await captureConsole(async () => {
    await pipeline.process(makeOnline());
    await pipeline.process(makeOffline());
    await pipeline.process(makeLocation('wrld_ptest1'));
  });
  assert.ok(!infoLines.some((l) => l.includes('上线')),
    `info 不得收到上线行，实际 ${JSON.stringify(infoLines)}`);
  assert.ok(!infoLines.some((l) => l.includes('下线')),
    `info 不得收到下线行，实际 ${JSON.stringify(infoLines)}`);
  assert.ok(!infoLines.some((l) => l.includes('换世界')),
    `info 不得收到换世界行，实际 ${JSON.stringify(infoLines)}`);
  assert.ok(debugLines.some((l) => l.includes('上线')),
    `debug 应收到上线行，实际 ${JSON.stringify(debugLines)}`);
  assert.ok(debugLines.some((l) => l.includes('下线')),
    `debug 应收到下线行，实际 ${JSON.stringify(debugLines)}`);
  assert.ok(debugLines.some((l) => l.includes('换世界')),
    `debug 应收到换世界行，实际 ${JSON.stringify(debugLines)}`);
  // DB 事件流不受降级影响：三类事件照旧落库
  const rows = storage.getEventsByUser(USER_ID, { limit: 20 });
  assert.equal(rows.filter((r) => r.type === 'friend-online').length, 1, 'friend-online 应落库 1 条');
  assert.equal(rows.filter((r) => r.type === 'friend-offline').length, 1, 'friend-offline 应落库 1 条');
  assert.equal(rows.filter((r) => r.type === 'friend-location').length, 1, 'friend-location 应落库 1 条');
});

test('级别穿透：level=debug 落盘含三行，默认 info 落盘不含', async () => {
  const dirDebug = path.join(logRoot, 'level-debug');
  initLogger({ dir: dirDebug, format: 'text', level: 'debug' });
  await pipeline.process(makeOnline());
  await pipeline.process(makeOffline());
  await pipeline.process(makeLocation('wrld_ptest2'));
  const debugContent = readFileSync(path.join(dirDebug, 'monitor.log'), 'utf8');
  assert.ok(debugContent.includes('上线'), `debug 文件应含上线行，实际：${debugContent}`);
  assert.ok(debugContent.includes('下线'), `debug 文件应含下线行，实际：${debugContent}`);
  assert.ok(debugContent.includes('换世界'), `debug 文件应含换世界行，实际：${debugContent}`);
  assert.ok(/DEBUG\s+\[event\]/.test(debugContent), `应带 DEBUG [event] 前缀，实际：${debugContent}`);

  const dirInfo = path.join(logRoot, 'level-info');
  initLogger({ dir: dirInfo, format: 'text', level: 'info' });
  // 吞掉 console 输出避免污染测试报告；断言只依赖文件
  const origInfo = console.info;
  const origDebug = console.debug;
  console.info = () => {};
  console.debug = () => {};
  try {
    await pipeline.process(makeOnline());
    await pipeline.process(makeOffline());
    await pipeline.process(makeLocation('wrld_ptest3'));
    // 同一文件内混入 bio 变更（info 会写行）证明文件活跃，三行必须缺席
    await pipeline.process(makeUpdate({ bio: '又换简介' }));
  } finally { console.info = origInfo; console.debug = origDebug; }
  assert.ok(existsSync(path.join(dirInfo, 'monitor.log')), 'info 级别应已创建日志文件（bio 变更写行）');
  const infoContent = readFileSync(path.join(dirInfo, 'monitor.log'), 'utf8');
  assert.ok(infoContent.includes('bio变更'), `同文件应含 info 级 bio 行，实际：${infoContent}`);
  assert.ok(!infoContent.includes('上线'), `默认 info 级别文件不得含上线行，实际：${infoContent}`);
  assert.ok(!infoContent.includes('下线'), `默认 info 级别文件不得含下线行，实际：${infoContent}`);
  assert.ok(!infoContent.includes('换世界'), `默认 info 级别文件不得含换世界行，实际：${infoContent}`);
});

test('防误伤：bio/status 变更仍走 info（低频且有内容，不在降级范围）', async () => {
  initLogger({ dir: path.join(logRoot, 'pres-bio-status'), format: 'text', level: 'info' });
  const { infoLines, debugLines } = await captureConsole(
    () => pipeline.process(makeUpdate({ bio: '新简介', status: 'join me', statusDescription: '新状态' }))
  );
  assert.ok(infoLines.some((l) => l.includes('bio变更')), `bio 变更应走 info，实际 ${JSON.stringify(infoLines)}`);
  assert.ok(infoLines.some((l) => l.includes('状态变更')), `status 变更应走 info，实际 ${JSON.stringify(infoLines)}`);
  assert.equal(debugLines.length, 0, `info 级别下不应有 debug 行，实际 ${JSON.stringify(debugLines)}`);
});
