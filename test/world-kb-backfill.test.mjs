/**
 * test/world-kb-backfill.test.mjs — 兜底行元数据回填（ensureWorldKbInfo）回归测试
 *
 * 覆盖：本地 world_cache 命中零 API 回填 / 缓存缺失走 API 并写回缓存 /
 * API 失败不阻断主操作（仍写入 backlog 标记）/ 幂等不覆盖已有真实值 /
 * set_world_sleep 同路径 / 回填后 get_backlog 能读到世界名。
 * 自包含：临时 SQLite + stub api，不依赖真实 VRChat 凭据/网络。
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
const misc = await import(pathToFileURL(path.join(REPO, 'core', 'tools', 'misc.js')).href);

const tmpDb = path.join(__dirname, 'test-world-kb-backfill.sqlite3');
for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) { try { rmSync(f, { force: true }); } catch {} }

const storage = new Storage();
await storage.init(tmpDb);
ctx.storage = storage;
ctx.rateLimiter = { execute: (fn) => fn() };

after(() => { for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) { try { rmSync(f, { force: true }); } catch {} } });

const CACHED = 'wrld_kbtest-cached-0000-0000-000000000001';
const FETCHED = 'wrld_kbtest-fetched-0000-0000-000000000002';
const FETCHFAIL = 'wrld_kbtest-fetchfail-0000-0000-000000000003';
const PRESET = 'wrld_kbtest-preset-0000-0000-000000000004';
const SLEEPY = 'wrld_kbtest-sleepy-0000-0000-000000000005';

// 预置：缓存里有资料的图 / 已被真实值占位的图
storage.upsertWorld({ worldId: CACHED, name: '缓存里的图', authorId: 'usr_kbtest-author', authorName: '缓存作者', favorites: 42, tags: ['chill'] });
storage.upsertWorld({ worldId: SLEEPY, name: '睡觉图', authorId: 'usr_kbtest-author', authorName: '缓存作者' });

function apiStub() {
  const calls = [];
  return {
    calls,
    api: {
      _request: async (method, p) => {
        calls.push(`${method} ${p}`);
        if (p.endsWith(FETCHFAIL)) return { status: 404, data: {} };
        if (p.endsWith(FETCHED)) {
          return {
            status: 200,
            data: {
              id: FETCHED, name: '联网拉到的图', authorId: 'usr_kbtest-fetch-author', authorName: '联网作者',
              capacity: 32, favorites: 123, releaseStatus: 'public', tags: ['riddle'],
              description: '描述', imageUrl: 'https://example.invalid/x.png', created_at: '2026-09-09T00:00:00.000Z',
            },
          };
        }
        throw new Error(`stub api 未预期的调用: ${p}`);
      },
    },
  };
}

test('缓存命中：回填 name/author 且零 API 调用', async () => {
  const stub = apiStub();
  ctx.api = stub.api;
  const res = await misc.handleAddToBacklog({ worldId: CACHED, reason: '氛围图', priority: 1 });
  assert.equal(res.worldName, '缓存里的图', '返回值应带回填后的世界名');
  assert.equal(stub.calls.length, 0, '缓存命中不应调 API');
  const kb = storage.getWorldKbInfo(CACHED);
  assert.equal(kb.worldName, '缓存里的图');
  assert.equal(kb.authorName, '缓存作者');
  const row = storage.query(`SELECT backlog, backlog_reason, backlog_priority FROM world_kb WHERE world_id = $w`, { $w: CACHED })[0];
  assert.equal(row.backlog, 1);
  assert.equal(row.backlog_reason, '氛围图');
  assert.equal(row.backlog_priority, 1);
});

test('缓存缺失：走 API 一次并写回缓存 + world_kb（含 created_at）', async () => {
  const stub = apiStub();
  ctx.api = stub.api;
  const res = await misc.handleAddToBacklog({ worldId: FETCHED, reason: 'X 上看到', priority: 2 });
  assert.equal(res.worldName, '联网拉到的图');
  assert.deepEqual(stub.calls, [`GET /worlds/${FETCHED}`], '应恰好调一次 API');
  const kb = storage.getWorldKbInfo(FETCHED);
  assert.equal(kb.worldName, '联网拉到的图');
  assert.equal(kb.authorName, '联网作者');
  assert.equal(kb.createdAt, '2026-09-09T00:00:00.000Z', 'created_at 由 API 回填（推荐侧新图加权依赖它）');
  const cached = storage.getWorldName(FETCHED);
  assert.ok(cached, 'API 结果应写回 world_cache');
  assert.equal(cached.name, '联网拉到的图');
});

test('API 失败：主操作照常成功，不抛错、不产生脏值', async () => {
  const stub = apiStub();
  ctx.api = stub.api;
  const res = await misc.handleAddToBacklog({ worldId: FETCHFAIL, priority: 0 });
  assert.equal(res.inBacklog, true, '回填失败不应影响加入待逛');
  assert.equal(res.worldName, '', '拿不到资料时保持空串（不编造）');
  const kb = storage.getWorldKbInfo(FETCHFAIL);
  assert.equal(kb.worldName, '');
  const row = storage.query(`SELECT backlog, world_name FROM world_kb WHERE world_id = $w`, { $w: FETCHFAIL })[0];
  assert.equal(row.backlog, 1);
  assert.equal(row.world_name, '');
});

test('幂等：已有真实世界名不被缓存值覆盖', async () => {
  const stub = apiStub();
  ctx.api = stub.api;
  storage.run(`INSERT INTO world_kb (world_id, world_name, author_name, tags) VALUES ($w, '人工写死的名字', '人工作者', '[]')`, { $w: PRESET });
  storage.upsertWorld({ worldId: PRESET, name: '缓存里的另一个名字', authorName: '缓存作者' });
  await misc.handleAddToBacklog({ worldId: PRESET });
  const kb = storage.getWorldKbInfo(PRESET);
  assert.equal(kb.worldName, '人工写死的名字', 'world_name 非空时不得覆盖');
  assert.equal(kb.authorName, '人工作者', 'author_name 非空时不得覆盖');
});

test('set_world_sleep 走同一回填路径', async () => {
  const stub = apiStub();
  ctx.api = stub.api;
  const res = await misc.handleSetWorldSleep({ worldId: SLEEPY, isSleep: true });
  assert.equal(res.isSleep, true);
  assert.equal(res.worldName, '睡觉图');
  const row = storage.query(`SELECT sleep_ok, world_name FROM world_kb WHERE world_id = $w`, { $w: SLEEPY })[0];
  assert.equal(row.sleep_ok, 1);
  assert.equal(row.world_name, '睡觉图');
});

test('回填后 get_backlog 能读到世界名（回归：此前恒为空串）', async () => {
  const stub = apiStub();
  ctx.api = stub.api;
  const NEWONE = 'wrld_kbtest-backlog-0000-0000-000000000006';
  storage.upsertWorld({ worldId: NEWONE, name: '待逛的图', authorName: '待逛作者' });
  await misc.handleAddToBacklog({ worldId: NEWONE, reason: '待逛', priority: 1 });
  const bl = misc.handleGetBacklog({ status: 'pending', sortBy: 'priority', limit: 20 });
  const hit = bl.worlds.find((w) => w.worldId === NEWONE);
  assert.ok(hit, '新加的图应在 pending 列表里');
  assert.equal(hit.worldName, '待逛的图');
  assert.equal(hit.authorName, '待逛作者');
});
