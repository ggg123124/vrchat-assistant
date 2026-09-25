/**
 * test/location-dedup.test.mjs — 同世界同实例的重复 location 去重（2026-09-20）
 *
 * 背景：VRChat 在好友改 Avatar / 客户端重新同步时会重发 world+instance 完全相同的
 * friend-location。逐条落库后看板动态流呈现成「一直在换世界」（同世界名刷屏），
 * 用户报障即为此（好友在 Avatar 搜索图里挑模型）。
 * 覆盖：同实例窗口内去重 / 窗口外保留心跳 / 异实例与异世界不去重 / 开关关闭 /
 * 去重时好友状态（location、last_seen）仍刷新。
 * 自包含：临时 SQLite，不依赖网络/凭据。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..');
const { EventPipeline } = await import(pathToFileURL(path.join(REPO, 'core', 'event-pipeline.js')).href);
const { Storage } = await import(pathToFileURL(path.join(REPO, 'core', 'storage.js')).href);

const USER_ID = 'usr_dedup-0000-0000-0000-000000000001';
const NAME = '去重测试好友';
const INST_A = 'wrld_dedup1-1111-1111-1111-111111111111:instA';
const INST_B = 'wrld_dedup1-1111-1111-1111-111111111111:instB';
const WORLD2 = 'wrld_dedup2-2222-2222-2222-222222222222:instA';

const tmpDb = path.join(__dirname, 'test-location-dedup.sqlite3');
for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) { try { rmSync(f, { force: true }); } catch {} }
const storage = new Storage();
await storage.init(tmpDb);
const pipeline = new EventPipeline(storage, { get: () => null });

after(() => { for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) { try { rmSync(f, { force: true }); } catch {} } });

const loc = (location, worldId, receivedAt) => ({ type: 'friend-location', userId: USER_ID, displayName: NAME, location, worldId, receivedAt });
const countLoc = () => storage.query("SELECT COUNT(*) AS c FROM events WHERE type = 'friend-location' AND user_id = $uid", { $uid: USER_ID })[0].c;
const reset = () => { storage.run("DELETE FROM events WHERE user_id = $uid", { $uid: USER_ID }); delete process.env.VRC_MONITOR_DEDUP_SAME_INSTANCE_LOCATION; delete process.env.VRC_MONITOR_DEDUP_SAME_INSTANCE_WINDOW_SECONDS; };

test('默认开启：同世界同实例窗口内重复 → 只落一条', async () => {
  reset();
  await pipeline.process(loc(INST_A, 'wrld_dedup1-1111-1111-1111-111111111111', '2026-09-20T01:00:00.000Z'));
  await pipeline.process(loc(INST_A, 'wrld_dedup1-1111-1111-1111-111111111111', '2026-09-20T01:00:30.000Z'));
  await pipeline.process(loc(INST_A, 'wrld_dedup1-1111-1111-1111-111111111111', '2026-09-20T01:02:00.000Z'));
  assert.equal(countLoc(), 1, '同实例重复应被去重，只留首条');
});

test('窗口外（默认 300s）仍落一条心跳', async () => {
  reset();
  await pipeline.process(loc(INST_A, 'wrld_dedup1-1111-1111-1111-111111111111', '2026-09-20T02:00:00.000Z'));
  await pipeline.process(loc(INST_A, 'wrld_dedup1-1111-1111-1111-111111111111', '2026-09-20T02:10:00.000Z'));
  assert.equal(countLoc(), 2, '超出窗口应保留心跳事件');
});

test('去重时好友状态仍刷新（location / last_seen 跟到最新）', async () => {
  reset();
  await pipeline.process(loc(INST_A, 'wrld_dedup1-1111-1111-1111-111111111111', '2026-09-20T03:00:00.000Z'));
  await pipeline.process(loc(INST_A, 'wrld_dedup1-1111-1111-1111-111111111111', '2026-09-20T03:01:00.000Z'));
  const f = storage.getFriend(USER_ID);
  assert.equal(f.location, INST_A, '好友 location 应为最新值');
  assert.equal(f.last_seen, '2026-09-20T03:01:00.000Z', 'last_seen 应刷新（去重只挡事件，不挡状态）');
});

test('不同实例 / 不同世界：不去重', async () => {
  reset();
  await pipeline.process(loc(INST_A, 'wrld_dedup1-1111-1111-1111-111111111111', '2026-09-20T04:00:00.000Z'));
  await pipeline.process(loc(INST_B, 'wrld_dedup1-1111-1111-1111-111111111111', '2026-09-20T04:00:30.000Z'));
  await pipeline.process(loc(WORLD2, 'wrld_dedup2-2222-2222-2222-222222222222', '2026-09-20T04:01:00.000Z'));
  assert.equal(countLoc(), 3, '换实例/换世界不得被去重');
});

test('开关关闭（=0）：逐条落库，保持原始行为', async () => {
  reset();
  process.env.VRC_MONITOR_DEDUP_SAME_INSTANCE_LOCATION = '0';
  await pipeline.process(loc(INST_A, 'wrld_dedup1-1111-1111-1111-111111111111', '2026-09-20T05:00:00.000Z'));
  await pipeline.process(loc(INST_A, 'wrld_dedup1-1111-1111-1111-111111111111', '2026-09-20T05:00:30.000Z'));
  assert.equal(countLoc(), 2, '关闭开关应保留逐条事件');
  delete process.env.VRC_MONITOR_DEDUP_SAME_INSTANCE_LOCATION;
});

test('窗口可配：设为 10s 时 30s 后的同实例重复视为新事件', async () => {
  reset();
  process.env.VRC_MONITOR_DEDUP_SAME_INSTANCE_WINDOW_SECONDS = '10';
  await pipeline.process(loc(INST_A, 'wrld_dedup1-1111-1111-1111-111111111111', '2026-09-20T06:00:00.000Z'));
  await pipeline.process(loc(INST_A, 'wrld_dedup1-1111-1111-1111-111111111111', '2026-09-20T06:00:30.000Z'));
  assert.equal(countLoc(), 2, '超出自定义窗口应落事件');
  delete process.env.VRC_MONITOR_DEDUP_SAME_INSTANCE_WINDOW_SECONDS;
});

test('traveling 变体：traveling:traveling 与纯 traveling 同语义（都不参与同实例去重）', async () => {
  // 2026-09-25 #261 回归用例（审查 nixi-agent 建议）：
  //   上游「传送中」实际推的是 traveling:traveling；本 PR 把它对齐到既有「traveling 不参与同实例去重」语义。
  //   本用例只断言【两种形态等价】（不写死条数），在 base 上会红（base 变体被当成同实例去重）。
  reset();
  await pipeline.process(loc('traveling', '', '2026-09-20T07:00:00.000Z'));
  await pipeline.process(loc('traveling', '', '2026-09-20T07:00:30.000Z'));
  await pipeline.process(loc('traveling', '', '2026-09-20T07:01:00.000Z'));
  const pure = countLoc();
  reset();
  await pipeline.process(loc('traveling:traveling', '', '2026-09-20T08:00:00.000Z'));
  await pipeline.process(loc('traveling:traveling', '', '2026-09-20T08:00:30.000Z'));
  await pipeline.process(loc('traveling:traveling', '', '2026-09-20T08:01:00.000Z'));
  const variant = countLoc();
  assert.ok(pure >= 1, '前置：纯 traveling 至少落一条');
  assert.equal(variant, pure, 'traveling:traveling 应与纯 traveling 同语义（同为不参与同实例去重的特殊值）');
});
