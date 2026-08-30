#!/usr/bin/env node
/**
 * test-storage-snapshot.mjs — storage.js 行为等价回归基线（无凭据）
 *
 * 为 core/storage.js 的公共方法建立「输入 → 返回 JSON」快照基线：
 *   - 临时库 + 固定时间戳 seed（每次运行结果逐字节一致，确定性）
 *   - 运行公共方法，捕获返回（写方法另带 readback 回读），写入 golden `storage-snapshot.json`
 *   - --generate 生成基线；默认（或 --check）校验当前输出与基线一致，exit 1 = 漂移
 *
 * 用途：storage 拆分（按域切分 / social.js 独立 / 下沉插件）时，每步重构后跑本测试，
 *       确保行为等价（返回结构逐字节一致）不回归。
 *
 * 用法：
 *   node test-storage-snapshot.mjs --generate   # 生成基线（首次）
 *   node test-storage-snapshot.mjs              # 校验（默认）
 *   node test-storage-snapshot.mjs --check      # 同默认
 */
import { rmSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { Storage } = await import(pathToFileURL(path.join(__dirname, 'core', 'storage.js')).href);

const GOLDEN = path.join(__dirname, 'storage-snapshot.json');
const ARG_GENERATE = process.argv.includes('--generate');
const ARG_CHECK = process.argv.includes('--check');

// 固定时间窗口与固定时间戳（保证确定性，不用 datetime('now')）
const T0 = '2026-08-01T09:00:00Z';
const T1 = '2026-08-01T11:59:59Z';

// 固定临时库名（非 pid）：每次运行开始先清一次，保证「崩溃残留也能重置干净 + 确定性」。
const DB = path.join(os.tmpdir(), 'vrmon-storage-snap.sqlite3');
function cleanupDb() {
  for (const f of [DB, DB + '-wal', DB + '-shm']) { try { rmSync(f, { force: true }); } catch {} }
}

const ISO_NOW_SENTINEL = '<<ISO:NOW>>';
// 归一化：把"当前时间"生成的 ISO/UTC 时间戳（含毫秒，或 SQLite datetime('now') 空格格式）
// 替换为固定哨兵——写方法内部用 new Date() 打真时间戳，对"行为等价"无意义（结构/逻辑稳定即可）。
// 种子里的固定时间戳（如 2026-08-01T09:00:00Z，无毫秒）不会被误换。
function normalize(v) {
  if (typeof v === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)) return ISO_NOW_SENTINEL;
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v)) return ISO_NOW_SENTINEL;
    return v;
  }
  if (Array.isArray(v)) return v.map(normalize);
  if (v instanceof Set) return [...v].map(normalize).sort();
  if (v instanceof Map) {
    const o = {};
    for (const [k, val] of v) o[k] = normalize(val);
    return o;
  }
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = normalize(v[k]);
    return o;
  }
  return v;
}
function serialize(v) {
  // undefined → 标记串；其余 normalize（对象/数组/字符串/数字/布尔/null）
  if (v === undefined) return '<<void>>';
  return normalize(v);
}
function capture(fn) {
  try { return serialize(fn()); }
  catch (e) { return { __error: e.message }; }
}

// ── 1. 临时库 + 初始化 ──
cleanupDb();
const st = new Storage();
await st.init(DB);
// 种子插入：直接走 better-sqlite3 位置参数绑定（绕过 _run 的命名参数包装）
const run = (sql, params = []) => st.db.prepare(sql).run(...params);

// ── 2. Seed（固定时间戳，确定性）──
// events
const EV = [
  ['user-location', 'usr_testA', 'Alice', '{"location":"wrld_w1:inst_i1"}', 'wrld_w1', 'World One', '2026-08-01T09:00:00Z'],
  ['friend-location', 'usr_testB', 'Bob', '{"location":"wrld_w1:inst_i1"}', 'wrld_w1', 'World One', '2026-08-01T09:10:00Z'],
  ['friend-location', 'usr_testC', 'Carol', '{"location":"wrld_w2:inst_i2"}', 'wrld_w2', 'World Two', '2026-08-01T09:20:00Z'],
  ['user-location', 'usr_testA', 'Alice', '{"location":"wrld_w2:inst_i2"}', 'wrld_w2', 'World Two', '2026-08-01T10:00:00Z'],
  ['friend-online', 'usr_testA', 'Alice', '{}', null, null, '2026-08-01T10:30:00Z'],
  ['friend-offline', 'usr_testA', 'Alice', '{}', null, null, '2026-08-01T10:45:00Z'],
  ['friend-location', 'usr_testB', 'Bob', '{"location":"wrld_w1:inst_i1"}', 'wrld_w1', 'World One', '2026-08-01T11:00:00Z'],
  ['user-location', 'usr_testA', 'Alice', '{"location":"wrld_w1:inst_i1"}', 'wrld_w1', 'World One', '2026-08-01T11:30:00Z'],
];
for (const [type, uid, name, cj, wid, wname, t] of EV) {
  run(`INSERT INTO events (type,user_id,display_name,content_json,world_id,world_name,created_at) VALUES (?,?,?,?,?,?,?)`,
    [type, uid, name, cj, wid, wname, t]);
}

