/**
 * self-presence.test.mjs — core/self-presence.js 三态判定 + dashboard 服务语义回归
 *
 * 覆盖：
 *   1. resolveSelfPresence 的三态判定（in_game / not_in_game / unknown）与边界
 *      （无 selfId、无记录、解析失败、在游戏态陈旧、private/traveling 形态）；
 *   2. dashboard.isSelfOnline 的三值映射与重构前语义一致（不破坏现有插件消费方）；
 *   3. dashboard.selfPresence 作为新服务暴露且与 isSelfOnline 同源。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveSelfPresence,
  worldIdFromSelfLocation,
  SELF_PRESENCE_STALE_MS,
  readOfflineGraceMs,
} from '../core/self-presence.js';
import { registerDashboardServices } from '../core/dashboard-services.js';

const SELF = 'usr_c834d70f-e199-4d71-9cfc-9aa33a4880f9';
const NOW = Date.parse('2026-09-17T12:00:00.000Z');

/** 造一个只支持本模块那条查询的最小 storage */
function makeStorage(rows = [], { throwOnQuery = false } = {}) {
  return {
    query: () => {
      if (throwOnQuery) throw new Error('db down');
      return rows;
    },
  };
}

function rowFor(location, { at = '2026-09-17T11:59:00.000Z' } = {}) {
  return [{ content_json: JSON.stringify({ userId: SELF, location }), created_at: at }];
}

test('worldIdFromSelfLocation：仅 wrld_ 位置解析出 worldId', () => {
  assert.equal(worldIdFromSelfLocation('wrld_abc:123~hidden(usr_x)~region(jp)'), 'wrld_abc');
  assert.equal(worldIdFromSelfLocation('private'), '');
  assert.equal(worldIdFromSelfLocation('offline:offline'), '');
  assert.equal(worldIdFromSelfLocation(''), '');
  assert.equal(worldIdFromSelfLocation(undefined), '');
});

test('无 selfId → unknown（不做推导，消费方自行取 selfId）', () => {
  const p = resolveSelfPresence(makeStorage(rowFor('wrld_x:1')), { selfId: '', now: NOW });
  assert.equal(p.state, 'unknown');
  assert.equal(p.userId, '');
});

test('无 user-location 记录 → unknown', () => {
  const p = resolveSelfPresence(makeStorage([]), { selfId: SELF, now: NOW });
  assert.equal(p.state, 'unknown');
  assert.equal(p.userId, SELF);
});

test('storage 查询抛错 → unknown（不向上抛）', () => {
  const p = resolveSelfPresence(makeStorage([], { throwOnQuery: true }), { selfId: SELF, now: NOW });
  assert.equal(p.state, 'unknown');
});

test('content_json 非法 JSON → unknown', () => {
  const p = resolveSelfPresence(makeStorage([{ content_json: '{bad', created_at: '2026-09-17T11:59:00.000Z' }]), { selfId: SELF, now: NOW });
  assert.equal(p.state, 'unknown');
});

test('location 非字符串（如 {"location":123}）→ unknown，不抛异常', () => {
  for (const loc of [123, { a: 1 }, ['wrld_x:1'], true]) {
    const rows = [{ content_json: JSON.stringify({ userId: SELF, location: loc }), created_at: '2026-09-17T11:59:00.000Z' }];
    const p = resolveSelfPresence(makeStorage(rows), { selfId: SELF, now: NOW });
    assert.equal(p.state, 'unknown', `location=${JSON.stringify(loc)}`);
    assert.equal(p.location, '', `location=${JSON.stringify(loc)}`);
    assert.equal(p.worldId, '');
  }
  // JSON null 走语言层 `|| ''` → 归为空位置（not_in_game），与重构前实现一致（非本次修复范围）
  const nullRows = [{ content_json: JSON.stringify({ userId: SELF, location: null }), created_at: '2026-09-17T11:59:00.000Z' }];
  // 出游戏确认窗口（issue #218）会把这 60s 的离线判为 unknown；本用例只关注位置归一化，
  // 故显式 offlineGraceMs:0 复用旧语义。窗口本身的行为见文件末尾的专门用例。
  assert.equal(resolveSelfPresence(makeStorage(nullRows), { selfId: SELF, now: NOW, offlineGraceMs: 0 }).state, 'not_in_game');
  // 与旧实现（dashboard.isSelfOnline 被外层 try/catch 兜成 null）三值映射一致
  const rows = [{ content_json: JSON.stringify({ userId: SELF, location: 123 }), created_at: new Date().toISOString() }];
  assert.equal(servicesWith(rows).get('dashboard.isSelfOnline')(), null);
});

