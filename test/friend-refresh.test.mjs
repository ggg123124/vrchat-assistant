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
import { refreshFriendList, trustFromTags } from '../core/friend-refresh.js';

function userObj(id, { trust, tags, name } = {}) {
  return {
    id, displayName: name || `好友${id.slice(-3)}`, trust_level: trust, tags,
    status: 'active', statusDescription: '', currentAvatarImageUrl: '', bio: 'x', userIcon: '', pronouns: '',
  };
}

function makeCtx({ friends, users, failIds = new Set(), profiles = new Map(), profileFailIds = new Set() }) {
  const events = [];
  const upserts = [];
  const storage = {
    query: () => friends,
    upsertFriend(f) { upserts.push(f); },
    insertEvent(e) { events.push(e); },
  };
  const api = { _request: async (m, url) => {
    // 简介走独立端点 GET /profile/{id}（2026-10-07：上游把 bio 移出了 user 对象）
    if (String(url).startsWith('/profile/')) {
      const pid = decodeURIComponent(String(url).slice('/profile/'.length));
      if (profileFailIds.has(pid)) return { status: 500, data: null };
      const p = profiles.get(pid);
      return p ? { status: 200, data: p } : { status: 404, data: null };
    }
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
    users: new Map([[id, userObj(id, { trust: 'Trusted User', tags: ['system_trust_veteran'] })]]),
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
  const users = new Map([[id, userObj(id, { trust: 'Trusted User', tags: ['system_trust_veteran'] })]]);
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
    users: new Map([[id, userObj(id, { trust: 'Trusted User', tags: ['system_trust_veteran'] })]]),
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
    users: new Map([[id, userObj(id, { trust: 'Trusted User', tags: ['system_trust_veteran'] })]]),
  });
  // 覆盖为全空 profile（bio/status 等皆空 → 不应写入）
  const users = new Map([[id, { id, displayName: 'A', trust_level: 'Trusted User', tags: [], status: '', statusDescription: '', currentAvatarImageUrl: '', bio: '', userIcon: '', pronouns: '' }]]);
  const { ctx: ctx2, upserts: upserts2 } = makeCtx({ friends: [{ user_id: id, display_name: 'A', trust_level: '' }], users });
  await refreshFriendList(ctx2, () => {});
  const u = upserts2[0];
  // #222 审核 ⚠️：poll 路径与 WS 路径统一为「缺 tags 即未知」——tags 为空时**不得**回落到
  // 载荷里的 trust_level 字段（否则会把权威值改回旧值、产生假变更事件）。
  assert.ok(!('trustLevel' in u), '缺 tags 时不得回写 trustLevel');
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


test('tag→名称映射与 VRCX/仓库既有口径一致（#222 审核 ⚠️1：防止被静默改回）', () => {
  // 变异实验证据：把映射改回旧的两行错值后，参数化用例全绿 ⇒ 必须用表驱动逐一钉住。
  // 权威口径：ui/src/utils.js:165 注释 + start-monitor.js inferTrustFromTags + VRCX computeTrustLevel。
  const cases = [
    [['system_trust_basic'], 'New User'],
    [['system_trust_known'], 'User'],
    [['system_trust_trusted'], 'Known User'],
    [['system_trust_veteran'], 'Trusted User'],
    [['system_trust_legend'], 'Trusted User'],
    [['system_trust_trusted', 'system_trust_veteran'], 'Trusted User'],   // 多 tag 取最高档
    [['foo', 'bar'], ''],                                                   // 非信任 tag → 空
    [[], ''],
  ];
  for (const [tags, want] of cases) {
    assert.equal(trustFromTags(tags), want, 'tags=' + tags.join(','));
  }
});

// ── 简介（bio）刷新：2026-10-07 用户报障「简介变更全是已清空」 ──
// 上游新版资料系统把 bio 移出 user 对象（WS 与 /users/{id} 均无该键，实测），权威来源＝GET /profile/{userId}。
// 故周期刷新补一次 profile 拉取：**有 bio 键**才 diff/回写；有基线且变化 ⇒ 记 type='bio' 事件。
const bioEvents = (events) => events.filter((e) => e.type === 'friend-update' && e.contentJson && e.contentJson.type === 'bio');

test('简介变化：/profile 的 bio 与基线不同 ⇒ 记 bio 事件 + 回写（真值来自 profile 端点）', async () => {
  const id = 'usr_bio_a';
  const { ctx, events, upserts } = makeCtx({
    friends: [{ user_id: id, display_name: '好友B', trust_level: '', bio: '老简介' }],
    users: new Map([[id, userObj(id, { trust: 'Known User', tags: ['system_trust_known'] })]]),
    profiles: new Map([[id, { id, displayName: '好友B', bio: '新简介' }]]),
  });
  await refreshFriendList(ctx, () => {});
  const be = bioEvents(events);
  assert.equal(be.length, 1, '简介变化必须记录');
  assert.equal(be[0].contentJson.bio, '新简介');
  assert.equal(be[0].contentJson.previousBio, '老简介');
  assert.equal(be[0].source, 'poll');
  assert.equal(upserts[0].bio, '新简介', '回写新简介作基线');
});

test('简介未变 ⇒ 不记事件', async () => {
  const id = 'usr_bio_b';
  const { ctx, events } = makeCtx({
    friends: [{ user_id: id, display_name: 'B', trust_level: '', bio: '一样' }],
    users: new Map([[id, userObj(id, { trust: 'Known User', tags: ['system_trust_known'] })]]),
    profiles: new Map([[id, { id, displayName: 'B', bio: '一样' }]]),
  });
  await refreshFriendList(ctx, () => {});
  assert.equal(bioEvents(events).length, 0);
});

test('profile 响应无 bio 键（兼容/旧账号）⇒ 不记、不写（保留基线，不误判为清空）', async () => {
  const id = 'usr_bio_c';
  const { ctx, events, upserts } = makeCtx({
    friends: [{ user_id: id, display_name: 'C', trust_level: '', bio: '老简介' }],
    users: new Map([[id, userObj(id, { trust: 'Known User', tags: ['system_trust_known'] })]]),
    profiles: new Map([[id, { id, displayName: 'C' }]]),
  });
  await refreshFriendList(ctx, () => {});
  assert.equal(bioEvents(events).length, 0, '缺 bio 键＝未知，不得当成变化');
  assert.equal('bio' in upserts[0], false, '缺 bio 键时不得写 bio 列（否则清空已存基线）');
});

test('profile 拉取失败 ⇒ 仅 WARN，不影响等级/其它字段刷新', async () => {
  const id = 'usr_bio_d';
  const { ctx, logsArr, upserts } = makeCtx({
    friends: [{ user_id: id, display_name: 'D', trust_level: 'Known User', bio: '老简介' }],
    users: new Map([[id, userObj(id, { trust: 'Trusted User', tags: ['system_trust_veteran'] })]]),
    profileFailIds: new Set([id]),
  });
  await refreshFriendList(ctx, (m) => logsArr.push(m));
  assert.ok(logsArr.some((l) => l.includes('好友简介刷新失败')), '应有简介拉取失败告警');
  assert.equal(upserts[0].trustLevel, 'Trusted User', '简介失败不影响等级回写');
  assert.equal('bio' in upserts[0], false, '失败时不得写 bio');
});

test('显式清空（profile 返回 bio:""）⇒ 记录为清空（真实变更）', async () => {
  const id = 'usr_bio_e';
  const { ctx, events } = makeCtx({
    friends: [{ user_id: id, display_name: 'E', trust_level: '', bio: '老简介' }],
    users: new Map([[id, userObj(id, { trust: 'Known User', tags: ['system_trust_known'] })]]),
    profiles: new Map([[id, { id, displayName: 'E', bio: '' }]]),
  });
  await refreshFriendList(ctx, () => {});
  const be = bioEvents(events);
  assert.equal(be.length, 1, 'profile 权威返回空 bio ⇒ 真·清空，应记录');
  assert.equal(be[0].contentJson.bio, '');
});