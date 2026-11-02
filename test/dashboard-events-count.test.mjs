/**
 * dashboard-events-count.test.mjs — 首屏 total 计数的等价性与索引友好性（2026-11-02）
 *
 * 背景：dashboard.events 的 total 原用
 *   NOT (type IN ('friend-update','user-update') AND COALESCE(json_extract(content_json,'$.type'),'') = '')
 * 这一条让 SQLite 对全表逐行反序列化 JSON（生产 6.2 万行实测 190-230ms），EXPLAIN 显示 SCAN e
 * 走不了索引。改成两条走 (type, content_subtype) 索引的 COUNT 相加后降到 9ms。
 *
 * **本用例调用真实的 dashboard.events 服务**（不是自己写一份等价 SQL）——否则护栏是假的：
 * 初版用例直接重放两条 SQL 做对比，把实现改回旧条件时依然全绿（实测），说明它钉的不是代码。
 *
 * 钉住四件事：
 *  ① 生成列 content_subtype 已建出；table_xinfo 可见、table_info 不可见（迁移判据依赖这一点）；
 *  ② 服务返回的 total 与「未拆分的原始条件」计数逐值相等；
 *  ③ 带类型筛选时（utCond 存在）仍与原始条件相等（此时不走拆分分支）；
 *  ④ 重新 init 同一库不报 duplicate column（迁移幂等）。
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

const tmpDb = path.join(__dirname, 'test-events-count.sqlite3');
for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) { try { rmSync(f, { force: true }); } catch {} }

const services = new Map();
const loader = { services, serviceOwners: new Map() };
ctx.storage = new Storage();
await ctx.storage.init(tmpDb);
ctx.serverState = { started: null, authUser: null, needsOtp: false, needsTotp: false };
ctx.rateLimiter = { execute: async (fn) => fn() };
ctx.api = null; ctx.friendState = null; ctx.wsManager = null; ctx.pluginLoader = null; ctx.eventPipeline = null;
registerDashboardServices(loader, ctx);
// 世界名回源一律返回空名（本用例只关心计数）
services.set('dashboard.world', async ({ worldId }) => ({ worldId, name: '' }));
after(() => { for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) { try { rmSync(f, { force: true }); } catch {} } });

const UID = 'usr_count-0000-0000-0000-000000000001';
let seq = 0;
const ins = (type, content) => {
  seq += 1;
  ctx.storage.insertEvent({
    type, userId: UID, displayName: '好友A',
    contentJson: { userId: UID, displayName: '好友A', ...content },
    worldId: '', worldName: '',
    createdAt: new Date(Date.UTC(2026, 10, 1, 0, 0, seq)).toISOString(),
    source: 'test',
  });
};
// 带子类型的 update（应计入）
ins('friend-update', { type: 'avatar' });
ins('friend-update', { type: 'status' });
ins('user-update', { type: 'bio' });
// 无子类型 / 空串子类型（应被基础条件排除）
ins('friend-update', {});
ins('user-update', {});
ins('friend-update', { type: '' });
// 非 update 类（应计入）
ins('friend-location', { location: 'wrld_x:1' });
ins('friend-online', {});
ins('notification', { type: 'friendRequest' });

const events = (args = {}) => services.get('dashboard.events')(args);
// 未拆分的原始条件（= 改动前实现），作为等价性基准
const ORIGINAL_COND = "NOT (e.type IN ('friend-update','user-update') AND COALESCE(json_extract(e.content_json,'$.type'),'') = '')";
const originalTotal = (extra = '') =>
  ctx.storage.query('SELECT COUNT(*) AS c FROM events e WHERE ' + ORIGINAL_COND + (extra ? ' AND ' + extra : ''))[0].c;

test('生成列已建出，且 table_info 看不到（迁移判据必须用 table_xinfo）', () => {
  const viaInfo = ctx.storage.query('PRAGMA table_info(events)').map((c) => c.name);
  const viaXInfo = ctx.storage.query('PRAGMA table_xinfo(events)').map((c) => c.name);
  assert.ok(viaXInfo.includes('content_subtype'), 'table_xinfo 应能看到生成列');
  assert.ok(!viaInfo.includes('content_subtype'), 'SQLite 的 table_info 不返回生成列');
});

test('服务返回的 total 与原始条件逐值相等（无筛选）', async () => {
  const r = await events({ limit: 50 });
  const expected = originalTotal();
  assert.equal(r.total, expected, '拆分计数必须与原始 NOT(AND) 条件相等');
  assert.equal(r.total, 6, '本夹具应计入 6 条（3 条带子类型的 update + 3 条非 update）');
  assert.equal(r.events.length, 6, '可见行数应与 total 一致（无子类型的原始副本不进行情流）');
});

test('带类型筛选时 total 仍与原始条件相等（此路径不拆分，避免丢条件）', async () => {
  const r = await events({ limit: 50, updateTypes: 'avatar' });
  const { updateTypeConds } = await import(pathToFileURL(path.join(REPO, 'core', 'dashboard-services.js')).href);
  const utCond = updateTypeConds('avatar');
  assert.ok(utCond, '筛选值应能映射成 SQL 条件');
  assert.equal(r.total, originalTotal(utCond), '有类型筛选时也应与原始条件相等');
});

test('生成列取值与 json_extract 逐行一致', () => {
  const rows = ctx.storage.query(
    "SELECT content_json, content_subtype, json_extract(content_json,'$.type') AS direct FROM events"
  );
  assert.ok(rows.length > 0);
  for (const r of rows) {
    const direct = r.direct === undefined ? null : r.direct;
    const gen = r.content_subtype === undefined ? null : r.content_subtype;
    assert.equal(gen, direct, '生成列 == json_extract：' + r.content_json);
  }
});

test('性能前提仍在：索引 idx_events_type_subtype 已建出（否则计数回落到全表扫描）', () => {
  const idx = ctx.storage.query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='events'").map((r) => r.name);
  assert.ok(idx.includes('idx_events_type_subtype'), '缺少 (type, content_subtype) 复合索引 ⇒ COUNT 会退回 190ms 级全表扫描');
  // 并确认它真的被用在拆分计数的第二条子查询上（EXPLAIN 看得到 SEARCH）
  const plan = ctx.storage.query(
    "EXPLAIN QUERY PLAN SELECT COUNT(*) FROM events WHERE type IN ('friend-update','user-update') AND content_subtype IS NOT NULL AND content_subtype <> ''"
  );
  const detail = plan.map((p) => p.detail).join(' | ');
  assert.match(detail, /USING (COVERING )?INDEX/, '应走索引，实际计划: ' + detail);
});

test('迁移幂等：同一库再次 init 不报 duplicate column', async () => {
  const s2 = new Storage();
  await s2.init(tmpDb);
  const cols = s2.query('PRAGMA table_xinfo(events)').map((c) => c.name);
  assert.equal(new Set(cols).size, cols.length, '不得有重复列');
});
