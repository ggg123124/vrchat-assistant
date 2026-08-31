/**
 * test-dashboard-services.test.mjs — dashboard.* 核心数据服务无凭据测试（CI 可用）
 *
 * 覆盖 registerDashboardServices 注册的服务返回形状与关键字段：
 *   trackedNonFriends / trackedChanges（bio/status 前后值）/ stats / owner 归属
 * 自包含：临时 SQLite + 造数据，不依赖真实 VRChat 凭据。
 */
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const REPO = path.join(__dirname, '..');

const { ctx } = await import(pathToFileURL(path.join(REPO, 'core', 'server-context.js')).href);
const { Storage } = await import(pathToFileURL(path.join(REPO, 'core', 'storage.js')).href);
const { registerDashboardServices } = await import(pathToFileURL(path.join(REPO, 'core', 'dashboard-services.js')).href);

// ── 临时 DB + 运行时准备 ──
const tmpDb = path.join(__dirname, 'test-dash-services.sqlite3');
for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) { try { rmSync(f, { force: true }); } catch {} }

const services = new Map();
const serviceOwners = new Map();
const loader = { services, serviceOwners };

ctx.storage = new Storage();
await ctx.storage.init(tmpDb);
ctx.serverState = { started: null, authUser: null, needsOtp: false, needsTotp: false };
ctx.rateLimiter = { execute: async (fn) => fn() };
ctx.api = null;
ctx.friendState = null;
ctx.wsManager = null;
ctx.pluginLoader = null;
ctx.eventPipeline = null;

registerDashboardServices(loader, ctx);

// ── 造数据：一个 tracked 非好友 + 两条 poll 变化事件 ──
const UID = 'usr_test-0000-0000-0000-000000000001';
ctx.storage.run(
  `INSERT OR REPLACE INTO tracked_non_friends (user_id, display_name, avatar_image_url, added_at, last_refresh_at)
   VALUES ($u, $d, '', datetime('now'), datetime('now'))`,
  { $u: UID, $d: '测试用户' });
ctx.storage.insertEvent({
  type: 'friend-update', userId: UID, displayName: '测试用户',
  contentJson: { userId: UID, displayName: '测试用户', type: 'bio', bio: '新简介', previousBio: '旧简介' },
  worldId: '', worldName: '', createdAt: new Date().toISOString(), source: 'poll',
});
ctx.storage.insertEvent({
  type: 'friend-update', userId: UID, displayName: '测试用户',
  contentJson: { userId: UID, displayName: '测试用户', type: 'status', status: 'active', previousStatus: 'busy' },
  worldId: '', worldName: '', createdAt: new Date().toISOString(), source: 'poll',
});

test('dashboard.* 服务全部注册且 owner=core', () => {
  const names = [...services.keys()].filter((n) => n.startsWith('dashboard.'));
  assert.ok(names.length >= 19, `应有 >=19 个 dashboard.* 服务，实际 ${names.length}`);
  for (const n of names) assert.equal(serviceOwners.get(n), 'core');
});

test('dashboard.trackedNonFriends 返回 tracked 列表形状', () => {
  const r = services.get('dashboard.trackedNonFriends')({ limit: 10 });
  assert.ok(Array.isArray(r.tracked));
  assert.ok(r.tracked.some((x) => x.userId === UID && x.displayName === '测试用户'));
});

test('dashboard.trackedChanges 返回 bio/status 变化（含前后值）', () => {
  const r = services.get('dashboard.trackedChanges')({ userId: UID, limit: 10 });
  assert.ok(Array.isArray(r.changes));
  const types = r.changes.map((c) => c.type);
  assert.ok(types.includes('bio'));
  assert.ok(types.includes('status'));
  const bio = r.changes.find((c) => c.type === 'bio');
  assert.equal(bio.previousBio, '旧简介');
  assert.equal(bio.bio, '新简介');
  const status = r.changes.find((c) => c.type === 'status');
  assert.equal(status.previousStatus, 'busy');
  assert.equal(status.status, 'active');
});

test('dashboard.trackedChanges 返回 avatar 变化形状（前后缩略图字段）', () => {
  ctx.storage.insertEvent({
    type: 'friend-update', userId: UID, displayName: '测试用户',
    contentJson: { userId: UID, displayName: '测试用户', type: 'avatar', avatarImageUrl: 'https://api.vrchat.cloud/api/1/image/file_a/1/256', previousAvatarImageUrl: 'https://api.vrchat.cloud/api/1/image/file_b/1/256' },
    worldId: '', worldName: '', createdAt: new Date().toISOString(), source: 'poll',
  });
  const r = services.get('dashboard.trackedChanges')({ userId: UID, limit: 20 });
  const av = r.changes.find((c) => c.type === 'avatar');
  assert.ok(av);
  assert.ok(av.avatarImageUrl.includes('/image/'), '头像应缩略图化');
  assert.ok(av.previousAvatarImageUrl);
});

