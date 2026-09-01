import Database from 'better-sqlite3';
const db = new Database('data/vrc-monitor.sqlite3', { readonly: true });

// plg_events_store 列结构
const cols = db.prepare("PRAGMA table_info(plg_events_store)").all().map(c => c.name);
console.log('=== plg_events_store 列 ===');
console.log(cols.join(', '));

// 找时间列
const timeCol = cols.find(c => /time|at|date|created|updated|ts/i.test(c));
console.log('时间列候选:', timeCol);
if (timeCol) {
  const r = db.prepare(`SELECT MAX(${timeCol}) mt, MIN(${timeCol}) min_t, COUNT(*) c FROM plg_events_store`).get();
  console.log(`最近采集: ${r.mt} | 最早: ${r.min_t} | 总数: ${r.c}`);
  // 按最近几条看
  const recent = db.prepare(`SELECT ${timeCol} t, title, group_name FROM plg_events_store ORDER BY ${timeCol} DESC LIMIT 5`).all();
  console.log('\n最近5条采集活动:');
  for (const row of recent) console.log(`  ${row.t} | ${row.group_name || '-'} | ${String(row.title || '').slice(0,40)}`);
}

// group_cache 最近更新的几个
console.log('\n=== group_cache 最近更新前5 ===');
const gc = db.prepare('SELECT group_id, name, updated_at FROM group_cache ORDER BY updated_at DESC LIMIT 5').all();
for (const row of gc) console.log(`  ${row.updated_at} | ${String(row.name || row.group_id).slice(0,30)}`);
