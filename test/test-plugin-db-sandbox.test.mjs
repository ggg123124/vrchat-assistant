/**
 * test-plugin-db-sandbox.mjs — 插件 DB 沙箱白名单测试（无凭据，可离线）
 *
 * 覆盖（对应 docs/PLUGIN-API.md §4.2 契约）：
 *   1. 合法：本插件 plg_<name>_ 表名（裸别名/全名/带引号/连字符插件名）放行，rewrite 仍生效
 *   2. 拒绝：核心表名（friends/events 等）在任何表名位置（FROM/JOIN/UPDATE/INTO/TABLE/DROP/PRAGMA）被拒
 *   3. 拒绝：其他插件 plg_xxx_ 前缀（含快速通道：字符串中出现其他插件前缀同样拒绝）
 *   4. 不误报：字符串字面量/注释中的表名、ON CONFLICT、CREATE INDEX ... ON、WITH CTE 等合法 SQL
 *
 * 用法：node test/test-plugin-db-sandbox.mjs
 */
import { buildPluginApi as buildApi, rewritePluginTableNames } from '../core/plugin-api.js';

let pass = true;
const errors = [];
const assert = (c, m) => { if (!c) { pass = false; errors.push(m); } };
const assertThrows = (fn, re, m) => {
  try {
    fn();
    assert(false, `${m}（未抛出）`);
  } catch (err) {
    assert(re.test(err.message), `${m}（错误消息不匹配: ${err.message}）`);
  }
};

function makeApi(pluginName = 'testplugin') {
  const calls = [];
  const storage = {
    run: (sql, params) => { calls.push({ sql, params }); return { changes: 0 }; },
    get: (sql, params) => { calls.push({ sql, params }); return null; },
    query: (sql, params) => { calls.push({ sql, params }); return []; },
    exec: (sql) => { calls.push({ sql }); },
    transaction: (fn) => () => fn(storage),
  };
  const api = buildApi(pluginName, {
    registry: {},
    ctx: { storage, httpRoutes: new Map() },
    services: new Map(),
    serviceOwners: new Map(),
    log: () => {},
  });
  return { api, calls };
}

// ── 1. 合法：本插件表名放行 + rewrite 生效 ──
{
  const { api, calls } = makeApi();
  const items = api.db.table('items');
  items.run('INSERT INTO items (id, note) VALUES ($id, $note)', { $id: 1, $note: 'x' });
  assert(calls[0].sql.includes('INSERT INTO plg_testplugin_items'), '裸别名应被重写为本插件前缀表名');
  items.get('SELECT * FROM items WHERE id = 1');
  items.all('SELECT * FROM "items"'); // 带引号别名（events 插件 "store" 同款写法）
  api.db.exec('CREATE TABLE IF NOT EXISTS plg_testplugin_x (id INTEGER)'); // 全名直写本插件前缀
  api.db.exec('PRAGMA table_info(plg_testplugin_items)'); // 本插件表的 PRAGMA
  api.db.exec('CREATE TABLE IF NOT EXISTS plg_testplugin_deep_table (id INTEGER)'); // 本插件命名空间内更深层表名同样放行
  console.log('  ✅ 合法：本插件表名（裸别名/引号别名/全名/PRAGMA）放行且 rewrite 生效');
}

// ── 2. 连字符插件名（emoji-notes 同款：CREATE INDEX ... ON + 双引号处理）──
{
  const { api, calls } = makeApi('emoji-notes');
  const notes = api.db.table('notes');
  notes.exec('CREATE INDEX IF NOT EXISTS idx_notes_kind ON notes(kind)');
  assert(calls[0].sql.includes('"plg_emoji-notes_notes"'), '连字符插件名表名应加双引号重写');
  notes.run(
    'INSERT INTO notes (emoji_id, kind) VALUES ($id, $kind) ON CONFLICT(emoji_id) DO UPDATE SET kind = excluded.kind',
    { $id: 'default_x', $kind: 'builtin' }
  );
  notes.all('SELECT * FROM notes WHERE deleted = 0');
  console.log('  ✅ 合法：连字符插件名 + CREATE INDEX ... ON + ON CONFLICT 不误报');
}

