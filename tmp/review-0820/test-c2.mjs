import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { Storage: StoragePr65 } = await import('./pr-65/core/storage.js');
const { Storage: StorageMain } = await import('./main/core/storage.js');

// 均衡数据：200 行 usr_x + 3000 行 usr_other，确保索引有选择性
for (const [label, Storage] of [['pr65(新索引)', StoragePr65], ['main(无新索引)', StorageMain]]) {
  const dbp = path.join(__dirname, `t-c2-${label === 'pr65(新索引)' ? 'new' : 'old'}.sqlite3`);
  const s = new Storage(); await s.init(dbp);
  const ins = s.db.prepare(`INSERT INTO events (type, user_id, display_name, content_json, world_id, world_name, created_at, source)
    VALUES ('friend-location', ?, 'X', '{"location":"wrld_x:1~region(us)~instance(1)"}', 'wrld_x', 'XW', ?, 'test')`);
  for (let i = 0; i < 200; i++) ins.run('usr_x', `2026-08-0${(i % 9) + 1}T10:00:00.000Z`);
  for (let i = 0; i < 3000; i++) ins.run('usr_other', `2026-07-0${(i % 9) + 1}T10:00:00.000Z`);
  s.db.exec('ANALYZE');
  console.log(`\n== ${label} ==`);
  // 模拟 getLatestFriendLocations 类查询：按 user_id + 时间
  const p1 = s.db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM events WHERE user_id='usr_x' AND created_at >= '2026-08-01' AND type='friend-location'`).all();
  console.log('user+time+type:', JSON.stringify(p1.map(r => r.detail)));
  // 模拟 findFriendPairScreen 类查询：world_id IN + 时间范围
  const p2 = s.db.prepare(`EXPLAIN QUERY PLAN SELECT created_at FROM events WHERE user_id='usr_x' AND type='friend-location' AND created_at >= '2026-01-01' AND created_at <= '2026-12-31'`).all();
  console.log('user+time范围:', JSON.stringify(p2.map(r => r.detail)));
  const p3 = s.db.prepare(`EXPLAIN QUERY PLAN SELECT created_at FROM events WHERE world_id IN ('wrld_1','wrld_2')`).all();
  console.log('world_id IN:', JSON.stringify(p3.map(r => r.detail)));
  s.db.close();
}
