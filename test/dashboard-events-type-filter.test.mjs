/**
 * test/dashboard-events-type-filter.test.mjs —— 动态流「类型筛选」服务端化：与前端 typeOf 等价
 *
 * 2026-10-07 用户报障「筛选简介加载慢 … signal timed out」：类型筛选原是纯客户端过滤 + 自动补齐，
 * 稀有类型（简介/模型/等级）会一路翻到库底（数百请求）⇒ 慢/超时。修法＝把可由 content_json.type
 * 判定的筛选值下沉到 SQL（core/dashboard-services.js 的 updateTypeConds / UI_UPDATE_TYPE_SQL）。
 *
 * 本用例是**防漂移护栏**：用同一批真实形态的样本事件，断言
 *   「SQL 选出的 id 集合」 === 「按前端 typeOf() 过滤出的 id 集合」
 * 两边任何一侧改了口径都会红（变异自检见文件名注释下方说明）。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..');
const { Storage } = await import(pathToFileURL(path.join(REPO, 'core', 'storage.js')).href);
const { updateTypeConds } = await import(pathToFileURL(path.join(REPO, 'core', 'dashboard-services.js')).href);
const { typeOf } = await import(pathToFileURL(path.join(REPO, 'plugins/official/web-dashboard/ui/src/constants/event-types.js')).href);

const tmpDb = path.join(__dirname, 'test-feed-type-filter.sqlite3');
for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) { try { rmSync(f, { force: true }); } catch {} }
const storage = new Storage();
await storage.init(tmpDb);
after(() => { for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) { try { rmSync(f, { force: true }); } catch {} } });

const UID = 'usr_filter-0000-0000-0000-000000000001';
const samples = [
  { name: 'friend-location', type: 'friend-location', content: {} },
  { name: 'user-location', type: 'user-location', content: {} },
  { name: 'friend-online', type: 'friend-online', content: {} },
  { name: 'friend-offline', type: 'friend-offline', content: {} },
  { name: 'friend-active(web)', type: 'friend-active', content: { platform: 'web' } },
  { name: 'fd avatar', type: 'friend-update', content: { type: 'avatar' } },
  { name: 'fd bio', type: 'friend-update', content: { type: 'bio', bio: 'x' } },
  { name: 'fd status', type: 'friend-update', content: { type: 'status' } },
  { name: 'fd user_icon', type: 'friend-update', content: { type: 'user_icon' } },
  { name: 'fd pronouns', type: 'friend-update', content: { type: 'pronouns' } },
  { name: 'fd trust_level', type: 'friend-update', content: { type: 'trust_level' } },
  { name: 'fd displayName', type: 'friend-update', content: { type: 'displayName' } },
  { name: 'ud avatar', type: 'user-update', content: { type: 'avatar' } },
  { name: 'ud bio', type: 'user-update', content: { type: 'bio' } },
  { name: 'ud status', type: 'user-update', content: { type: 'status' } },
  { name: 'ud user_icon', type: 'user-update', content: { type: 'user_icon' } },
  { name: 'ud trust_level', type: 'user-update', content: { type: 'trust_level' } },
  // 无子类型的 user-update 会被服务端基础条件（dashboard.events 的 NOT(... IS NULL)）整行排除，
  // 不会出现在动态流里 ⇒ 期望集合也要按同一条件排除它（否则是测试假象，不是口径分叉）。
  { name: 'ud legacy(no type)', type: 'user-update', content: {}, serviceExcluded: true },
  // 空串子类型：DTO 出口按「无子类型」丢弃（if (!ct.type) return null）⇒ SQL 基础条件也必须排除，
  // 否则 total 会比可见行数多（2026-10-07 评审 💡2）
  { name: 'fd empty-type', type: 'friend-update', content: { type: '' }, serviceExcluded: true },
  { name: 'notification', type: 'notification', content: { type: 'friendRequest' } },
  { name: 'notification-v2 group', type: 'notification-v2', content: { type: 'group.announcement' } },
  { name: 'friend-add', type: 'friend-add', content: {} },
  { name: 'friend-delete', type: 'friend-delete', content: {} },
  { name: 'unknown', type: 'unknown', content: {} },
];

const ids = new Map();
let seq = 0;
for (const s of samples) {
  seq += 1;
  storage.insertEvent({
    type: s.type,
    userId: UID,
    displayName: '样本' + seq,
    contentJson: { userId: UID, displayName: '样本' + seq, ...s.content },
    worldId: '',
    worldName: '',
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, seq)).toISOString(),
    source: 'test',
  });
  const row = storage.get('SELECT MAX(id) AS id FROM events');
  ids.set(s.name, row.id);
}

// 前端 DTO 形状：updateType = content.type（core/dashboard-services.js 的映射），type = 事件类型
const dtoOf = (s) => ({ type: s.type, updateType: s.content.type || '', platform: s.content.platform });
const idSet = (sql) => new Set(storage.query(sql).map((r) => r.id));
// 与 dashboard.events 的基础条件保持一致（无子类型的 friend-update/user-update 不进行情流）
const BASE_COND = "NOT (e.type IN ('friend-update','user-update') AND COALESCE(json_extract(e.content_json,'$.type'),'') = '')";
const sqlForTypes = (types) => {
  const cond = updateTypeConds(types);
  return 'SELECT id FROM events e WHERE ' + BASE_COND + (cond ? ' AND ' + cond : '');
};
const sampleInFeed = (s) => !s.serviceExcluded;

test('每个可服务端过滤的筛选值：SQL 结果 === 前端 typeOf 过滤结果', () => {
  const values = ['status', 'avatar', 'bio', 'trustLevel'];
  for (const v of values) {
    const expect = new Set();
    for (const s of samples) if (sampleInFeed(s) && typeOf(dtoOf(s)) === v) expect.add(ids.get(s.name));
    const got = idSet(sqlForTypes([v]));
    assert.deepEqual([...got].sort((a, b) => a - b), [...expect].sort((a, b) => a - b),
      `筛选值 ${v}：SQL 与 typeOf 必须一致（差集 SQL-only=${[...got].filter((i) => !expect.has(i)).length}, typeOf-only=${[...expect].filter((i) => !got.has(i)).length}）`);
    assert.ok(expect.size > 0, `样本集必须至少命中 1 条 ${v}（否则断言恒真）`);
  }
});

test('基础条件与 core/dashboard-services.js 的实现逐字一致（防两侧漂移）', async () => {
  const src = await readFile(new URL('../core/dashboard-services.js', import.meta.url), 'utf8');
  assert.ok(src.includes(BASE_COND), '测试镜像的基础条件必须与实现一致（改了实现就要同步这里）');
});

test('空串子类型与缺键同义：被基础条件排除（total 不得虚高）', () => {
  const got = idSet('SELECT id FROM events e WHERE ' + BASE_COND);
  assert.ok(!got.has(ids.get('fd empty-type')), 'content.type 为空串的行不应出现在动态流里');
  assert.ok(!got.has(ids.get('ud legacy(no type)')), '缺 content.type 的行同样不应出现');
});

test('多选 = OR（与前端 some() 语义一致）', () => {
  const expect = new Set();
  for (const s of samples) if (sampleInFeed(s) && ['bio', 'avatar'].includes(typeOf(dtoOf(s)))) expect.add(ids.get(s.name));
  const got = idSet(sqlForTypes(['bio', 'avatar']));
  assert.deepEqual([...got].sort((a, b) => a - b), [...expect].sort((a, b) => a - b));
});

test('未知/不支持的筛选值：返回空条件（不误过滤，交给前端客户端过滤）', () => {
  assert.equal(updateTypeConds(['location']), '');
  assert.equal(updateTypeConds(['nope']), '');
  assert.equal(updateTypeConds([]), '');
  assert.equal(updateTypeConds(null), '');
  assert.equal(updateTypeConds('bio'), `((e.type IN ('friend-update','user-update') AND json_extract(e.content_json,'$.type') = 'bio'))`);
});

test('原型链键（constructor/__proto__/toString…）不得当成已知筛选值（防畸形 SQL / HTTP 500）', () => {
  for (const k of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable']) {
    assert.equal(updateTypeConds([k]), '', k + ' 是 Object.prototype 成员，必须被忽略');
  }
  // 与合法值混选：只保留合法值（静默部分过滤，已在实现里注释说明）
  assert.equal(updateTypeConds(['constructor', 'bio']), updateTypeConds(['bio']));
});

test('重复值去重（同一条 OR 不进两次）', () => {
  const once = updateTypeConds(['bio']);
  assert.equal(updateTypeConds(['bio', 'bio']), once);
});