// friends
run(`INSERT INTO friends (user_id,display_name,memo,trust_level,is_online,location,world_id,world_name,last_online,last_offline)
     VALUES ('usr_testA','Alice','备注A','known',1,'wrld_w1:inst_i1','wrld_w1','World One','2026-08-01T09:00:00Z','2026-08-01T10:45:00Z')`);
run(`INSERT INTO friends (user_id,display_name,is_online,location,world_id,world_name,last_online)
     VALUES ('usr_testB','Bob',1,'wrld_w1:inst_i1','wrld_w1','World One','2026-08-01T09:10:00Z')`);
run(`INSERT INTO friends (user_id,display_name,is_online,last_offline) VALUES ('usr_testC','Carol',0,'2026-08-01T09:20:00Z')`);

// world_cache
run(`INSERT INTO world_cache (world_id,name,note,author_id,author_name,description,capacity,favorites,tags,favorited,updated_at)
     VALUES ('wrld_w1','World One','我喜欢的图','usr_auth1','Author One','第一个世界',80,500,'["social","photo"]',1,'2026-08-01T09:00:00Z')`);
run(`INSERT INTO world_cache (world_id,name,favorites,updated_at) VALUES ('wrld_w2','World Two',100,'2026-08-01T09:00:00Z')`);

// config
run(`INSERT INTO config (key,value) VALUES ('test_key','test_val')`);

// watchlist
run(`INSERT INTO watchlist (user_id,display_name,priority) VALUES ('usr_testB','Bob',1)`);

// nicknames
run(`INSERT INTO nicknames (user_id,display_name,nickname) VALUES ('usr_testA','Alice','小爱')`);

// world_history
run(`INSERT INTO world_history (world_id,field,old_value,new_value,changed_at) VALUES ('wrld_w1','name','Old World','World One','2026-08-01T09:00:00Z')`);

// world_zh_translations
run(`INSERT INTO world_zh_translations (world_id,zh,updated_at) VALUES ('wrld_w1','世界一','2026-08-01T09:00:00Z')`);

// group_cache
run(`INSERT INTO group_cache (group_id,name,description,member_count,updated_at) VALUES ('grp1','My Group','',50,'2026-08-01T09:00:00Z')`);

// planet_cache
run(`INSERT INTO planet_cache (key,payload,fetched_at) VALUES ('planet:popular','{"a":1}','2026-08-01T09:00:00Z')`);

// booth_items
run(`INSERT INTO booth_items (id,name,price,wishlist_count,shop_name) VALUES ('item1','Avatar A','¥100',5,'Shop A')`);
// booth_search_history
run(`INSERT INTO booth_search_history (query,result_ids,result_count,created_at) VALUES ('avatar','["item1"]',1,'2026-08-01T09:00:00Z')`);

// join_choices
run(`INSERT INTO join_choices (created_at,user_id,display_name,world_id,world_name,world_tags) VALUES ('2026-08-01T09:00:00Z','usr_testB','Bob','wrld_w1','World One','["social"]')`);

// world_kb
run(`INSERT INTO world_kb (world_id,world_name,author_name,favorites,visited,visited_at,user_rating,backlog,sleep_ok,tags)
     VALUES ('wrld_w1','World One','Author One',500,1,'2026-08-01T09:00:00Z',1,0,0,'["social"]')`);
run(`INSERT INTO world_kb (world_id,world_name,favorites,backlog,backlog_added_at,backlog_reason,backlog_priority,sleep_ok)
     VALUES ('wrld_w2','World Two',100,1,'2026-08-01T09:00:00Z','想去',1,1)`);
run(`INSERT INTO world_kb (world_id,world_name,user_rating,visited,backlog)
     VALUES ('wrld_w3','World Three',-1,0,0)`);

// x_world_recommendations
run(`INSERT INTO x_world_recommendations (world_id,world_name,author_name,favorites,visits,creators,tweet_count,first_seen_at,last_recommended_at)
     VALUES ('wrld_x1','X World','X Author',42,10,'[{"screen_name":"a"}]',3,'2026-08-01T09:00:00Z','2026-08-01T09:00:00Z')`);

// ── 3. Probes：捕获公共方法返回 ──
const snap = {};
const probe = (name, fn) => { snap[name] = capture(fn); };

