/**
 * test/dashboard-events-world-warmup.test.mjs —— 动态流「缺地图名」预热 + 404 标注 + 并发去重
 *
 * 2026-10-17 用户报「有些获取不到地图名」（自己的位置行只剩「好友＋ · JP · 12345」）：
 * 事件列 e.world_name 是写入时的快照，而自己的位置事件写入时那个世界往往还没进 world_cache
 * （只有「好友列表」「最近游玩」两条路会预热）⇒ 这些行永远没有名字。
 *
 * 修法：dashboard.events 出口对本次窗口里缺名字的世界按同一「限流 + 失败冷却」回源一次；
 * 回源异步 ⇒ **首帧恒空、下一次请求生效**；404/403 则标注 worldNameUnavailable（界面显示
 * 「404世界 + 完整 worldId」）；同一世界的并发回源共用一次请求（复审 💡2）。
 *
 * 自证（变异会红）：删掉预热块 ⇒ 用例 1/2 红；删掉 unavailable 传播 ⇒ 用例 3 红；
 * 去掉 in-flight 去重 ⇒ 用例 4 红；去掉 slice(0,5) ⇒ 用例 5 红。
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

const tmpDb = path.join(__dirname, 'test-events-world-warmup.sqlite3');
for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) { try { rmSync(f, { force: true }); } catch {} }

const services = new Map();
const serviceOwners = new Map();
const loader = { services, serviceOwners };
ctx.storage = new Storage();
await ctx.storage.init(tmpDb);
ctx.serverState = { started: null, authUser: null, needsOtp: false, needsTotp: false };
ctx.rateLimiter = { execute: async (fn) => fn() };
ctx.api = null; ctx.friendState = null; ctx.wsManager = null; ctx.pluginLoader = null; ctx.eventPipeline = null;
registerDashboardServices(loader, ctx);
after(() => { for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) { try { rmSync(f, { force: true }); } catch {} } });

const MISSING = 'wrld_missing-0000-0000-0000-000000000001';
const CACHED = 'wrld_cached-0000-0000-0000-000000000002';
const NOTFOUND = 'wrld_notfound-0000-0000-0000-000000000003';
const SLOW = 'wrld_slow-0000-0000-0000-000000000004';
const CAP = Array.from({ length: 6 }, (_, i) => 'wrld_cap' + i + '-0000-0000-0000-00000000000' + i);

ctx.storage.upsertWorld({ worldId: CACHED, name: '已有世界' });

const calls = [];
const behavior = new Map([[MISSING, 'ok'], [NOTFOUND, '404'], [SLOW, 'slow']]);
services.set('dashboard.world', async ({ worldId }) => {
  calls.push(worldId);
  const mode = behavior.get(worldId);
  if (mode === 'ok') { const name = '预热世界'; ctx.storage.upsertWorld({ worldId, name }); return { worldId, name }; }
  if (mode === '404') return { worldId, name: '', unavailable: true };
  if (mode === 'slow') { await new Promise((r) => setTimeout(r, 80)); return { worldId, name: '' }; }
  return { worldId, name: '' };
});

const t0 = Date.now();
const ins = (worldId, dt) => ctx.storage.insertEvent({
  type: 'user-location', userId: 'usr_me', displayName: '我',
  contentJson: { location: worldId ? worldId + ':12345~hidden(usr_me)' : 'traveling:traveling' },
  worldId, worldName: '',
  createdAt: new Date(t0 + dt).toISOString(), source: 'ws',
});
ins(MISSING, 0);
ins(CACHED, 1000);
ins('', 2000);

const waitFor = async (pred, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await new Promise((r) => setTimeout(r, 20)); }
  return pred();
};
const settle = () => new Promise((r) => setTimeout(r, 60));

test('缺名世界会被后台预热一次；已有缓存/无 world id 的行不重复请求', async () => {
  await services.get('dashboard.events')({ limit: 10 });
  assert.ok(await waitFor(() => calls.includes(MISSING)), '缺名的世界应被回源一次');
  assert.deepEqual(calls, [MISSING], '只请求真正缺名的世界：有缓存的不请求、traveling 行不请求');
});

test('预热落缓存后，同一历史行下一次请求即可显示世界名（首帧恒空是预期）', async () => {
  await waitFor(() => (ctx.storage.getWorldName(MISSING) || {}).name === '预热世界');
  const out = await services.get('dashboard.events')({ limit: 10 });
  const row = out.events.find((e) => e.worldId === MISSING);
  assert.ok(row, '缺名行本身要照常返回');
  assert.equal(row.worldName, '预热世界', '历史行的世界名应从 world_cache 取到');
  const cachedRow = out.events.find((e) => e.worldId === CACHED);
  assert.equal(cachedRow.worldName, '已有世界');
  assert.ok(!cachedRow.worldNameUnavailable, '有名字的世界不得被标成 404');
});

test('回源得到 404/403 ⇒ 该行被标 worldNameUnavailable（界面才有「404世界 + worldId」）', async () => {
  ins(NOTFOUND, 3000);
  await services.get('dashboard.events')({ limit: 10 });
  assert.ok(await waitFor(() => calls.includes(NOTFOUND)), '不可见世界也要尝试一次（否则不知道它是 404）');
  await settle();
  const out = await services.get('dashboard.events')({ limit: 10 });
  const row = out.events.find((e) => e.worldId === NOTFOUND);
  assert.ok(row, '404 世界的事件行要照常返回');
  assert.equal(row.worldNameUnavailable, true, '应被标记为世界名不可得');
  assert.equal(row.worldName, '', '名字确实拿不到，不得编造');
});

test('并发两帧只回源一次（in-flight 去重，复审 💡2）', async () => {
  ins(SLOW, 4000);
  const before = calls.filter((id) => id === SLOW).length;
  await Promise.all([
    services.get('dashboard.events')({ limit: 10 }),
    services.get('dashboard.events')({ limit: 10 }),
  ]);
  await waitFor(() => calls.filter((id) => id === SLOW).length > before);
  await settle();
  assert.equal(calls.filter((id) => id === SLOW).length - before, 1, '同一世界的并发回源必须只打一次 API');
});

test('每次请求最多回源 5 个世界（配额上界）', async () => {
  CAP.forEach((id, i) => ins(id, 5000 + i));
  await services.get('dashboard.events')({ limit: 20 });
  await waitFor(() => calls.filter((id) => CAP.includes(id)).length >= 5);
  await settle();
  assert.equal(calls.filter((id) => CAP.includes(id)).length, 5, '一次请求最多回源 5 个，剩下的留给后续请求');
});