test('dashboard.trackedChanges 对非法 userId 返回空', () => {
  const r = services.get('dashboard.trackedChanges')({ userId: 'bad', limit: 10 });
  assert.deepEqual(r, { changes: [] });
});

test('dashboard.stats 返回聚合形状', () => {
  const r = services.get('dashboard.stats')({ days: 7 });
  assert.ok('onlineNow' in r);
  assert.ok(Number.isInteger(r.totalEvents));
  assert.ok(Array.isArray(r.byType));
  assert.ok(Array.isArray(r.byDay));
  assert.ok(Array.isArray(r.byHour));
});

test('dashboard.activityHeatmap 返回 24 格热图 + rangeDays（重复键 bug 回归）', () => {
  const r = services.get('dashboard.activityHeatmap')({ days: 7 });
  assert.equal(r.rangeDays, 7);
  assert.ok(Array.isArray(r.days));
  assert.equal(r.days.length, 7);
  assert.ok(r.days.every((row) => row.date && Array.isArray(row.hours) && row.hours.length === 24));
});

test('dashboard.recentWorlds 返回游玩分钟（会话切分口径）', () => {
  const W = 'wrld_test-0000-0000-0000-000000000001';
  const t0 = Date.now();
  const ev = (worldId, loc, dt) => ctx.storage.insertEvent({
    type: 'user-location', userId: 'usr_me', displayName: '我',
    contentJson: { location: loc }, worldId: worldId || '', worldName: worldId ? '测试世界' : '',
    createdAt: new Date(t0 + dt).toISOString(), source: 'ws',
  });
  // 会话 1：世界 A 10 分钟 → 离线
  ev(W, W + ':1', 0);
  ev(W, W + ':1', 10 * 60000);
  ev('', 'offline', 10 * 60000 + 1000);
  // 会话 2：世界 A 5 分钟（同世界后续停留）
  ev(W, W + ':2', 20 * 60000);
  ev(W, W + ':2', 25 * 60000);
  ev('', 'offline', 25 * 60000 + 1000);
  const r = services.get('dashboard.recentWorlds')({ limit: 10 });
  const w = r.find((x) => x.worldId === W);
  assert.ok(w, '世界应出现在足迹列表');
  assert.ok(w.minutes >= 15, `会话切分游玩分钟应 >=15，实际 ${w.minutes}`);
});

test('dashboard.gameSessions 会话切分（同世界延续/离线关段/跨世界切分）', () => {
  const W1 = 'wrld_test-0000-0000-0000-000000000002';
  const W2 = 'wrld_test-0000-0000-0000-000000000003';
  const t0 = Date.now();
  const ev = (worldId, loc, dt) => ctx.storage.insertEvent({
    type: 'user-location', userId: 'usr_me2', displayName: '我',
    contentJson: { location: loc }, worldId: worldId || '', worldName: worldId ? '世界' : '',
    createdAt: new Date(t0 + dt).toISOString(), source: 'ws',
  });
  // 世界1：10 分钟 → 同世界延续 5 分钟（不切分）→ 离线
  ev(W1, W1 + ':1', 0);
  ev(W1, W1 + ':1', 5 * 60000);
  ev(W1, W1 + ':1', 10 * 60000);
  ev('', 'offline', 10 * 60000 + 1000);
  // 世界2：切分新会话 3 分钟
  ev(W2, W2 + ':1', 20 * 60000);
  ev(W2, W2 + ':1', 23 * 60000);
  ev('', 'offline', 23 * 60000 + 1000);
  const r = services.get('dashboard.gameSessions')({ days: 7 });
  // 按本测试的世界过滤（DB 里可能有其他测试/数据的 user-location 事件；
  // 各测试用 now+偏移 造数据，绝对时间可能交错产生短会话碎片，故断言核心语义而非精确计数）
  const mySessions = r.sessions.filter((s) => s.worldId === W1 || s.worldId === W2);
  const myTotal = mySessions.reduce((a, s) => a + (s.durationMinutes || 0), 0);
  assert.ok(myTotal >= 13, `本测试世界总分钟应 >=13（W1 跨度 10 + W2 跨度 3），实际 ${myTotal}`);
  const w1s = mySessions.filter((s) => s.worldId === W1);
  const w2s = mySessions.filter((s) => s.worldId === W2);
  assert.ok(w1s.length >= 1 && Math.max(...w1s.map((s) => s.durationMinutes)) >= 10,
    `世界1应有 >=10 分钟会话（首尾跨度，同世界延续不切分），实际 ${JSON.stringify(w1s)}`);
  assert.ok(w2s.length >= 1 && Math.max(...w2s.map((s) => s.durationMinutes)) >= 3,
    `世界2应有 >=3 分钟会话，实际 ${JSON.stringify(w2s)}`);
});

