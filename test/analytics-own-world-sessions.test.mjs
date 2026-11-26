/**
 * analytics-own-world-sessions.test.mjs — getOwnWorldSessions 同世界重复位置事件回归（issue #316）
 *
 * 缺陷：原实现每遇到一条 wrld_ 位置事件就重置 curStart，导致
 *   - 同实例心跳（去重窗口外的重复位置事件）把长场次的起点推到末尾；
 *   - 同世界换实例也被当成新起点；
 * 最终场次被压短，甚至整段被 <3 分钟过滤掉（issue #316 的 13:21:18 / 15:35:26 即 0 场）。
 *
 * 本用例走真实 Storage + 临时 SQLite，直接插入 user-location 行，钉住 5 个场景：
 *   ① issue 原场景：同世界同实例两条事件 + traveling 收尾 → 1 场 136.05min；
 *   ② 窗口末尾是重复事件（无转场）→ 1 场 60min；
 *   ③ 同 worldId 异实例（无 traveling 分隔）→ 1 场 ≈10min；
 *   ④ 每 30min 一条同世界心跳共 6 条 → 1 场 150min；
 *   ⑤ 回归对照 A→B（含 traveling 收尾）→ 2 场 60/60min。
 *
 * 已知限制（实现注释同款）：同世界两条事件相隔很久（应用崩溃/重启期间无 offline 行）
 * 会被合并成一场、可能偏长；不引入「间隔 N 分钟切分」阈值——VRChat 静止时不发事件，
 * 阈值会砍碎真实长场次。
 */
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Storage } from '../core/storage.js';

const TMP_DB = path.join(os.tmpdir(), `vrmon-own-world-sessions-${process.pid}-${Date.now()}.sqlite3`);
const st = new Storage();
await st.init(TMP_DB);

const OWNER = 'usr_test316';
const WINDOW = { start: '2026-08-01T09:00:00Z', end: '2026-08-01T18:00:00Z' };

function cleanupDb() {
  for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) {
    try { rmSync(f, { force: true }); } catch {}
  }
}

/** 清空 events 后按 [时间戳, location] 顺序插入 user-location 行（时间戳升序） */
function seed(points) {
  st.db.prepare('DELETE FROM events').run();
  const ins = st.db.prepare(
    `INSERT INTO events (type,user_id,display_name,content_json,world_id,world_name,created_at) VALUES (?,?,?,?,?,?,?)`
  );
  for (const [createdAt, location] of points) {
    const wid = location.startsWith('wrld_') ? location.split(':')[0] : null;
    ins.run('user-location', OWNER, 'Self316', JSON.stringify({ location }), wid, wid ? `World ${wid}` : null, createdAt);
  }
}

/** 断言会话条数 + 逐条 minutes（±0.1）与 worldId */
function expectSessions(sessions, expected) {
  assert.equal(sessions.length, expected.length, `会话条数应为 ${expected.length}，实际 ${sessions.length}`);
  expected.forEach((exp, i) => {
    const s = sessions[i];
    assert.equal(s.worldId, exp.worldId, `第 ${i} 场 worldId 应为 ${exp.worldId}`);
    assert.ok(
      Math.abs(s.minutes - exp.minutes) <= 0.1,
      `第 ${i} 场 minutes 应≈${exp.minutes}，实际 ${s.minutes}`
    );
  });
}

after(() => {
  try { st.close(); } catch {}
  cleanupDb();
});

test('① issue 原场景：同世界同实例重复事件不重置起点（+traveling 收尾）', () => {
  seed([
    ['2026-08-01T13:21:18Z', 'wrld_w1:inst_i1'],
    ['2026-08-01T15:35:26Z', 'wrld_w1:inst_i1'],
    ['2026-08-01T15:37:21Z', 'traveling'],
  ]);
  const sessions = st.getOwnWorldSessions(WINDOW.start, WINDOW.end);
  // 13:21:18 → 15:37:21 = 2h16m03s = 136.05min；旧实现会从 15:35:26 起算 → 1.92min 被过滤成 0 场
  expectSessions(sessions, [{ worldId: 'wrld_w1', minutes: 136.05 }]);
});

test('② 窗口末尾是重复事件：无转场也保留整场', () => {
  seed([
    ['2026-08-01T10:00:00Z', 'wrld_w2:inst_i1'],
    ['2026-08-01T11:00:00Z', 'wrld_w2:inst_i1'],
  ]);
  const sessions = st.getOwnWorldSessions(WINDOW.start, WINDOW.end);
  // 收尾用最后一条事件时间（11:00），起点仍是 10:00 → 60min
  expectSessions(sessions, [{ worldId: 'wrld_w2', minutes: 60 }]);
});

test('③ 同 worldId 异实例：不切分，合并为一场', () => {
  seed([
    ['2026-08-01T10:00:00Z', 'wrld_w3:12345'],
    ['2026-08-01T10:10:00Z', 'wrld_w3:67890'],
  ]);
  const sessions = st.getOwnWorldSessions(WINDOW.start, WINDOW.end);
  expectSessions(sessions, [{ worldId: 'wrld_w3', minutes: 10 }]);
});

test('④ 每 30min 一条同世界心跳共 6 条：不砍碎 2.5h 长场次', () => {
  seed([
    ['2026-08-01T10:00:00Z', 'wrld_w4:inst_i1'],
    ['2026-08-01T10:30:00Z', 'wrld_w4:inst_i1'],
    ['2026-08-01T11:00:00Z', 'wrld_w4:inst_i1'],
    ['2026-08-01T11:30:00Z', 'wrld_w4:inst_i1'],
    ['2026-08-01T12:00:00Z', 'wrld_w4:inst_i1'],
    ['2026-08-01T12:30:00Z', 'wrld_w4:inst_i1'],
  ]);
  const sessions = st.getOwnWorldSessions(WINDOW.start, WINDOW.end);
  expectSessions(sessions, [{ worldId: 'wrld_w4', minutes: 150 }]);
});

test('⑤ 回归对照：A→B 换世界仍正常切分（含 traveling 收尾）', () => {
  seed([
    ['2026-08-01T10:00:00Z', 'wrld_w5:inst_i1'],
    ['2026-08-01T11:00:00Z', 'wrld_w6:inst_i2'],
    ['2026-08-01T12:00:00Z', 'traveling'],
  ]);
  const sessions = st.getOwnWorldSessions(WINDOW.start, WINDOW.end);
  expectSessions(sessions, [
    { worldId: 'wrld_w5', minutes: 60 },
    { worldId: 'wrld_w6', minutes: 60 },
  ]);
});
