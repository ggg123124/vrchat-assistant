/**
 * test/dashboard-world-real-chain.test.mjs —— 真实 dashboard.world 链路（不 stub 服务本身）
 *
 * 复审（EMeowAGENT 💡）指出：warmup 用例把 dashboard.world 整体换成了 stub ⇒ 真实服务里
 * 「404 置标」「200 落库」两条分支零覆盖。本文件用**真实 dashboard.world + 假 ctx.api** 驱动：
 *   ① 404 → 下一次请求该行被标 worldNameUnavailable；
 *   ② 另一个世界 200 → 世界名落进 world_cache、该行显示名字且不被标。
 *
 * 注：「404 之后转 200 撤销标记」这条无法在用例内构造——失败冷却被钳到最小 60s（AGENTS.md 有述），
 * 生产上的撤销已用真实部署验证（同一批世界 8 分钟后重试恢复），此处不假装覆盖。
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

const tmpDb = path.join(__dirname, 'test-world-real-chain.sqlite3');
for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) { try { rmSync(f, { force: true }); } catch {} }

const services = new Map();
const serviceOwners = new Map();
const loader = { services, serviceOwners };
ctx.storage = new Storage();
await ctx.storage.init(tmpDb);
ctx.serverState = { started: null, authUser: null, needsOtp: false, needsTotp: false };
ctx.rateLimiter = { execute: async (fn) => fn() };
ctx.friendState = null; ctx.wsManager = null; ctx.pluginLoader = null; ctx.eventPipeline = null;

// 假 ctx.api：GET /worlds/{id} 按表返回（404 或 200）
const behavior = new Map();
const calls = [];
ctx.api = {
  _request: async (method, p) => {
    if (method === 'GET' && String(p).startsWith('/worlds/')) {
      const id = String(p).slice('/worlds/'.length);
      calls.push(id);
      const b = behavior.get(id) || { status: 404 };
      return { status: b.status, data: b.data || {} };
    }
    return { status: 404, data: {} };
  },
};
registerDashboardServices(loader, ctx);
after(() => { for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) { try { rmSync(f, { force: true }); } catch {} } });

const NOTFOUND = 'wrld_rc-404-0000-0000-0000-000000000001';
const FOUND = 'wrld_rc-200-0000-0000-0000-000000000002';
const ins = (id, dt) => ctx.storage.insertEvent({
  type: 'user-location', userId: 'usr_me', displayName: '我',
  contentJson: { location: id + ':12345~hidden(usr_me)' }, worldId: id, worldName: '',
  createdAt: new Date(Date.now() + dt).toISOString(), source: 'ws',
});
ins(NOTFOUND, 0);
ins(FOUND, 1000);
behavior.set(FOUND, { status: 200, data: { id: FOUND, name: '真实世界' } });

const waitFor = async (pred, ms = 2000) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await new Promise((r) => setTimeout(r, 20)); } return pred(); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('真实链路：404 世界被标「不可得」，200 世界落库并显示名字', async () => {
  const first = await services.get('dashboard.events')({ limit: 10 });
  assert.equal(first.events.length, 2);
  assert.ok(await waitFor(() => calls.includes(NOTFOUND) && calls.includes(FOUND)), '两个世界都应真的被回源过');
  assert.ok(await waitFor(() => (ctx.storage.getWorldName(FOUND) || {}).name === '真实世界'), '200 应落进 world_cache');
  await wait(80);

  const second = await services.get('dashboard.events')({ limit: 10 });
  const nf = second.events.find((e) => e.worldId === NOTFOUND);
  const fd = second.events.find((e) => e.worldId === FOUND);
  assert.equal(nf.worldNameUnavailable, true, '404 世界应被标 worldNameUnavailable');
  assert.equal(nf.worldName, '', '404 世界不得编造名字');
  assert.ok(!fd.worldNameUnavailable, '200 世界不得被标');
  assert.equal(fd.worldName, '真实世界', '200 世界应显示真实名字');
});