test('offline / offline:offline / 空位置：窗口内 → unknown；超过窗口 → not_in_game（服务常驻登录即此态）', () => {
  for (const loc of ['offline', 'offline:offline', '']) {
    // 60s 前（rowFor 默认）仍在确认窗口内 → unknown：消费方不写挂机文案、不翻转判定态
    const fresh = resolveSelfPresence(makeStorage(rowFor(loc)), { selfId: SELF, now: NOW });
    assert.equal(fresh.state, 'unknown', `location=${loc} 窗口内应为 unknown`);
    assert.equal(fresh.location, loc);
    // 超过默认窗口（360s）→ 认定真的离开
    const old = [{ content_json: JSON.stringify({ userId: SELF, location: loc }), created_at: new Date(NOW - 400_000).toISOString() }];
    const stale = resolveSelfPresence(makeStorage(old), { selfId: SELF, now: NOW });
    assert.equal(stale.state, 'not_in_game', `location=${loc} 超窗口应为 not_in_game`);
    assert.equal(stale.location, loc);
  }
});

test('wrld_ 位置且新鲜 → in_game，并带出 worldId', () => {
  const p = resolveSelfPresence(makeStorage(rowFor('wrld_abc:123~hidden(usr_x)~region(jp)')), { selfId: SELF, now: NOW });
  assert.equal(p.state, 'in_game');
  assert.equal(p.worldId, 'wrld_abc');
  assert.equal(p.ageMs, 60 * 1000);
});

test('private / friends / group / local（无 worldId 的实例可见性）→ in_game', () => {
  for (const loc of ['private', 'friends', 'group', 'local']) {
    const p = resolveSelfPresence(makeStorage(rowFor(loc)), { selfId: SELF, now: NOW });
    assert.equal(p.state, 'in_game', `location=${loc}`);
    assert.equal(p.worldId, '');
  }
});

test('traveling（传送中）→ in_game', () => {
  const p = resolveSelfPresence(makeStorage(rowFor('traveling')), { selfId: SELF, now: NOW });
  assert.equal(p.state, 'in_game');
});

test('在游戏态但记录陈旧超阈值 → unknown（不确认"仍在游戏"，消费方保持现状）', () => {
  const stale = new Date(NOW - SELF_PRESENCE_STALE_MS - 1000).toISOString();
  const p = resolveSelfPresence(makeStorage(rowFor('wrld_abc:1', { at: stale })), { selfId: SELF, now: NOW });
  assert.equal(p.state, 'unknown');
  assert.equal(p.location, 'wrld_abc:1');
});

test('staleMs 可注入（阈值边界为包含关系）', () => {
  const at = new Date(NOW - 5000).toISOString();
  const fresh = resolveSelfPresence(makeStorage(rowFor('wrld_abc:1', { at })), { selfId: SELF, now: NOW, staleMs: 5000 });
  assert.equal(fresh.state, 'in_game');
  const stale = resolveSelfPresence(makeStorage(rowFor('wrld_abc:1', { at })), { selfId: SELF, now: NOW, staleMs: 4999 });
  assert.equal(stale.state, 'unknown');
});

test('created_at 不可解析 → unknown（不做无依据的判定）', () => {
  const p = resolveSelfPresence(makeStorage(rowFor('wrld_abc:1', { at: 'not-a-date' })), { selfId: SELF, now: NOW });
  assert.equal(p.state, 'unknown');
});

