/**
 * test/world-name-freshness.test.mjs — 世界名新鲜度回归（issue：世界改名后本服务永久显示旧名）
 *
 * 覆盖 2026-09-15 修复的两条行为：
 *   ① 名字优先级：`dashboard.friends` 的 worldName **以可刷新的 world_cache 为准**，
 *      事件快照（friends.world_name）仅作兜底——原实现反着来，世界作者改名后永远显示旧名；
 *   ② TTL 预热：在线好友所在世界的缓存**过期**（默认 7 天，VRC_MONITOR_WORLD_CACHE_TTL_DAYS 可配）
 *      时触发一次后台回源刷新；**未过期则不触发**（避免多余 API 调用）。
 *
 * 自包含：临时 SQLite + 造数据 + 桩掉 dashboard.world，不依赖真实凭据与网络。
 */
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..');

const { ctx } = await import(pathToFileURL(path.join(REPO, 'core', 'server-context.js')).href);
const { Storage } = await import(pathToFileURL(path.join(REPO, 'core', 'storage.js')).href);
const { registerDashboardServices } = await import(pathToFileURL(path.join(REPO, 'core', 'dashboard-services.js')).href);
const { SocialAnalytics } = await import(pathToFileURL(path.join(REPO, 'core', 'analytics', 'social.js')).href);

const tmpDb = path.join(__dirname, 'test-world-freshness.sqlite3');
for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) { try { rmSync(f, { force: true }); } catch {} }

const services = new Map();
const loader = { services, serviceOwners: new Map() };
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

after(() => { try { ctx.storage.db.close(); } catch {} for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) { try { rmSync(f, { force: true }); } catch {} } });

const WID = 'wrld_testnamefreshness00000';
function seedFriend({ worldName }) {
  ctx.storage.db.prepare(`DELETE FROM friends`).run();
  ctx.storage.db.prepare(`DELETE FROM world_cache`).run();
  ctx.storage.db.prepare(
    `INSERT INTO friends (user_id, display_name, is_online, location, world_id, world_name, trust_level, status)
     VALUES ('usr_a', 'Alice', 1, '${WID}:12345~region(jp)', '${WID}', ?, 'Known User', 'active')`
  ).run(worldName);
}
function seedCache({ name, updatedAtExpr }) {
  ctx.storage.db.prepare(`DELETE FROM world_cache`).run();
  ctx.storage.db.prepare(
    `INSERT INTO world_cache (world_id, name, author_name, description, image_url, tags, updated_at)
     VALUES ('${WID}', ?, '作者', '描述', '', '["tag"]', ${updatedAtExpr})`
  ).run(name);
}

test('名字优先级：缓存名（新）覆盖事件快照名（旧）——世界改名后展示层能跟上', async () => {
  seedFriend({ worldName: 'Idle Merchant 掛機商人（V0.1.4）' });
  seedCache({ name: 'Idle Merchant 掛機商人（V0.3.1）', updatedAtExpr: `datetime('now')` });
  const r = await loader.services.get('dashboard.friends')({});
  assert.equal(r.length, 1);
  assert.equal(r[0].worldName, 'Idle Merchant 掛機商人（V0.3.1）',
    '应优先用 world_cache 的名字（可刷新），而不是事件快照里的旧名');
});

test('兜底：缓存无名字时仍回落到事件快照名（不因换序而丢名）', async () => {
  seedFriend({ worldName: '仅有快照的名字（V0.1）' });
  seedCache({ name: '', updatedAtExpr: `datetime('now')` });
  const r = await loader.services.get('dashboard.friends')({});
  assert.equal(r[0].worldName, '仅有快照的名字（V0.1）');
});

test('TTL 预热：缓存过期（30 天）时后台触发一次 dashboard.world 回源', async () => {
  seedFriend({ worldName: '旧名' });
  seedCache({ name: '旧名（V0.1.4）', updatedAtExpr: `datetime('now', '-30 days')` });
  const calls = [];
  const real = loader.services.get('dashboard.world');
  loader.services.set('dashboard.world', async (a) => { calls.push(a); return real ? real(a) : {}; });
  try {
    await loader.services.get('dashboard.friends')({});
    await new Promise((r) => setTimeout(r, 30));   // 预热是 fire-and-forget
    assert.ok(calls.some((c) => c && c.worldId === WID), `过期缓存应触发回源，实际调用: ${JSON.stringify(calls)}`);
  } finally {
    loader.services.set('dashboard.world', real);
  }
});

test('TTL 预热：缓存新鲜（刚刚更新）时不触发回源（不做多余 API 调用）', async () => {
  seedFriend({ worldName: '新名' });
  seedCache({ name: '新名（V0.3.1）', updatedAtExpr: `datetime('now')` });
  const calls = [];
  const real = loader.services.get('dashboard.world');
  loader.services.set('dashboard.world', async (a) => { calls.push(a); return real ? real(a) : {}; });
  try {
    await loader.services.get('dashboard.friends')({});
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(calls.length, 0, `新鲜缓存不应触发回源，实际调用: ${JSON.stringify(calls)}`);
  } finally {
    loader.services.set('dashboard.world', real);
  }
});

function seedEvent({ worldId, worldName, createdAt }) {
  ctx.storage.db.prepare(
    `INSERT INTO events (user_id, display_name, type, world_id, world_name, content_json, created_at)
     VALUES ('usr_a', 'A', 'friend-location', ?, ?, '{}', ?)`
  ).run(worldId, worldName || '', createdAt);
}

test('_resolveWorldNames：最新事件空名 + 更早非空名 + 无缓存 → 恢复「最近的非空名」（审查 ⚠️1）', async () => {
  ctx.storage.db.prepare('DELETE FROM events').run();
  ctx.storage.db.prepare('DELETE FROM world_cache').run();
  seedEvent({ worldId: WID, worldName: '早期抓到（V1）', createdAt: '2026-09-01T00:00:00Z' });
  seedEvent({ worldId: WID, worldName: '', createdAt: '2026-09-10T00:00:00Z' });   // 最新事件空名
  const sa = new SocialAnalytics(ctx.storage);
  const out = sa._resolveWorldNames([WID]);
  assert.equal(out.get(WID), '早期抓到（V1）', '应回落到最近的**非空**事件名，而不是空串');
});

test('_resolveWorldNames：缓存有新名时优先缓存（即使事件最新名为空）', async () => {
  ctx.storage.db.prepare('DELETE FROM events').run();
  ctx.storage.db.prepare('DELETE FROM world_cache').run();
  seedEvent({ worldId: WID, worldName: '旧名（V1）', createdAt: '2026-09-01T00:00:00Z' });
  seedEvent({ worldId: WID, worldName: '', createdAt: '2026-09-10T00:00:00Z' });
  ctx.storage.db.prepare(
    `INSERT INTO world_cache (world_id, name, author_name, updated_at) VALUES (?, ?, '作者', datetime('now'))`
  ).run(WID, '新名（V0.3.1）');
  const sa = new SocialAnalytics(ctx.storage);
  assert.equal(sa._resolveWorldNames([WID]).get(WID), '新名（V0.3.1）');
});
