import Database from 'better-sqlite3';
const db = new Database('data/vrc-monitor.sqlite3', { readonly: true });

console.log('=== plg_events_store 采集时间(fetched_at) ===');
const r = db.prepare('SELECT MAX(fetched_at) mt, MIN(fetched_at) min_t, COUNT(*) c FROM plg_events_store').get();
console.log(`最近采集: ${r.mt} | 最早: ${r.min_t} | 总数: ${r.c}`);

const recent = db.prepare('SELECT fetched_at, group_name, name FROM plg_events_store ORDER BY fetched_at DESC LIMIT 5').all();
console.log('\n最近5条采集活动:');
for (const row of recent) console.log(`  ${row.fetched_at} | ${row.group_name || '-'} | ${String(row.name || '').slice(0,40)}`);

console.log('\n=== group_cache 最近更新前5 ===');
const gc = db.prepare('SELECT group_id, name, updated_at FROM group_cache ORDER BY updated_at DESC LIMIT 5').all();
for (const row of gc) console.log(`  ${row.updated_at} | ${String(row.name || row.group_id).slice(0,30)}`);
