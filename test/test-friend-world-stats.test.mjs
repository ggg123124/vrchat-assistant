/**
 * test-friend-world-stats.test.mjs — get_friend_world_stats 好友地图统计测试
 *
 * 覆盖:多好友多世界聚合(visitors/visits/lastSeen)、排序口径(visitors 主排序)、
 * 时间窗过滤、world_cache 资料补齐、非 wrld_ 事件排除。
 * 自包含:临时 SQLite + 造 friend-location 事件,不依赖真实 VRChat 凭据。
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
const eventsTools = await import(pathToFileURL(path.join(REPO, 'core', 'tools', 'events.js')).href);

const tmpDb = path.join(__dirname, 'test-friend-world-stats.sqlite3');
for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) { try { rmSync(f, { force: true }); } catch {} }

const storage = new Storage();
await storage.init(tmpDb);
ctx.storage = storage;

// ── 造数据:3 世界 × 2 好友,热度差异化 ──
// W_hot:2 个好友 6 次进入(最热);W_mid:1 好友 3 次;W_old:仅 40 天前(应被 30 天窗排除)
const now = Date.now();
const iso = (dt) => new Date(now + dt).toISOString();
const F1 = 'usr_stats-f1-0000-0000-0000-000000000001';
const F2 = 'usr_stats-f2-0000-0000-0000-000000000002';
const W_HOT = 'wrld_stats-hot-0000-0000-0000-000000000001';
const W_MID = 'wrld_stats-mid-0000-0000-0000-000000000002';
const W_OLD = 'wrld_stats-old-0000-0000-0000-000000000003';
const W_LOCAL = 'local:xxxx-test';  // 非 wrld_ 前缀应排除

const loc = (worldId, worldName, userId, dt) => storage.insertEvent({
  type: 'friend-location', userId, displayName: userId === F1 ? '好友一' : '好友二',
  contentJson: { location: worldId + ':1', worldName }, worldId, worldName,
  createdAt: iso(dt), source: 'ws',
});

// W_HOT:F1 ×3 + F2 ×3
for (const dt of [0, -60000, -120000]) { loc(W_HOT, '热门世界', F1, dt); loc(W_HOT, '热门世界', F2, dt); }
// W_MID:F2 ×3(名字留空,world_cache 补)
for (const dt of [-300000, -360000, -420000]) loc(W_MID, '', F2, dt);
// W_OLD:40 天前,30 天窗外
loc(W_OLD, '旧世界', F1, -40 * 86400000);
// local 房间(非 wrld_)
storage.insertEvent({
  type: 'friend-location', userId: F1, displayName: '好友一',
  contentJson: { location: W_LOCAL }, worldId: W_LOCAL, worldName: '本地测试',
  createdAt: iso(0), source: 'ws',
});

// world_cache 补资料:W_HOT 有完整资料(名称/图/作者),验证 join;W_MID 无(事件名兜底)
storage.upsertWorld({ worldId: W_HOT, name: '热门世界(缓存名)', imageUrl: 'https://api.vrchat.cloud/api/1/image/file_x/1/256', authorName: '作者甲' });

test('get_friend_world_stats 聚合/排序/窗口/资料补齐', () => {
  const r = eventsTools.handleGetFriendWorldStats({ days: 30, limit: 10 });
  assert.equal(r.windowDays, 30);
  assert.equal(r.count, 2, '30 天窗口内应有 2 个世界(旧世界/local 排除)');
  const hot = r.stats.find((s) => s.worldId === W_HOT);
  const mid = r.stats.find((s) => s.worldId === W_MID);
  assert.ok(hot && mid, '两个世界都在统计中');

  assert.equal(hot.visitors, 2, 'W_HOT visitors=2(两个好友)');
  assert.equal(hot.visits, 6, 'W_HOT visits=6');
  assert.equal(hot.worldName, '热门世界(缓存名)', 'world_cache 名称优先');
  assert.ok(hot.imageUrl.includes('file_x'), 'imageUrl 来自 world_cache');
  assert.equal(hot.authorName, '作者甲', 'authorName 来自 world_cache');
  assert.deepEqual(hot.friends.sort(), ['好友一', '好友二'], 'friends 样本含两个好友名');

  assert.equal(mid.visitors, 1);
  assert.equal(mid.visits, 3);
  assert.equal(mid.worldName, '', '无 world_cache 且事件名为空时留空');

  // 排序:visitors 主排序 → W_HOT 在 W_MID 前
  assert.equal(r.stats[0].worldId, W_HOT, 'visitors 主排序,W_HOT 第一');
});

test('get_friend_world_stats 时间窗过滤(days 生效)与 limit', () => {
  // 90 天窗:W_OLD 也应进来,共 3 个世界;limit=1 只返回最热
  const r90 = eventsTools.handleGetFriendWorldStats({ days: 90, limit: 100 });
  assert.equal(r90.windowDays, 90);
  assert.equal(r90.count, 3, '90 天窗应含 W_OLD,共 3 个世界');
  const old = r90.stats.find((s) => s.worldId === W_OLD);
  assert.ok(old && old.visits === 1, 'W_OLD 在 90 天窗内出现');

  const rLim = eventsTools.handleGetFriendWorldStats({ days: 90, limit: 1 });
  assert.equal(rLim.count, 1, 'limit=1 只返回 1 条');
  assert.equal(rLim.stats[0].worldId, W_HOT, 'limit 下保留最热的 W_HOT');
});

after(() => {
  for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) { try { rmSync(f, { force: true }); } catch {} }
});