test('dashboard.worldHistory 跨世界间隔不计入 + 末段封口', () => {
  const W = 'wrld_test-0000-0000-0000-000000000004';
  const B = 'wrld_test-0000-0000-0000-000000000005';
  // 过去基准（now-6 天）：worldHistory 无日期窗口，其他测试的事件都在 now+ 偏移（now..now+50min），
  // 用过去基准避免时间交错导致会话碎片
  const t0 = Date.now() - 6 * 86400000;
  const ev = (worldId, loc, dt) => ctx.storage.insertEvent({
    type: 'user-location', userId: 'usr_me3', displayName: '我',
    contentJson: { location: loc }, worldId: worldId || '', worldName: worldId ? '世界' : '',
    createdAt: new Date(t0 + dt).toISOString(), source: 'ws',
  });
  // W 段 1（10 分钟）→ 离线 → B 段（10 分钟，不应计入 W）→ 离线 → W 段 2（10 分钟）→ 离线
  ev(W, W + ':1', 0); ev(W, W + ':1', 10 * 60000); ev('', 'offline', 10 * 60000 + 1000);
  ev(B, B + ':1', 20 * 60000); ev(B, B + ':1', 30 * 60000); ev('', 'offline', 30 * 60000 + 1000);
  ev(W, W + ':2', 40 * 60000); ev(W, W + ':2', 50 * 60000); ev('', 'offline', 50 * 60000 + 1000);
  const r = services.get('dashboard.worldHistory')({ worldId: W });
  assert.equal(r.visits, 2, `W 应 2 次进入，实际 ${r.visits}`);
  assert.equal(r.minutes, 20, `W 分钟应 20（10+10，B 段不计入），实际 ${r.minutes}`);
  const rb = services.get('dashboard.worldHistory')({ worldId: B });
  assert.equal(rb.minutes, 10, 'B 段应计 10 分钟');
});

test('dashboard.trackedAdd 幂等 + 拒绝自己 + trackedRemove 标记', () => {
  const TID = 'usr_test-0000-0000-0000-0000000000a1';
  const selfId = services.get('dashboard.trackedNonFriends') ? null : null;
  const r1 = services.get('dashboard.trackedAdd')({ userId: TID, displayName: '测试追踪' });
  assert.equal(r1.ok, true);
  assert.equal(r1.added, true, '首次添加 added=true');
  const r2 = services.get('dashboard.trackedAdd')({ userId: TID, displayName: '测试追踪' });
  assert.equal(r2.added, false, '重复添加幂等 added=false');
  // 拒绝自己（事件表里有 user-location 的自己）
  const selfEv = ctx.storage.query(`SELECT user_id FROM events WHERE type='user-location' AND user_id LIKE 'usr_%' LIMIT 1`);
  if (selfEv.length) {
    assert.throws(() => services.get('dashboard.trackedAdd')({ userId: selfEv[0].user_id }), /不能追踪自己/);
  }
  // 移除（标记 removed_at）后列表不再显示
  const rm = services.get('dashboard.trackedRemove')({ userId: TID });
  assert.equal(rm.removed, true);
  const list = services.get('dashboard.trackedNonFriends')({ limit: 500 });
  assert.ok(!list.tracked.some((x) => x.userId === TID), '移除后不在列表');
});

test('dashboard.groupAnnouncementsAll 汇总跨群组公告', () => {
  const ev = (gid, gname, title, msg, dt) => ctx.storage.insertEvent({
    type: 'notification-v2', userId: 'usr_ann', displayName: '公告',
    contentJson: { id: 'not_' + gid, type: 'group.announcement', title: gname + ': ' + title, message: msg,
      data: { groupId: gid, groupName: gname, announcementTitle: title } },
    worldId: '', worldName: '', createdAt: new Date(Date.now() - dt).toISOString(), source: 'ws',
  });
  ev('grp_ann1', '群组A', '公告一', '内容一', 300000);
  ev('grp_ann2', '群组B', '公告二', '内容二', 600000);
  const r = services.get('dashboard.groupAnnouncementsAll')({ limit: 50 });
  assert.ok(r.total >= 2, '至少汇总 2 条公告');
  const a1 = r.announcements.find((a) => a.groupId === 'grp_ann1');
  assert.ok(a1, '群组A 公告在汇总中');
  assert.equal(a1.title, '公告一');
  assert.equal(a1.groupName, '群组A');
  assert.equal(a1.text, '内容一');
  // 降序（最新在前）
  const ts = r.announcements.map((a) => a.createdAt);
  const sorted = [...ts].sort().reverse();
  assert.deepEqual(ts, sorted, '公告按时间降序');
});

// ── 清理 ──
after(() => {
  for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) { try { rmSync(f, { force: true }); } catch {} }
});