// —— 读方法 ——
probe('getStats', () => st.getStats());
probe('getAllFriends', () => st.getAllFriends());
probe('getOnlineFriends', () => st.getOnlineFriends());
probe('getFriend', () => st.getFriend('usr_testA'));
probe('searchFriends', () => st.searchFriends('Bob'));
probe('getEventsByUser', () => st.getEventsByUser('usr_testA', { limit: 50 }));
probe('getLatestFriendLocations', () => st.getLatestFriendLocations(['usr_testA', 'usr_testB']));
probe('getOnlineSessionStarts', () => st.getOnlineSessionStarts(['usr_testA', 'usr_testB']));
probe('getRecentEvents', () => st.getRecentEvents({ limit: 50 }));
probe('getEventsByTimeRange', () => st.getEventsByTimeRange(T0, T1));
probe('countEventsByUserInRange', () => st.countEventsByUserInRange('usr_testA', T0, T1));
probe('getFriendProfileChanges', () => st.getFriendProfileChanges('usr_testA', { limit: 50 }));
probe('getFriendProfileChangeCount', () => st.getFriendProfileChangeCount('usr_testA'));
probe('getWorldName', () => st.getWorldName('wrld_w1'));
probe('searchWorldsByName', () => st.searchWorldsByName('World'));
probe('getZhTranslations', () => st.getZhTranslations(['wrld_w1', 'wrld_w2']));
probe('getWorldHistory', () => st.getWorldHistory('wrld_w1'));
probe('getWorldKbInfo', () => st.getWorldKbInfo('wrld_w1'));
probe('getBacklog', () => st.getBacklog({ status: 'all', limit: 20 }));
probe('getNicknames', () => st.getNicknames({ userId: 'usr_testA' }));
probe('getConfig', () => st.getConfig('test_key'));
probe('getWatchlist', () => st.getWatchlist());
probe('getGroupCached', () => st.getGroupCached('grp1'));
probe('getGroupHeat', () => st.getGroupHeat(T0, T1));
probe('getPlanetCache', () => st.getPlanetCache('planet:popular', 86400000));
probe('getBoothItemCache', () => st.getBoothItemCache('item1'));
probe('listBoothItems', () => st.listBoothItems({ limit: 10 }));
probe('getBoothSearches', () => st.getBoothSearches({ limit: 10 }));
probe('findCompanions', () => st.findCompanions('usr_testA', T0, T1, false));
probe('findFriendPairScreen', () => st.findFriendPairScreen('usr_testA', 'usr_testB', T0, T1, 30, null));
probe('findFriendPairMeetings', () => st.findFriendPairMeetings('usr_testA', 'usr_testB', T0, T1, 30));
probe('getOnlinePattern', () => st.getOnlinePattern('usr_testA', { startTime: T0, endTime: T1 }));
probe('getOwnWorldSessions', () => st.getOwnWorldSessions(T0, T1));
probe('getWeeklyCompanions', () => st.getWeeklyCompanions('usr_testA', T0, T1));
probe('getFriendGroupStats', () => st.getFriendGroupStats(T0, T1));
probe('getXWorld', () => st.getXWorld('wrld_x1'));
probe('getAllXWorlds', () => st.getAllXWorlds());
probe('getXWorldsSince', () => st.getXWorldsSince('2026-08-01T00:00:00Z'));

