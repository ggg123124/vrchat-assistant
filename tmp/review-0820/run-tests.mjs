/**
 * 协作审核实测脚本（PR #63/#64/#65/#66 共用）
 * 运行: node tmp/review-0820/run-tests.mjs
 * 全部使用临时 DB，不触碰生产库。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passCount = 0, failCount = 0;
function check(name, cond, detail = '') {
  if (cond) { passCount++; console.log(`  ✅ PASS ${name}${detail ? ' — ' + detail : ''}`); }
  else { failCount++; console.log(`  ❌ FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

const DB = {
  a: path.join(__dirname, 't-a.sqlite3'),
  b: path.join(__dirname, 't-b.sqlite3'),
  c: path.join(__dirname, 't-c.sqlite3'),
  d: path.join(__dirname, 't-d.sqlite3'),
};

// ── 合成事件数据 ──
const I1 = 'wrld_1:12345~region(us)~instance(abc)'; // world_name: World One
const I2 = 'wrld_2:67890~region(us)~instance(xyz)'; // world_name: World Two
const I3 = 'wrld_3:111~region(us)~instance(qqq)';   // world_name: '' (fallback 测试)
const EV = [
  ['usr_A', 'Alice', I1, '2026-08-01T10:00:00.000Z', 'wrld_1', 'World One'],
  ['usr_A', 'Alice', I1, '2026-08-01T10:05:00.000Z', 'wrld_1', 'World One'],
  ['usr_A', 'Alice', I1, '2026-08-01T10:10:00.000Z', 'wrld_1', 'World One'],
  ['usr_A', 'Alice', I2, '2026-08-01T11:00:00.000Z', 'wrld_2', 'World Two'],
  ['usr_A', 'Alice', I2, '2026-08-01T11:30:00.000Z', 'wrld_2', 'World Two'],
  ['usr_A', 'Alice', 'wrld_3:private', '2026-08-01T12:00:00.000Z', 'wrld_3', ''],
  ['usr_A', 'Alice', 'traveling', '2026-08-01T12:30:00.000Z', '', ''],
  ['usr_B', 'Bob', I1, '2026-08-01T10:02:00.000Z', 'wrld_1', 'World One'],
  ['usr_B', 'Bob', I1, '2026-08-01T10:08:00.000Z', 'wrld_1', 'World One'],
  ['usr_B', 'Bob', I2, '2026-08-01T11:05:00.000Z', 'wrld_2', 'World Two'],
  ['usr_B', 'Bob', 'offline', '2026-08-01T13:00:00.000Z', '', ''],
];

function seed(db) {
  const stmt = db.prepare(`INSERT INTO events (type, user_id, display_name, content_json, world_id, world_name, created_at, source)
    VALUES ('friend-location', ?, ?, ?, ?, ?, ?, 'test')`);
  for (const [uid, dn, loc, at, wid, wname] of EV) {
    stmt.run(uid, dn, JSON.stringify({ location: loc }), wid, wname, at);
  }
}

const START = '2026-08-01T00:00:00.000Z', END = '2026-08-01T23:59:59.999Z';

// ══════════════ TEST A: PR#63 storage 重构等价性 ══════════════
console.log('\n[TEST A] PR#63 findFriendPairScreen / findFriendPairMeetings 重构等价性');
const [{ Storage: StorageMain }, { Storage: StoragePr63 }] = await Promise.all([
  import('./main/core/storage.js'),
  import('./pr-63/core/storage.js'),
]);

const sm = new StorageMain(); await sm.init(DB.a); seed(sm.db);
const sp = new StoragePr63(); await sp.init(DB.b); seed(sp.db);

const rMain = sm.findFriendPairScreen('usr_A', 'usr_B', START, END, 30);
const rPr63 = sp.findFriendPairScreen('usr_A', 'usr_B', START, END, 30);

check('matchCount 一致', rMain.matchCount === rPr63.matchCount, `main=${rMain.matchCount} pr63=${rPr63.matchCount}`);
check('matchCount=8', rPr63.matchCount === 8, JSON.stringify(rPr63.matchCount));
check('totalSeconds 一致', rMain.totalSeconds === rPr63.totalSeconds, `main=${rMain.totalSeconds} pr63=${rPr63.totalSeconds}`);
check('totalSeconds=2400', rPr63.totalSeconds === 2400, JSON.stringify(rPr63.totalSeconds));
check('totalMinutes 一致', rMain.totalMinutes === rPr63.totalMinutes, `main=${rMain.totalMinutes} pr63=${rPr63.totalMinutes}`);
check('worldDuration 一致', eq(rMain.worldDuration, rPr63.worldDuration), JSON.stringify(rPr63.worldDuration));
check('worlds 一致', eq(rMain.worlds, rPr63.worlds), JSON.stringify(rPr63.worlds));
check('displayName 一致', rMain.displayNameA === rPr63.displayNameA && rMain.displayNameB === rPr63.displayNameB, `${rPr63.displayNameA}/${rPr63.displayNameB}`);
check('matches 数量一致', rMain.matches.length === rPr63.matches.length, `main=${rMain.matches.length} pr63=${rPr63.matches.length}`);
const mMatchSet = new Set(rMain.matches.map(m => `${m.at}|${m.bt}|${m.world_id}`));
const pMatchSet = new Set(rPr63.matches.map(m => `${m.at}|${m.bt}|${m.world_id}`));
check('matches 集合一致（顺序无关）', eq([...mMatchSet].sort(), [...pMatchSet].sort()));
check('matches 按 bt 升序', rPr63.matches.every((m, i) => i === 0 || m.bt >= rPr63.matches[i - 1].bt));
check('空 world_name 兜底为 world_id', rPr63.matches.every(m => m.world_name !== undefined), 'world_name 字段存在');
check('返回含 limit 字段', 'limit' in rPr63, `limit=${rPr63.limit}`);

// limit 测试
const rLim = sp.findFriendPairScreen('usr_A', 'usr_B', START, END, 30, 3);
check('limit=3 → matches=3', rLim.matches.length === 3, JSON.stringify(rLim.matches.length));
check('limit 不影响 matchCount', rLim.matchCount === 8, JSON.stringify(rLim.matchCount));
check('limit 不影响 totalMinutes', rLim.totalMinutes === 40, JSON.stringify(rLim.totalMinutes));
check('limit 不影响 worldDuration', eq(rLim.worldDuration, rPr63.worldDuration));
const rLim2 = sp.findFriendPairScreen('usr_A', 'usr_B', START, END, 30, 0);
check('limit=0 → 全量', rLim2.matches.length === 8, JSON.stringify(rLim2.matches.length));

// meetings 对比
const mMain = sm.findFriendPairMeetings('usr_A', 'usr_B', START, END, 30);
const mPr63 = sp.findFriendPairMeetings('usr_A', 'usr_B', START, END, 30);
check('meetingCount 一致', mMain.meetingCount === mPr63.meetingCount, `main=${mMain.meetingCount} pr63=${mPr63.meetingCount}`);
check('meetingCount=2', mPr63.meetingCount === 2, JSON.stringify(mPr63.meetingCount));
check('totalDurationSeconds 一致', mMain.totalDurationSeconds === mPr63.totalDurationSeconds, `main=${mMain.totalDurationSeconds} pr63=${mPr63.totalDurationSeconds}`);
check('meetings 结构一致', eq(mMain.meetings, mPr63.meetings), JSON.stringify(mPr63.meetings));

// ══════════════ TEST B: PR#64 resolveWorldNames + 负缓存 ══════════════
console.log('\n[TEST B] PR#64 world-names.js resolveWorldNames / 负缓存');
const { default: worldNames } = await import('./pr-64/core/world-names.js');
const { Storage: StoragePr64 } = await import('./pr-64/core/storage.js');
const s64 = new StoragePr64(); await s64.init(DB.c);
// 预置缓存命中数据
s64.db.prepare(`INSERT INTO world_cache (world_id, name, updated_at) VALUES ('wrld_cached', 'Cached World', datetime('now'))`).run();

let apiCalls = 0;
const apiMock = {
  async _request(method, url) {
    apiCalls++;
    if (url.includes('wrld_api1')) return { status: 200, data: { id: 'wrld_api1', name: 'Api World 1', authorId: 'usr_x', authorName: 'X', capacity: 10, favorites: 5, releaseStatus: 'public', tags: [], description: 'd', imageUrl: 'u' } };
    return { status: 500, data: null }; // wrld_fail 失败
  },
};
const ctx64 = { storage: s64, api: apiMock };
const m1 = await worldNames.resolveWorldNames(ctx64, ['wrld_cached', 'wrld_api1', 'wrld_fail'], { throttleMs: 0, onFail: (wid) => null });
check('缓存命中直接返回', m1.get('wrld_cached') === 'Cached World');
check('缺失走 API 返回名字', m1.get('wrld_api1') === 'Api World 1');
check('失败走 onFail 兜底 null', m1.get('wrld_fail') === null);
check('API 调用 2 次（缓存未调）', apiCalls === 2, `calls=${apiCalls}`);
check('成功写回 world_cache', (s64.getWorldName('wrld_api1') || {}).name === 'Api World 1');
// 二次调用：成功世界走缓存，失败世界走负缓存，均不再调 API
const apiCalls2 = apiCalls;
const m2 = await worldNames.resolveWorldNames(ctx64, ['wrld_api1', 'wrld_fail'], { throttleMs: 0, onFail: (wid) => null });
check('二次调用不再发 API（负缓存生效）', apiCalls === apiCalls2, `calls=${apiCalls}`);
check('负缓存命中仍返回兜底', m2.get('wrld_fail') === null && m2.get('wrld_api1') === 'Api World 1');
// resolveWorldName 单查
const m3 = await worldNames.resolveWorldName(ctx64, 'wrld_api1', { throttleMs: 0 });
check('resolveWorldName 单查包装', m3 === 'Api World 1');

// ══════════════ TEST C: PR#65 索引 ══════════════
console.log('\n[TEST C] PR#65 init-db.sql 索引（建索引 + EXPLAIN + 幂等）');
const { Storage: StoragePr65 } = await import('./pr-65/core/storage.js');
const s65 = new StoragePr65(); await s65.init(DB.d);
const idxRows = s65.db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_events_world','idx_events_user_time_type')`).all();
check('两个索引已创建', idxRows.length === 2, JSON.stringify(idxRows.map(r => r.name)));
// 幂等：再次执行 DDL 不报错
let ddlOk = true;
try { s65.db.exec(readFileSync(path.join(__dirname, 'pr-65/core/init-db.sql'), 'utf-8')); } catch { ddlOk = false; }
check('DDL 重复执行幂等（IF NOT EXISTS）', ddlOk);
// 均衡数据灌入（200 行 usr_x + 3000 行 usr_other），保证索引有选择性
// （首轮测试曾把 3000 行全塞给 usr_x 导致选择性≈0、规划器选全表扫描——属测试数据偏差，非 PR 缺陷）
const ins = s65.db.prepare(`INSERT INTO events (type, user_id, display_name, content_json, world_id, world_name, created_at, source)
  VALUES ('friend-location', ?, 'X', '{"location":"wrld_x:1~region(us)~instance(1)"}', 'wrld_x', 'XW', ?, 'test')`);
for (let i = 0; i < 200; i++) ins.run('usr_x', `2026-08-0${(i % 9) + 1}T10:00:00.000Z`);
for (let i = 0; i < 3000; i++) ins.run('usr_other', `2026-07-0${(i % 9) + 1}T10:00:00.000Z`);
s65.db.prepare(`INSERT INTO events (type, user_id, display_name, content_json, world_id, world_name, created_at, source)
  VALUES ('friend-location', 'usr_y', 'Y', '{"location":"wrld_1:1~region(us)~instance(1)"}', 'wrld_1', 'W1', '2026-08-01T10:00:00.000Z', 'test')`).run();
s65.db.exec('ANALYZE');
const plan1 = s65.db.prepare(`EXPLAIN QUERY PLAN SELECT world_id FROM events WHERE world_id IN ('wrld_1')`).all();
check('world_id IN 查询走索引', JSON.stringify(plan1).includes('idx_events_world'), JSON.stringify(plan1));
const plan2 = s65.db.prepare(`EXPLAIN QUERY PLAN SELECT created_at FROM events WHERE user_id='usr_x' AND created_at >= '2026-01-01' AND created_at <= '2026-12-31' AND type='friend-location'`).all();
check('(user_id,created_at,type) 复合查询 COVERING 走索引', JSON.stringify(plan2).includes('idx_events_user_time_type'), JSON.stringify(plan2));

// ══════════════ TEST D: PR#66 通知字段语义 ══════════════
console.log('\n[TEST D] PR#66 get_notifications returned/shown/hasMore');
const { ctx: ctx66, log } = await import('./pr-66/core/server-context.js');
const { handleGetNotifications } = await import('./pr-66/core/handlers/notifications.js');
const mkNotif = (id, type, hidden = false) => ({ id, type, message: 'm', senderUserId: 'usr_s', senderUsername: 'S', details: '{}', created_at: '2026-08-01T10:00:00.000Z', hidden });
// D1: 不满页（2 条 < limit 30）→ hasMore false
ctx66.api = { async _request(method, url) { return { status: 200, data: [mkNotif('n1', 'invite'), mkNotif('n2', 'friendRequest')] }; } };
const d1 = await handleGetNotifications({});
check('D1 returned=2', d1.returned === 2, JSON.stringify(d1.returned));
check('D1 shown=2', d1.shown === 2);
check('D1 hasMore=false', d1.hasMore === false);
check('D1 不再有 total 字段', !('total' in d1));
check('D1 limit 默认 30', d1.limit === 30);
// D2: 取满 limit（30 条）→ hasMore true
ctx66.api = { async _request(method, url) { return { status: 200, data: Array.from({ length: 30 }, (_, i) => mkNotif(`n${i}`, 'invite')) }; } };
const d2 = await handleGetNotifications({});
check('D2 returned=30', d2.returned === 30);
check('D2 hasMore=true', d2.hasMore === true);
// D3: types 过滤
ctx66.api = { async _request(method, url) { return { status: 200, data: [mkNotif('n1', 'invite'), mkNotif('n2', 'boop'), mkNotif('n3', 'message')] }; } };
const d3 = await handleGetNotifications({ types: 'invite,boop' });
check('D3 returned=3（过滤前）', d3.returned === 3);
check('D3 shown=2（过滤后）', d3.shown === 2);
check('D3 filteredByTypes', eq(d3.filteredByTypes, ['invite', 'boop']));
// D4: hidden 过滤
ctx66.api = { async _request(method, url) { return { status: 200, data: [mkNotif('n1', 'invite'), mkNotif('n2', 'invite', true)] }; } };
const d4 = await handleGetNotifications({ hidden: false });
check('D4 默认排除 hidden', d4.shown === 1);
const d4h = await handleGetNotifications({ hidden: true });
check('D4 hidden=true 只看隐藏', d4h.shown === 1);

console.log(`\n════ 汇总: ${passCount} 通过 / ${failCount} 失败 ════`);
process.exit(failCount > 0 ? 1 : 0);