// ── 3. 拒绝：核心表名 ──
{
  const { api } = makeApi();
  const items = api.db.table('items');
  assertThrows(() => items.all('SELECT * FROM friends'), /不能访问表 friends/, 'FROM 核心表 friends');
  assertThrows(() => items.all('SELECT * FROM friends JOIN plg_testplugin_x ON 1=1'), /friends/, 'JOIN 核心表');
  assertThrows(() => items.run('UPDATE friends SET x = 1'), /friends/, 'UPDATE 核心表');
  assertThrows(() => items.run('DELETE FROM events WHERE id = 1'), /events/, 'DELETE FROM 核心表');
  assertThrows(() => api.db.exec('DROP TABLE friends'), /friends/, 'DROP TABLE 核心表');
  assertThrows(() => api.db.exec('DROP TABLE IF EXISTS friends'), /friends/, 'DROP TABLE IF EXISTS 核心表');
  assertThrows(() => api.db.exec('CREATE TABLE friends (id INTEGER)'), /friends/, 'CREATE TABLE 核心表');
  assertThrows(() => api.db.exec('ALTER TABLE friends ADD COLUMN x'), /friends/, 'ALTER TABLE 核心表');
  assertThrows(() => api.db.exec('PRAGMA table_info(friends)'), /friends/, 'PRAGMA table_info 核心表');
  assertThrows(() => items.all('SELECT * FROM "friends"'), /friends/, '带引号核心表名');
  assertThrows(() => items.all('SELECT * FROM main.friends'), /main/, '限定的核心表名 main.friends');
  assertThrows(() => api.db.exec('CREATE TABLE plg_testplugin_tmp AS SELECT * FROM world_kb'), /world_kb/, 'CTAS 读取核心表');
  assertThrows(() => api.db.exec('CREATE INDEX idx ON friends(col)'), /friends/, 'CREATE INDEX ON 核心表');
  assertThrows(() => items.all('UPDATE OR REPLACE friends SET x = 1'), /friends/, 'UPDATE OR REPLACE 核心表');
  console.log('  ✅ 拒绝：核心表名在全部表名位置被拦截');
}

// ── 4. 拒绝：其他插件前缀 ──
{
  const { api } = makeApi();
  const items = api.db.table('items');
  assertThrows(() => items.all('SELECT * FROM plg_otherplugin_notes'), /plg_otherplugin_/, 'FROM 其他插件表');
  assertThrows(() => items.all('SELECT * FROM "plg_otherplugin_notes"'), /plg_otherplugin_/, '带引号其他插件表');
  assertThrows(() => items.all('SELECT * FROM plg_testplugin2_x'), /plg_testplugin2_/, '前缀相似但非本插件（testplugin2）');
  // 快速通道：字符串里出现其他插件前缀（旧版行为保留）
  assertThrows(
    () => items.run("INSERT INTO items (note) VALUES ('migrated from plg_other_backup')"),
    /plg_other_/, '字符串中出现其他插件前缀（快速通道）'
  );
  console.log('  ✅ 拒绝：其他插件 plg_ 前缀（表名位置 + 快速通道）');
}

// ── 5. 不误报：字符串/注释/CTE/合法关键字组合 ──
{
  const { api, calls } = makeApi();
  const items = api.db.table('items');
  items.run("INSERT INTO items (note) VALUES ('SELECT * FROM friends -- trap')");
  items.all('SELECT * FROM items -- FROM friends\n WHERE id = 1');
  items.all('/* FROM friends */ SELECT * FROM items');
  items.all('WITH t AS (SELECT * FROM items) SELECT * FROM t'); // CTE 内部 FROM 仍检查、CTE 名放行
  items.run('UPDATE items SET note = datetime(\'now\') WHERE id = $id', { $id: 1 });
  items.run('INSERT OR REPLACE INTO items (id) VALUES (1)');
  items.all('SELECT 1'); // 无表名
  api.db.exec('PRAGMA journal_mode=WAL'); // 非表名 PRAGMA 参数
  assert(calls.length >= 8, '全部合法 SQL 应放行');
  assertThrows(() => items.all('WITH t AS (SELECT * FROM friends) SELECT * FROM t'), /friends/, 'CTE 内部读取核心表仍应被拒');
  console.log('  ✅ 不误报：字符串/注释/CTE/ON CONFLICT/合法关键字组合放行');
}

