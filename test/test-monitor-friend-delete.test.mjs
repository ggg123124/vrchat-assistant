/**
 * test-monitor-friend-delete.test.mjs — monitor 层 friend-delete 移除好友回归测试（issue #127 补漏）
 *
 * 覆盖 _handleDelete 对 friend-delete 事件的正确行为：
 *   刷新在线/头像同步之外，friend-delete 应把好友从 friends 表移除（此前只存事件不移除 → 解友用户残留好友列表显示 '?'）。
 * 自包含：临时 SQLite + Storage + EventPipeline，不依赖真实 VRChat 凭据。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..');

const { Storage } = await import(pathToFileURL(path.join(REPO, 'core', 'storage.js')).href);
const { EventPipeline } = await import(pathToFileURL(path.join(REPO, 'core', 'event-pipeline.js')).href);

// ── 临时 DB + 运行时准备 ──
const tmpDb = path.join(__dirname, 'test-monitor-friend-delete.sqlite3');
for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) { try { rmSync(f, { force: true }); } catch {} }

const storage = new Storage();
await storage.init(tmpDb);
const pipe = new EventPipeline(storage, {});

test('friend-delete 移除好友 + 不影响他人 + 事件入 events 表 + 重新加好友可重建', async () => {
  const F1 = 'usr_test-delf-0000-000000000001';
  const F2 = 'usr_test-delf-0000-000000000002';
  storage.upsertFriend({ userId: F1, displayName: '好友甲', isOnline: 0 });
  storage.upsertFriend({ userId: F2, displayName: '好友乙', isOnline: 0 });

  let r = storage.query(`SELECT COUNT(*) c FROM friends WHERE user_id=$u`, { $u: F1 })[0];
  assert.equal(r.c, 1, '插入后 F1 应存在');
  r = storage.query(`SELECT COUNT(*) c FROM friends WHERE user_id=$u`, { $u: F2 })[0];
  assert.equal(r.c, 1, '插入后 F2 应存在');

  // 触发 friend-delete 事件（只删 F1，模拟「解除好友」）
  await pipe._handleDelete({ userId: F1, type: 'friend-delete', displayName: '好友甲', receivedAt: new Date().toISOString() });

  r = storage.query(`SELECT COUNT(*) c FROM friends WHERE user_id=$u`, { $u: F1 })[0];
  assert.equal(r.c, 0, 'friend-delete 后 F1 应被移除');
  r = storage.query(`SELECT COUNT(*) c FROM friends WHERE user_id=$u`, { $u: F2 })[0];
  assert.equal(r.c, 1, 'friend-delete 不应影响 F2');
  r = storage.query(`SELECT COUNT(*) c FROM events WHERE user_id=$u AND type='friend-delete'`, { $u: F1 })[0];
  assert.equal(r.c, 1, 'friend-delete 事件应记录到 events 表（历史保留）');

  // 重新加好友（friend-add 路径重建）→ 验证可恢复
  storage.upsertFriend({ userId: F1, displayName: '好友甲(重新加)', isOnline: 0 });
  r = storage.query(`SELECT COUNT(*) c, MAX(display_name) dn FROM friends WHERE user_id=$u`, { $u: F1 })[0];
  assert.equal(r.c, 1, '重新加好友后 F1 应重建');
  assert.equal(r.dn, '好友甲(重新加)', '重建后 display_name 应为新值');
});

// ── 好友关系变化 × 非好友追踪联动（tracked_non_friends）──
test('friend-delete 即时进入非好友追踪（新行新增 + 已移除行重新激活）', async () => {
  const D1 = 'usr_test-delf-0000000000000000000000a1';
  const D2 = 'usr_test-delf-0000000000000000000000a2';
  // D1 从未 tracked；D2 曾 tracked 且被手动移除（removed_at != ''）
  storage.upsertFriend({ userId: D1, displayName: '将删好友一', isOnline: 0 });
  storage.upsertFriend({ userId: D2, displayName: '将删好友二', isOnline: 0 });
  storage.run(`INSERT OR IGNORE INTO tracked_non_friends (user_id, display_name) VALUES ($u, $d)`,
    { $u: D2, $d: '将删好友二' });
  storage.run(`UPDATE tracked_non_friends SET removed_at = datetime('now') WHERE user_id = $u`, { $u: D2 });
  const d2Before = storage.query(`SELECT removed_at FROM tracked_non_friends WHERE user_id=$u`, { $u: D2 })[0];
  assert.ok(d2Before.removed_at, '前置:D2 应处于已移除状态');

  await pipe._handleDelete({ userId: D1, type: 'friend-delete', displayName: '将删好友一', receivedAt: new Date().toISOString() });
  await pipe._handleDelete({ userId: D2, type: 'friend-delete', displayName: '将删好友二', receivedAt: new Date().toISOString() });

  const d1Row = storage.query(`SELECT display_name, removed_at FROM tracked_non_friends WHERE user_id=$u`, { $u: D1 })[0];
  assert.ok(d1Row, '被删好友 D1 应即时进入 tracked(无需等重启自动导入)');
  assert.equal(d1Row.removed_at, '', '新进入的 tracked 行应为活跃状态');
  assert.equal(d1Row.display_name, '将删好友一', 'display_name 取事件携带值');
  const d2Row = storage.query(`SELECT removed_at FROM tracked_non_friends WHERE user_id=$u`, { $u: D2 })[0];
  assert.equal(d2Row.removed_at, '', '已移除的 tracked 行应被重新激活(removed_at 清空)');
});

test('friend-add 从非好友追踪移出(软删除)+ 不在 tracked 的好友无新行', async () => {
  const A1 = 'usr_test-delf-0000000000000000000000b1';
  const A2 = 'usr_test-delf-0000000000000000000000b2';
  // A1 已在 tracked(活跃)；A2 不在 tracked
  storage.run(`INSERT OR IGNORE INTO tracked_non_friends (user_id, display_name) VALUES ($u, $d)`,
    { $u: A1, $d: '转正好友' });

  await pipe._handleAdd({ userId: A1, type: 'friend-add', displayName: '转正好友', receivedAt: new Date().toISOString() });
  await pipe._handleAdd({ userId: A2, type: 'friend-add', displayName: '纯新好友', receivedAt: new Date().toISOString() });

  const a1 = storage.query(`SELECT removed_at FROM tracked_non_friends WHERE user_id=$u`, { $u: A1 })[0];
  assert.ok(a1.removed_at, '加好友后 tracked 活跃行应被标记移出(已是好友,不再是非好友)');
  const a2 = storage.query(`SELECT COUNT(*) c FROM tracked_non_friends WHERE user_id=$u`, { $u: A2 })[0];
  assert.equal(a2.c, 0, '不在 tracked 的好友加好友后不应新增 tracked 行');

  // 成对语义回归:再删好友 → 重新激活(加好友移出 / 删好友激活 闭环)
  await pipe._handleDelete({ userId: A1, type: 'friend-delete', displayName: '转正好友', receivedAt: new Date().toISOString() });
  const a1Back = storage.query(`SELECT removed_at FROM tracked_non_friends WHERE user_id=$u`, { $u: A1 })[0];
  assert.equal(a1Back.removed_at, '', '删好友后应重新激活追踪(成对联动)');
});

// ── 清理 ──
after(() => {
  for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) { try { rmSync(f, { force: true }); } catch {} }
});
