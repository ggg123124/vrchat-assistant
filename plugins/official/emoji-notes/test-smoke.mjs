#!/usr/bin/env node
/**
 * test-smoke.mjs — emoji-notes 插件无凭据冒烟测试
 * =====================================================================
 * 构造 fake api（db = 真实临时 SQLite 的 table 包装，registerTool 收集 def，log noop）
 * → register(api) → 断言三工具注册 → set/get/resolve 断言矩阵（STT 噪声全覆盖）→ 清理。
 *
 * 用法：node test-smoke.mjs（在 plugins/official/emoji-notes/ 下运行）
 * 退出码：0=PASS / 1=FAIL
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

let REPO_ROOT = __dirname;
while (!existsSync(path.join(REPO_ROOT, 'core', 'plugin-loader.js'))) {
  const parent = path.dirname(REPO_ROOT);
  if (parent === REPO_ROOT) {
    console.error('无法定位仓库根');
    process.exitCode = 2;
    throw new Error('无法定位仓库根');
  }
  REPO_ROOT = parent;
}

let passCount = 0;
let failCount = 0;
const ok = (msg) => { passCount++; console.log(`[OK] ${msg}`); };
const bad = (msg) => { failCount++; console.error(`[FAIL] ${msg}`); };
const check = (cond, msg) => (cond ? ok(msg) : bad(msg));

// ── 临时库 + fake api（复用核心 buildPluginApi 的真实 rewrite 逻辑）────────────
const tmpDb = path.join(os.tmpdir(), `emoji-notes-smoke-${Date.now()}.sqlite3`);
for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) { try { rmSync(f, { force: true }); } catch {} }
const sqlite = new Database(tmpDb);
sqlite.pragma('journal_mode = WAL');

const normParams = (p = {}) => {
  const out = {};
  for (const [k, v] of Object.entries(p)) out[k.replace(/^\$/, '')] = v;
  return out;
};
const storage = {
  run: (sql, p) => sqlite.prepare(sql).run(normParams(p)),
  get: (sql, p) => sqlite.prepare(sql).get(normParams(p)),
  query: (sql, p) => sqlite.prepare(sql).all(normParams(p)),
  exec: (sql) => sqlite.exec(sql),
};

const { buildPluginApi } = await import(pathToFileURL(path.join(REPO_ROOT, 'core', 'plugin-api.js')).href);
const toolDefs = [];
const registry = {
  registerPluginTool(def) { toolDefs.push(def); },
  hasTool() { return false; },
  dispatch() { throw new Error('not implemented'); },
};
const api = buildPluginApi('emoji-notes', {
  registry,
  ctx: { storage, api: null, rateLimiter: null, httpRoutes: new Map() },
  services: new Map(),
  serviceOwners: new Map(),
  log: () => {},
});

// 应用 schema.sql（复刻 loader 的裸表名重写）
const schemaSql = readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
const rewritten = schemaSql.replace(
  /((?:CREATE TABLE|ALTER TABLE)\s+(?:IF\s+NOT\s+EXISTS\s+)?)([a-zA-Z0-9_]+)/gi,
  (m, pre, name) => (name.startsWith('plg_') ? m : `${pre}"plg_emoji-notes_${name}"`)
);
sqlite.exec(rewritten);

const { default: register } = await import(pathToFileURL(path.join(__dirname, 'index.js')).href);
const { default: builtinEmojis } = await import(pathToFileURL(path.join(__dirname, 'builtin-emojis.js')).href);
const { normalizeHanzi, toPinyinStr, levenshtein } = await import(pathToFileURL(path.join(__dirname, 'resolve.js')).href);

// ── 纯函数自检 ──
check(normalizeHanzi('ＦＯＸ\u3000１２３\u200b') === 'fox123', `normalizeHanzi 全角/零宽/空白归一化（实际 "${normalizeHanzi('ＦＯＸ\u3000１２３\u200b')}"）`);
check(toPinyinStr('狐狸检查PR') === 'hulijianchapr', `toPinyinStr 连写无分隔（实际 "${toPinyinStr('狐狸检查PR')}"）`);
check(levenshtein('kitten', 'sitting') === 3, `levenshtein("kitten","sitting")=3（实际 ${levenshtein('kitten', 'sitting')}）`);
check(builtinEmojis.length === 65, `内置清单 65 项（实际 ${builtinEmojis.length}）`);
check(builtinEmojis.find((e) => e.emojiId === 'default_hand_wave')?.nameEn === 'Hand Wave', '内置 emojiId 推导规则与 media 一致（default_hand_wave）');
check(builtinEmojis.find((e) => e.emojiId === "default_can't_see")?.nameEn === "Can't see", "内置 emojiId 含撇号条目（default_can't_see）");

// ── register ──
const dispose = register(api);
check(typeof dispose === 'function', 'register 返回 dispose() 函数');

// ── 断言 1：三工具注册 ──
const names = toolDefs.map((d) => d.name);
check(names.includes('set_emoji_note'), '工具 set_emoji_note 已注册');
check(names.includes('get_emoji_notes'), '工具 get_emoji_notes 已注册');
check(names.includes('resolve_emoji'), '工具 resolve_emoji 已注册');
const handler = (n) => toolDefs.find((d) => d.name === n).handler;

// ── 断言 2：索引已建（幂等）──
const idxRow = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_notes_kind'`).get();
check(!!idxRow, 'idx_notes_kind 索引已建');

// ── 断言 3：歧义用例（两条相近别名，「狐狸」必须不猜）──
await handler('set_emoji_note')({ emojiId: 'file_test_a', note: '狐狸在检查PR的图', aliases: ['狐狸检查PR'] });
await handler('set_emoji_note')({ emojiId: 'file_test_b', note: '狐狸吃鸡的图', aliases: ['狐狸吃鸡'] });

const rAmb = await handler('resolve_emoji')({ query: '狐狸' });
check(rAmb.matched === false && rAmb.needsClarification === true, `resolve("狐狸") 歧义不猜（needsClarification=${rAmb.needsClarification}）`);
check(rAmb.emojiId === null, '歧义时 emojiId 为 null');
check(rAmb.candidates.length >= 2, `resolve("狐狸") 返回 ≥2 候选（实际 ${rAmb.candidates.length}）`);
check(rAmb.candidates.every((c) => c.confidence < 0.85), `候选置信度均 < THRESHOLD（实际 ${rAmb.candidates.map((c) => c.confidence.toFixed(3)).join(', ')}）`);

const rExactA = await handler('resolve_emoji')({ query: '狐狸检查PR' });
check(
  rExactA.matched === true && rExactA.emojiId === 'file_test_a' && rExactA.confidence === 1.0 && rExactA.matchedBy === 'alias',
  `resolve("狐狸检查PR") 别名精确命中 file_test_a（confidence=${rExactA.confidence}, matchedBy=${rExactA.matchedBy}）`
);

// ── 断言 4：note+aliases 全空 → 软删除；get 过滤 ──
await handler('set_emoji_note')({ emojiId: 'file_test_a', note: '', aliases: [] });
await handler('set_emoji_note')({ emojiId: 'file_test_b' });
const active = await handler('get_emoji_notes')({});
check(active.length === 0, `软删除后有效行数 0（实际 ${active.length}）`);
const withDeleted = await handler('get_emoji_notes')({ includeDeleted: true });
check(withDeleted.length === 2, `includeDeleted=true 返回 2 行（实际 ${withDeleted.length}）`);
check(withDeleted.every((r) => r.deleted === 1), '软删除行 deleted=1');

// ── 断言 5：主用例 set/get ──
const foxSet = await handler('set_emoji_note')({
  emojiId: 'file_test_fox',
  note: '狐狸检查 PR',
  aliases: ['狐狸检查PR', '审核PR', '狐狸'],
  tags: ['fox', '审核'],
  category: '梗图',
});
check(foxSet.emojiId === 'file_test_fox' && foxSet.kind === 'custom' && foxSet.deleted === 0, 'set_emoji_note 返回落库完整记录（kind=custom）');
check(Array.isArray(foxSet.aliases) && foxSet.aliases.length === 3, '落库记录 aliases 已解析为数组');

const foxGet = await handler('get_emoji_notes')({ emojiId: 'file_test_fox' });
check(foxGet.length === 1 && foxGet[0].category === '梗图' && foxGet[0].note === '狐狸检查 PR', 'get_emoji_notes 按 emojiId 返回完整记录');
const customOnly = await handler('get_emoji_notes')({ kind: 'custom' });
check(customOnly.length === 1 && customOnly[0].emojiId === 'file_test_fox', 'kind=custom 过滤正确');
const builtinOnly = await handler('get_emoji_notes')({ kind: 'builtin' });
check(builtinOnly.length === 0, 'kind=builtin 无落库行（内置未备注时）');

// ── 断言 6：防御上限校验 ──
let threw = false;
try { await handler('set_emoji_note')({ emojiId: 'file_bad', note: 'x'.repeat(2001) }); } catch { threw = true; }
check(threw, 'note 超 2000 字符被拒绝');
threw = false;
try { await handler('set_emoji_note')({ emojiId: 'file_bad', aliases: Array.from({ length: 51 }, (_, i) => `a${i}`) }); } catch { threw = true; }
check(threw, 'aliases 超 50 个被拒绝');

// ── 断言 7：resolve 断言矩阵（STT 噪声全覆盖）──
const matrix = [
  { q: '狐狸检查PR', want: 'file_test_fox', by: 'alias', conf: 1.0, matched: true },
  { q: '审核PR', want: 'file_test_fox', by: 'alias', conf: 1.0, matched: true },
  { q: '弧狸检查PR', want: 'file_test_fox', by: 'pinyin', conf: 0.95, matched: true },
  { q: '胡莉检查PR', want: 'file_test_fox', by: 'pinyin', conf: 0.95, matched: true },
  { q: 'laugh', want: 'default_laugh', by: 'builtin_en', conf: 1.0, matched: true },
  { q: '大笑', want: 'default_laugh', by: 'builtin_zh', conf: 1.0, matched: true },
];
for (const c of matrix) {
  const r = await handler('resolve_emoji')({ query: c.q });
  check(
    r.matched === c.matched && r.emojiId === c.want && r.matchedBy === c.by && r.confidence === c.conf,
    `resolve("${c.q}") -> ${c.want}（${c.by}, ${c.conf}）实际 ${r.emojiId}/${r.matchedBy}/${r.confidence}`
  );
}

const rDrop = await handler('resolve_emoji')({ query: '狐狸检PR' });
check(rDrop.matched === false, `resolve("狐狸检PR") 丢字不给唯一命中（matched=${rDrop.matched}）`);
check(
  rDrop.candidates.length >= 1 &&
    rDrop.candidates[0].emojiId === 'file_test_fox' &&
    ['token_overlap', 'fuzzy_pinyin'].includes(rDrop.candidates[0].matchedBy) &&
    rDrop.candidates[0].confidence < 0.85,
  `丢字候选 top1=file_test_fox 模糊信号（实际 ${rDrop.candidates[0]?.emojiId}/${rDrop.candidates[0]?.matchedBy}/${rDrop.candidates[0]?.confidence}）`
);

const rNone = await handler('resolve_emoji')({ query: '吃鸡' });
check(rNone.matched === false && rNone.needsClarification === true, `resolve("吃鸡") 无高置信不猜（needsClarification=${rNone.needsClarification}, candidates=${rNone.candidates.length}）`);

// ── 断言 8：整表替换语义 + 超长 query 截断 ──
await handler('set_emoji_note')({ emojiId: 'file_test_fox', note: '狐狸检查 PR', aliases: ['新别名'], tags: [] });
const replaced = await handler('get_emoji_notes')({ emojiId: 'file_test_fox' });
check(replaced[0].aliases.length === 1 && replaced[0].aliases[0] === '新别名', 'upsert 整表替换 aliases');
const rLong = await handler('resolve_emoji')({ query: '狐狸检查PR' + 'x'.repeat(250) });
check(typeof rLong.query === 'string' && rLong.query.length <= 200, `超长 query 截断 ≤200（实际 ${rLong.query.length}）`);

// ── 清理 ──
dispose();
sqlite.close();
for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) { try { rmSync(f, { force: true }); } catch {} }

console.log(`\n结果：${passCount} PASS / ${failCount} FAIL`);
process.exitCode = failCount > 0 ? 1 : 0;