// ── 5b. #167 批次2 行为（review #169 补测试）：表值函数放行 / 语句级拒绝 / RENAME 处理 ──
{
  const { api } = makeApi();
  const items = api.db.table('items');

  // 表值函数在表名位置放行（不读表，无越权）
  items.all('SELECT * FROM json_each(\'[1,2,3]\')');
  items.all('SELECT * FROM json_tree(\'{"a":1}\')');
  items.all('SELECT * FROM generate_series(1, 5)');
  items.all('SELECT * FROM pragma_table_info(\'items\')');
  items.all('SELECT value FROM json_each((SELECT note FROM items))'); // 内嵌子查询仍受检：items 是本插件表
  assertThrows(() => items.all('SELECT * FROM json_each((SELECT json FROM events))'), /events/, '表值函数参数内的核心表子查询仍被拒');

  // 语句级拒绝：VACUUM/ATTACH/DETACH（首词 + 中段 ;VACUUM;）+ 专属报错文案（review #169 💡2）
  assertThrows(() => api.db.exec('VACUUM'), /不允许执行 VACUUM 语句/, 'VACUUM 语句级拒绝');
  assertThrows(() => api.db.exec("VACUUM INTO 'backup.db'"), /不允许执行 VACUUM 语句/, 'VACUUM INTO 拒绝');
  assertThrows(() => api.db.exec("ATTACH DATABASE 'x.db' AS x"), /不允许执行 ATTACH 语句/, 'ATTACH 拒绝');
  assertThrows(() => api.db.exec('DETACH DATABASE x'), /不允许执行 DETACH 语句/, 'DETACH 拒绝');
  assertThrows(() => api.db.exec('SELECT 1; VACUUM;'), /不允许执行 VACUUM 语句/, '语句中段 ;VACUUM; 拒绝');
  // 字符串字面量内的 VACUUM 不误报
  items.all("SELECT 'VACUUM' AS s FROM items");

  // 运行期 RENAME TO：目标纳入校验（review #169 建议#2）
  api.db.exec('ALTER TABLE items RENAME TO plg_testplugin_items_v2'); // 本插件命名空间内改名放行
  assertThrows(() => api.db.exec('ALTER TABLE plg_testplugin_items_v2 RENAME TO events'), /events/, 'RENAME TO 核心表名拒绝');
  assertThrows(() => api.db.exec('ALTER TABLE plg_testplugin_items_v2 RENAME TO x_backup'), /x_backup/, 'RENAME TO 无前缀目标拒绝');

  // 运行期 RENAME COLUMN：列名目标不进入表名校验（COLUMN 豁免，review #169 inline #1）
  api.db.exec('ALTER TABLE plg_testplugin_items_v2 RENAME COLUMN note TO note2');

  console.log('  ✅ #167批次2：表值函数放行/VACUUM+ATTACH拒绝(专属文案)/RENAME TO校验/RENAME COLUMN豁免');
}

