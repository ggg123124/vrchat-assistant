/**
 * test/friend-refresh.test.mjs — 好友资料周期刷新回归（trust_level 自愈 + 变化事件）
 *
 * 背景（2026-09-15 用户报障）：服务纯 WS 驱动 → trust_level 陈旧无自愈
 * （XIAOFANG小芳已升 Trusted User、库内仍停 Known User）。/auth/user/friends 端点
 * 实测硬性只返回 20 个（n/offset 不生效），故采用逐好友 GET /users/{id} 刷新。
 *
 * 断言：①等级变化 → 插入 friend-update trust_level 事件 + 回写新等级（基线更新 →
 *   第二次刷新不再重复报）；②未变化不报；③仅非空字段回写（空值不清空已有）；
 *   ④tags 推导优先（字段滞后/缺失时以 system_trust_* 为准，小芳实测场景）；
 *   ⑤API 失败仅记 WARN 不抛、继续处理；⑥每周期上限（MAX_PER_CYCLE）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refreshFriendList } from '../core/friend-refresh.js';

function userObj(id, { trust, tags, name } = {}) {
  return {
    id, displayName: name || `好友${id.slice(-3)}`, trust_level: trust, tags,
    status: 'active', statusDescription: '', currentAvatarImageUrl: '', bio: 'x', userIcon: '', pronouns: '',
  };
}

function makeCtx({ friends, users, failIds = new Set() }) {
  const events = [];
  const upserts = [];
  const storage = {
    query: () => friends,
    upsertFriend(f) { upserts.push(f); },
    insertEvent(e) { events.push(e); },
  };
  const api = { _request: async (m, url) => {
    const id = decodeURIComponent(url.split('/').pop());
    if (failIds.has(id)) return { status: 500, data: null };
    const u = users.get(id);
    return u ? { status: 200, data: u } : { status: 404, data: null };
  } };
  const rateLimiter = { execute: async (fn) => fn() };
  const logs = [];
  return { ctx: { api, rateLimiter, storage }, events, upserts, logs: (m) => logs.push(m), logsArr: logs };
}

test('等级变化：逐好友 /users/{id} → 事件 + 回写基线（Known → Trusted）', async () => {
  const id = 'usr_xf';
  const { ctx, events, upserts } = makeCtx({
    friends: [{ user_id: id, display_name: 'XIAOFANG小芳', trust_level: 'Known User' }],
    users: new Map([[id, userObj(id, { trust: 'Trusted User' })]]),
  });
  await refreshFriendList(ctx, () => {});
  const tl = events.filter((e) => e.type === 'friend-update' && e.contentJson && e.contentJson.type === 'trust_level');
  assert.equal(tl.length, 1);
  assert.equal(tl[0].contentJson.previousTrustLevel, 'Known User');
  assert.equal(tl[0].contentJson.trustLevel, 'Trusted User');
  assert.equal(upserts[0].trustLevel, 'Trusted User');
});

test('第二次刷新（基线已更新）不再重复报等级变化', async () => {
  const id = 'usr_a';
  const friendRow = { user_id: id, display_name: 'A', trust_level: 'Known User' };
  const users = new Map([[id, userObj(id, { trust: 'Trusted User' })]]);
  const { ctx, events } = makeCtx({ friends: [friendRow], users });
  await refreshFriendList(ctx, () => {});
  friendRow.trust_level = 'Trusted User';   // 基线已更新（upsert 回写后）
  await refreshFriendList(ctx, () => {});
  const tl = events.filter((e) => e.type === 'friend-update' && e.contentJson && e.contentJson.type === 'trust_level');
  assert.equal(tl.length, 1, '仅第一次产生 1 条');
});

test('未变化：不产生事件', async () => {
  const id = 'usr_a';
  const { ctx, events } = makeCtx({
    friends: [{ user_id: id, display_name: 'A', trust_level: 'Trusted User' }],
    users: new Map([[id, userObj(id, { trust: 'Trusted User' })]]),
  });
  await refreshFriendList(ctx, () => {});
  assert.equal(events.filter((e) => e.type === 'friend-update' && e.contentJson && e.contentJson.type === 'trust_level').length, 0);
});

test('tags 推导优先：veteran 徽章 = 现行 Trusted User（VRChat 已移除 Veteran 等级）', async () => {
  const id = 'usr_xf';
  const { ctx, events, upserts } = makeCtx({
    friends: [{ user_id: id, display_name: 'XIAOFANG小芳', trust_level: 'Known User' }],
    // trust_level 字段滞后报 Known User；tags 含 trusted + veteran（遗留徽章）→ 应显示 Trusted User
    users: new Map([[id, userObj(id, { trust: 'Known User', tags: ['system_trust_trusted', 'system_trust_veteran'] })]]),
  });
  await refreshFriendList(ctx, () => {});
  const tl = events.filter((e) => e.type === 'friend-update' && e.contentJson && e.contentJson.type === 'trust_level');
  assert.equal(tl.length, 1);
  assert.equal(tl[0].contentJson.trustLevel, 'Trusted User');
  assert.equal(upserts[0].trustLevel, 'Trusted User');
});

test('空字段不回写（不清空已有值）', async () => {
  const id = 'usr_a';
  const { ctx, upserts } = makeCtx({
    friends: [{ user_id: id, display_name: 'A', trust_level: '' }],
    users: new Map([[id, userObj(id, { trust: 'Trusted User' })]]),
  });
  // 覆盖为全空 profile（bio/status 等皆空 → 不应写入）
  const users = new Map([[id, { id, displayName: 'A', trust_level: 'Trusted User', tags: [], status: '', statusDescription: '', currentAvatarImageUrl: '', bio: '', userIcon: '', pronouns: '' }]]);
  const { ctx: ctx2, upserts: upserts2 } = makeCtx({ friends: [{ user_id: id, display_name: 'A', trust_level: '' }], users });
  await refreshFriendList(ctx2, () => {});
  const u = upserts2[0];
  assert.equal(u.trustLevel, 'Trusted User');
  assert.equal('status' in u, false);
  assert.equal('bio' in u, false);
});

test('API 失败：记警告、不抛、继续处理其余好友', async () => {
  const a = 'usr_a', b = 'usr_b';
  const { ctx, logsArr, upserts } = makeCtx({
    friends: [{ user_id: a, display_name: 'A', trust_level: 'Known User' }, { user_id: b, display_name: 'B', trust_level: 'Known User' }],
    users: new Map([[a, userObj(a, { trust: 'Trusted User' })], [b, userObj(b, { trust: 'Trusted User' })]]),
    failIds: new Set([a]),
  });
  await refreshFriendList(ctx, (m) => logsArr.push(m));
  assert.ok(logsArr.some((l) => l.includes('[警告]')), '应有警告日志: ' + JSON.stringify(logsArr));
  assert.equal(upserts.length, 1, '失败的好友跳过、其余继续; 实际 upserts=' + JSON.stringify(upserts));
});

test('每周期上限：MAX 截断', async () => {
  const friends = Array.from({ length: 5 }, (_, i) => ({ user_id: `usr_${i}`, display_name: `F${i}`, trust_level: 'Known User' }));
  const users = new Map(friends.map((f) => [f.user_id, userObj(f.user_id, { trust: 'Trusted User' })]));
  const { ctx, upserts, logsArr } = makeCtx({ friends, users });
  const old = process.env.VRC_MONITOR_FRIEND_REFRESH_MAX;
  process.env.VRC_MONITOR_FRIEND_REFRESH_MAX = '2';
  try {
    await refreshFriendList(ctx, (m) => logsArr.push(m));
  } finally {
    if (old === undefined) delete process.env.VRC_MONITOR_FRIEND_REFRESH_MAX; else process.env.VRC_MONITOR_FRIEND_REFRESH_MAX = old;
  }
  assert.equal(upserts.length, 2);
  assert.ok(logsArr.some((l) => l.includes('2/5 位')));
});