// ── dashboard 服务语义（重构不破坏现有消费方：events 插件消费 isSelfOnline）──
// 注意：dashboard 服务先经 getSelfUserId 推导 selfId（另一条 SQL），故这里按 SQL 分流应答
function servicesWith(rows) {
  const services = new Map();
  const loader = { services: { set: (k, fn) => services.set(k, fn) }, serviceOwners: new Map() };
  const storage = {
    query: (sql) => (/SELECT user_id FROM events/.test(sql) ? [{ user_id: SELF }] : rows),
  };
  registerDashboardServices(loader, { storage, serverState: {}, api: {} });
  return services;
}

test('dashboard.isSelfOnline 三值映射与重构前一致', () => {
  // 无记录 → null（无法判定）
  assert.equal(servicesWith([]).get('dashboard.isSelfOnline')(), null);
  // 明确离线 → false
  assert.equal(servicesWith(rowFor('offline:offline')).get('dashboard.isSelfOnline')(), false);
  // 在游戏内且新鲜 → true
  const fresh = rowFor('wrld_abc:1', { at: new Date().toISOString() });
  assert.equal(servicesWith(fresh).get('dashboard.isSelfOnline')(), true);
  // 在游戏态但陈旧 → null（保守推迟刷新）
  const stale = rowFor('wrld_abc:1', { at: new Date(Date.now() - SELF_PRESENCE_STALE_MS - 1000).toISOString() });
  assert.equal(servicesWith(stale).get('dashboard.isSelfOnline')(), null);
});

test('dashboard.selfPresence 暴露三态与位置，供插件消费', () => {
  const services = servicesWith(rowFor('wrld_abc:1', { at: new Date().toISOString() }));
  const p = services.get('dashboard.selfPresence')();
  assert.equal(p.state, 'in_game');
  assert.equal(p.worldId, 'wrld_abc');
  assert.equal(typeof p.at, 'string');
});

// ── 出游戏确认窗口（issue #218）────────────────────────────────────
test('确认窗口内：单次离线判 unknown（消费方据此不写挂机文案、不翻转判定态）', () => {
  const AT = new Date(NOW - 30_000).toISOString();   // 离线仅 30s
  const rows = [{ content_json: JSON.stringify({ userId: SELF, location: 'offline:offline' }), created_at: AT }];
  const r = resolveSelfPresence(makeStorage(rows), { selfId: SELF, now: NOW, offlineGraceMs: 360_000 });
  assert.equal(r.state, 'unknown');
});

test('超过确认窗口：判 not_in_game（真出游戏，文案延后但不丢）', () => {
  const AT = new Date(NOW - 400_000).toISOString();   // 离线已 400s > 360s
  const rows = [{ content_json: JSON.stringify({ userId: SELF, location: 'offline:offline' }), created_at: AT }];
  const r = resolveSelfPresence(makeStorage(rows), { selfId: SELF, now: NOW, offlineGraceMs: 360_000 });
  assert.equal(r.state, 'not_in_game');
});

test('窗口设 0：恢复旧行为（单次离线即判出游戏）', () => {
  const AT = new Date(NOW - 1_000).toISOString();
  const rows = [{ content_json: JSON.stringify({ userId: SELF, location: 'offline:offline' }), created_at: AT }];
  const r = resolveSelfPresence(makeStorage(rows), { selfId: SELF, now: NOW, offlineGraceMs: 0 });
  assert.equal(r.state, 'not_in_game');
});

test('readOfflineGraceMs：env 解析与钳制（默认 360s / 上限 3600s / 非法回落）', () => {
  delete process.env.VRC_MONITOR_SELF_PRESENCE_OFFLINE_GRACE_SECONDS;
  assert.equal(readOfflineGraceMs(), 360_000);
  process.env.VRC_MONITOR_SELF_PRESENCE_OFFLINE_GRACE_SECONDS = '60';
  assert.equal(readOfflineGraceMs(), 60_000);
  process.env.VRC_MONITOR_SELF_PRESENCE_OFFLINE_GRACE_SECONDS = '99999';
  assert.equal(readOfflineGraceMs(), 3_600_000);
  process.env.VRC_MONITOR_SELF_PRESENCE_OFFLINE_GRACE_SECONDS = 'abc';
  assert.equal(readOfflineGraceMs(), 360_000);
  delete process.env.VRC_MONITOR_SELF_PRESENCE_OFFLINE_GRACE_SECONDS;
});