// ── 6. schema.sql 白名单（_applySchema 路径）──
{
  const prefix = 'plg_schema_test_';

  // 拒绝：核心表名出现在各种表名位置
  assertThrows(() => rewritePluginTableNames('INSERT INTO friends (id) VALUES (1)', 'schema_test', prefix), /friends/, 'schema INSERT INTO 核心表');
  assertThrows(() => rewritePluginTableNames('SELECT * FROM friends', 'schema_test', prefix), /friends/, 'schema SELECT FROM 核心表');
  assertThrows(() => rewritePluginTableNames('UPDATE friends SET x = 1', 'schema_test', prefix), /friends/, 'schema UPDATE 核心表');
  assertThrows(() => rewritePluginTableNames('DELETE FROM events WHERE id = 1', 'schema_test', prefix), /events/, 'schema DELETE FROM 核心表');
  assertThrows(() => rewritePluginTableNames('CREATE TABLE friends (id INTEGER)', 'schema_test', prefix), /friends/, 'schema CREATE TABLE 核心表');
  assertThrows(() => rewritePluginTableNames('ALTER TABLE friends ADD COLUMN x', 'schema_test', prefix), /friends/, 'schema ALTER TABLE 核心表');
  assertThrows(() => rewritePluginTableNames('PRAGMA table_info(friends)', 'schema_test', prefix), /friends/, 'schema PRAGMA table_info 核心表');
  assertThrows(() => rewritePluginTableNames('CREATE INDEX idx ON friends(col)', 'schema_test', prefix), /friends/, 'schema CREATE INDEX ON 核心表');

  // 拒绝：其他插件前缀
  assertThrows(() => rewritePluginTableNames('SELECT * FROM plg_otherplugin_notes', 'schema_test', prefix), /plg_otherplugin_/, 'schema 访问其他插件表');

  // 合法：本插件裸表名在 CREATE/ALTER 后定义，并在 DML/DDL 位置重写
  const rewritten = rewritePluginTableNames(
    "CREATE TABLE notes (id INTEGER PRIMARY KEY, note TEXT); INSERT INTO notes (note) VALUES ('hello');",
    'schema_test',
    prefix
  );
  assert(rewritten.includes('CREATE TABLE plg_schema_test_notes'), 'schema CREATE TABLE 裸表名应被重写');
  assert(rewritten.includes('INSERT INTO plg_schema_test_notes'), 'schema INSERT INTO 裸表名应被重写');

  // CREATE INDEX / ALTER TABLE / DROP TABLE 引用本插件裸表名也允许
  const rewritten2 = rewritePluginTableNames(
    'CREATE TABLE logs (id INTEGER); CREATE INDEX idx ON logs(col); ALTER TABLE logs RENAME TO logs_v2;',
    'schema_test',
    prefix
  );
  assert(rewritten2.includes('CREATE TABLE plg_schema_test_logs'), 'schema CREATE TABLE logs 应被重写');
  assert(rewritten2.includes('CREATE INDEX idx ON plg_schema_test_logs'), 'schema CREATE INDEX ON logs 应被重写');

  // 带 IF NOT EXISTS 的 CREATE TABLE 同样识别为插件表定义
  const rewritten3 = rewritePluginTableNames(
    'CREATE TABLE IF NOT EXISTS items (id INTEGER); SELECT * FROM items;',
    'schema_test',
    prefix
  );
  assert(rewritten3.includes('CREATE TABLE IF NOT EXISTS plg_schema_test_items'), 'schema CREATE TABLE IF NOT EXISTS 应被重写');
  assert(rewritten3.includes('SELECT * FROM plg_schema_test_items'), 'schema SELECT FROM 插件表应被重写');

  // 字符串/注释中的核心表名不误报
  const rewritten4 = rewritePluginTableNames(
    "CREATE TABLE items (note TEXT); INSERT INTO items (note) VALUES ('friends'); -- from events\n/* select friends */",
    'schema_test',
    prefix
  );
  assert(rewritten4.includes("INSERT INTO plg_schema_test_items"), 'schema INSERT INTO 插件表应被重写');
  assert(!rewritten4.includes('plg_schema_test_friends'), '字符串/注释中的 friends 不应被重写');

  // 引号包裹裸表名 + 表名含空格（加前缀后仍需引号）：不应输出双重引号（review #161 修复）
  const rewritten5 = rewritePluginTableNames(
    'CREATE TABLE "my items" (id INTEGER); INSERT INTO "my items" (id) VALUES (1);',
    'schema_test',
    prefix
  );
  assert(rewritten5.includes('CREATE TABLE "plg_schema_test_my items"'), 'schema 引号裸表名(空格) CREATE 应重写为单层引号');
  assert(rewritten5.includes('INSERT INTO "plg_schema_test_my items"'), 'schema 引号裸表名(空格) DML 应重写为单层引号');
  assert(!rewritten5.includes('""'), '引号包裹表名不应出现双重引号');

  // 插件名含连字符 → prefix 含连字符 → 表名需加引号（词分支也应正确）
  const hPrefix = 'plg_emoji-notes_';
  const rewritten6 = rewritePluginTableNames(
    'CREATE TABLE notes (id INTEGER); INSERT INTO notes (id) VALUES (1);',
    'emoji-notes',
    hPrefix
  );
  assert(rewritten6.includes('CREATE TABLE "plg_emoji-notes_notes"'), '连字符插件名 CREATE 表名应带引号');
  assert(rewritten6.includes('INSERT INTO "plg_emoji-notes_notes"'), '连字符插件名 DML 表名应带引号');

  // RENAME COLUMN（SQLite 3.25+）：列名目标是列不是表，不应被加前缀（review #169 inline #1 回归用例）
  const renamed = rewritePluginTableNames(
    'ALTER TABLE logs RENAME COLUMN note TO note2',
    'schema_test',
    prefix
  );
  assert(renamed.includes('ALTER TABLE plg_schema_test_logs RENAME COLUMN note TO note2'), 'RENAME COLUMN 源表重写、列名透传');

  // RENAME TO 目标为无前缀名 → 加前缀；为其他插件前缀 → 拒绝（review #169 建议#2 对应 schema 路径）
  const renamed2 = rewritePluginTableNames(
    'CREATE TABLE logs (id INTEGER); ALTER TABLE logs RENAME TO logs_v2;',
    'schema_test',
    prefix
  );
  assert(renamed2.includes('ALTER TABLE plg_schema_test_logs RENAME TO plg_schema_test_logs_v2'), 'RENAME TO 无前缀目标应加前缀');
  assertThrows(
    () => rewritePluginTableNames('CREATE TABLE logs (id INTEGER); ALTER TABLE logs RENAME TO friends;', 'schema_test', prefix),
    /friends/, 'RENAME TO 核心表名拒绝'
  );

  console.log('  ✅ schema.sql 白名单：核心表/其他插件表拒绝，本插件裸表名重写');
}

if (pass) {
  console.log(`plugin db sandbox: PASS`);
  process.exit(0);
} else {
  console.log('plugin db sandbox: FAIL');
  for (const e of errors) console.log(' -', e);
  process.exit(1);
}