// —— 写方法（写 + 回读）——
probe('setConfig', () => { const r = st.setConfig('w_key', 'w_val'); return { wrote: r, readback: st.getConfig('w_key') }; });
probe('setNickname', () => { const r = st.setNickname({ userId: 'usr_testB', nickname: '波尼', displayName: 'Bob' }); return { wrote: r, readback: st.getNicknames({ userId: 'usr_testB' }) }; });
probe('setZhTranslation', () => { const r = st.setZhTranslation('wrld_w2', '世界二'); return { wrote: r, readback: st.getZhTranslations(['wrld_w2']) }; });
probe('setWorldFavorited', () => { const r = st.setWorldFavorited({ worldId: 'wrld_w2', favorited: 1 }); return { wrote: r, readback: st.getWorldName('wrld_w2') }; });
probe('rateWorld', () => { const r = st.rateWorld({ worldId: 'wrld_w3', rating: 1 }); return { wrote: r, readback: st.getWorldKbInfo('wrld_w3') }; });
probe('markWorldVisited', () => { const r = st.markWorldVisited({ worldId: 'wrld_w3' }); return { wrote: r, readback: st.getWorldKbInfo('wrld_w3') }; });
probe('setWorldSleep', () => { const r = st.setWorldSleep({ worldId: 'wrld_w3', isSleep: true }); return { wrote: r, readback: st.getWorldKbInfo('wrld_w3') }; });
probe('addToBacklog', () => { const r = st.addToBacklog({ worldId: 'wrld_w3', reason: '测试', priority: 2 }); return { wrote: r, readback: st.getBacklog({ status: 'all', limit: 20 }) }; });
probe('removeFromBacklog', () => { const r = st.removeFromBacklog({ worldId: 'wrld_w2' }); return { wrote: r, readback: st.getWorldKbInfo('wrld_w2') }; });
probe('upsertGroupCache', () => { const r = st.upsertGroupCache({ groupId: 'grp2', name: 'G2', description: '', memberCount: 10 }); return { wrote: r, readback: st.getGroupCached('grp2') }; });
probe('setPlanetCache', () => { const r = st.setPlanetCache('planet:new', '{"b":2}'); return { wrote: r, readback: st.getPlanetCache('planet:new', 86400000) }; });
probe('upsertBoothItem', () => { const r = st.upsertBoothItem({ id: 'item2', name: 'Avatar B', wishlistCount: 3 }); return { wrote: r, readback: st.getBoothItemCache('item2') }; });
probe('recordBoothSearch', () => { const r = st.recordBoothSearch('suit', ['item2']); return { wrote: r, readback: st.getBoothSearches({ limit: 5 }) }; });
probe('addToWatchlist', () => { const r = st.addToWatchlist('usr_testC', 'Carol', 2); return { wrote: r, readback: st.getWatchlist() }; });
probe('removeFromWatchlist', () => { const r = st.removeFromWatchlist('usr_testC'); return { wrote: r, readback: st.getWatchlist() }; });
probe('insertEvent', () => { const r = st.insertEvent({ type: 'friend-online', userId: 'usr_testD', displayName: 'Dave', contentJson: '{}', createdAt: '2026-08-01T12:00:00Z' }); return { wrote: r, readback: st.getEventsByUser('usr_testD', { limit: 5 }) }; });
probe('insertEventsBatch', () => { const r = st.insertEventsBatch([{ type: 'friend-offline', userId: 'usr_testD', displayName: 'Dave', contentJson: '{}', createdAt: '2026-08-01T12:05:00Z' }]); return { wrote: r, readback: st.getEventsByUser('usr_testD', { limit: 5 }) }; });
probe('upsertWorld', () => { const r = st.upsertWorld({ worldId: 'wrld_w4', name: 'World Four', authorId: 'usr_a4', favorites: 10 }); return { wrote: r, readback: st.getWorldName('wrld_w4') }; });
probe('setWorldNote', () => { const r = st.setWorldNote({ worldId: 'wrld_w1', note: '改的备注' }); return { wrote: r, readback: st.getWorldName('wrld_w1') }; });
probe('backfillWorldKbInfo', () => { const r = st.backfillWorldKbInfo({ worldId: 'wrld_w3', name: 'World Three', authorName: 'Author Three', authorId: 'usr_a3', createdAt: '2026-08-01T09:00:00Z' }); return { wrote: r, readback: st.getWorldKbInfo('wrld_w3') }; });
probe('upsertWorldsBatch', () => { const r = st.upsertWorldsBatch([{ worldId: 'wrld_w5', name: 'World Five', favorites: 7 }]); return { wrote: r, readback: st.getWorldName('wrld_w5') }; });
probe('updateXWorld', () => { const r = st.updateXWorld('wrld_x1', { favorites: 77, tweetCount: 5 }); return { wrote: r, readback: st.getXWorld('wrld_x1') }; });
probe('insertXWorld', () => { const r = st.insertXWorld({ world_id: 'wrld_x2', world_name: 'X2', favorites: 5 }); return { wrote: r, readback: st.getXWorld('wrld_x2') }; });
probe('clearXWorlds', () => { const r = st.clearXWorlds(); return { wrote: r, readback: st.getAllXWorlds() }; });

// ── 4. 收尾 ──
try { st.close(); } catch {}
cleanupDb();

// ── 5. 输出 / 校验 ──
const out = JSON.stringify(snap, null, 2) + '\n';
if (ARG_GENERATE) {
  writeFileSync(GOLDEN, out);
  console.log(`[generate] 已写入基线 storage-snapshot.json（${Object.keys(snap).length} 个探测点）`);
  process.exit(0);
}
// check
let golden;
try { golden = JSON.parse(readFileSync(GOLDEN, 'utf-8')); }
catch (e) { console.error('[check] 找不到基线文件，先用 --generate 生成'); process.exit(2); }

const pretty = (o) => JSON.stringify(o);
const keys = new Set([...Object.keys(golden), ...Object.keys(snap)]);
let fail = 0;
for (const k of keys) {
  const a = pretty(golden[k]);
  const b = pretty(snap[k]);
  if (a !== b) {
    fail++;
    console.error(`[FAIL] ${k}\n  基线: ${a}\n  当前: ${b}`);
  }
}
if (fail) { console.error(`\n[结论] ${fail} 处漂移（exit 1）`); process.exit(1); }
console.log(`[check] ✓ 无漂移（${Object.keys(snap).length} 个探测点与基线一致）`);
process.exit(0);
