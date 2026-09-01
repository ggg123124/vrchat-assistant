import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── PR#64: 重复 worldId 输入 → 是否重复调 API ──
const { default: worldNames } = await import('./pr-64/core/world-names.js');
const { Storage: StoragePr64 } = await import('./pr-64/core/storage.js');
const s64 = new StoragePr64(); await s64.init(path.join(__dirname, 't-e1.sqlite3'));
let calls = 0;
const apiMock = { async _request(m, url) { calls++; return { status: 200, data: { id: 'wrld_dup', name: 'Dup World', authorId: '', authorName: '', capacity: 0, favorites: 0, releaseStatus: '', tags: [], description: '', imageUrl: '' } }; } };
const r = await worldNames.resolveWorldNames({ storage: s64, api: apiMock }, ['wrld_dup', 'wrld_dup', 'wrld_dup'], { throttleMs: 0 });
console.log(`重复输入 3 次同一 worldId → API 调用 ${calls} 次 (结果: ${r.get('wrld_dup')})`);

// ── PR#63: 负 limit 边界 ──
const { Storage: StoragePr63 } = await import('./pr-63/core/storage.js');
const sp = new StoragePr63(); await sp.init(path.join(__dirname, 't-e2.sqlite3'));
const ins = sp.db.prepare(`INSERT INTO events (type, user_id, display_name, content_json, world_id, world_name, created_at, source)
  VALUES ('friend-location', ?, 'X', '{"location":"wrld_1:1~region(us)~instance(1)"}', 'wrld_1', 'W1', '2026-08-01T10:00:00.000Z', 'test')`);
for (let i = 0; i < 8; i++) ins.run('usr_x');
const START = '2026-08-01T00:00:00.000Z', END = '2026-08-01T23:59:59.999Z';
const rNeg = sp.findFriendPairScreen('usr_x', 'usr_x', START, END, 30, -3);
console.log(`limit=-3 → matches=${rNeg.matches.length}（预期 8 全量；若为 5 则 slice(0,-3) 边界异常）`);
const rF = sp.findFriendPairScreen('usr_x', 'usr_x', START, END, 30, 2.7);
console.log(`limit=2.7 → matches=${rF.matches.length}（slice 取整行为）`);
