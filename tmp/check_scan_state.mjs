import Database from 'better-sqlite3';
const db = new Database('data/vrc-monitor.sqlite3', { readonly: true });
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
console.log('=== 群组/事件/插件相关表 ===');
console.log(tables.filter(n => /event|group|plg|store|cache/i.test(n)).join('\n'));
console.log('\n=== 各缓存表最新时间 ===');
for (const t of tables) {
  if (!/group_cache|plg_events|world_cache/i.test(t)) continue;
  try {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
    const timeCol = cols.find(c => /time|at|date|created|updated/i.test(c));
    if (timeCol) {
      const r = db.prepare(`SELECT MAX(${timeCol}) mt, COUNT(*) c FROM ${t}`).get();
      console.log(`${t}.${timeCol}: 最新="${r.mt}" 总数=${r.c}`);
    } else {
      console.log(`${t}: (无可识别时间列) 总数=${db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c}`);
    }
  } catch (e) {
    console.log(`${t}: err ${e.message}`);
  }
}
