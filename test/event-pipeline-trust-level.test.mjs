/**
 * event-pipeline-trust-level.test.mjs — 好友信任等级变更跟踪回归
 *
 * 背景（2026-09-15 用户报障）：好友资料五类变更（avatar/bio/status/user_icon/pronouns）
 * 都有 diff 与回写，唯独漏了 trust_level——好友等级变化既不产生 friend-update 事件，
 * 基线也永远不更新（生产实证 XIAOFANG小芳已升 Trusted User、库内仍停 Known User）。
 *
 * 断言：① diff 到 trust_level 变化时插入 friend-update 事件（contentJson.type=trust_level、
 *   带新旧值）；② 回写 upsertFriend 带 trustLevel（基线更新 → 后续不再重复报）；
 *   ③ 未变化的等级不产生事件；④ 无基线（prev 无 trust_level）时不误报。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventPipeline } from '../core/event-pipeline.js';

function makePipeline(prevFriend) {
  const events = [];
  const upserts = [];
  const storage = {
    upsertFriend(f) { upserts.push(f); },
    insertEvent(ev) { events.push(ev); },
    getFriend: () => prevFriend || null,
    getWorldName: () => ({ name: '', author_name: '', author_id: '' }),
    upsertWorld: () => {},
    query: () => [],
    run: () => {},
  };
  return { pipeline: new EventPipeline(storage, { get: () => null }), events, upserts };
}

const BASE_USER = {
  id: 'usr_xiaofang', displayName: 'XIAOFANG小芳', status: 'active', statusDescription: '',
  bio: '', userIcon: '', pronouns: '', currentAvatarImageUrl: '',
};

test('等级变化：插入 trust_level 事件 + 回写基线（Known User → Trusted User）', async () => {
  const prev = { user_id: 'usr_xiaofang', display_name: 'XIAOFANG小芳', trust_level: 'Known User', status: 'active', status_description: '', bio: '', user_icon: '', pronouns: '', avatar_image_url: '' };
  const { pipeline, events, upserts } = makePipeline(prev);
  await pipeline.process({
    type: 'friend-update', userId: 'usr_xiaofang', displayName: 'XIAOFANG小芳',
    receivedAt: '2026-09-15T13:26:00.000Z',
    // tag→名称口径见 ui/src/utils.js:165：trusted=Known User、veteran/legend=Trusted User（#222 审核 🔴2 纠正）
    content: { userId: 'usr_xiaofang', user: { ...BASE_USER, tags: ['system_trust_veteran'] } },
  });
  const tl = events.filter((e) => e.type === 'friend-update' && e.contentJson && e.contentJson.type === 'trust_level');
  assert.equal(tl.length, 1, '应恰好插入一条 trust_level 事件');
  assert.equal(tl[0].contentJson.previousTrustLevel, 'Known User');
  assert.equal(tl[0].contentJson.trustLevel, 'Trusted User');
  const lastUpsert = Object.assign({}, ...upserts);
  assert.equal(lastUpsert.trustLevel, 'Trusted User', '回写应带新等级（基线更新）');
});

test('等级未变化：不产生 trust_level 事件', async () => {
  const prev = { user_id: 'usr_xiaofang', display_name: 'XIAOFANG小芳', trust_level: 'Trusted User', status: 'active', status_description: '', bio: '', user_icon: '', pronouns: '', avatar_image_url: '' };
  const { pipeline, events } = makePipeline(prev);
  await pipeline.process({
    type: 'friend-update', userId: 'usr_xiaofang', displayName: 'XIAOFANG小芳',
    receivedAt: '2026-09-15T13:30:00.000Z',
    content: { userId: 'usr_xiaofang', user: { ...BASE_USER, trust_level: 'Trusted User' } },
  });
  assert.equal(events.filter((e) => e.type === 'friend-update' && e.contentJson && e.contentJson.type === 'trust_level').length, 0);
});

test('无基线（首次采集 prev 无 trust_level）：不误报', async () => {
  const prev = { user_id: 'usr_xiaofang', display_name: 'XIAOFANG小芳', trust_level: '', status: 'active', status_description: '', bio: '', user_icon: '', pronouns: '', avatar_image_url: '' };
  const { pipeline, events } = makePipeline(prev);
  await pipeline.process({
    type: 'friend-update', userId: 'usr_xiaofang', displayName: 'XIAOFANG小芳',
    receivedAt: '2026-09-15T13:32:00.000Z',
    content: { userId: 'usr_xiaofang', user: { ...BASE_USER, trust_level: 'Trusted User' } },
  });
  assert.equal(events.filter((e) => e.type === 'friend-update' && e.contentJson && e.contentJson.type === 'trust_level').length, 0);
});

test('WS 载荷缺 tags：不得用载荷 trust_level 回落（2026-09-22 天天刷振荡回归）', async () => {
  const prev = { user_id: 'usr_xiaofang', display_name: 'XIAOFANG小芳', trust_level: 'Trusted User', status: 'active', status_description: '', bio: '', user_icon: '', pronouns: '', avatar_image_url: '' };
  const { pipeline, events, upserts } = makePipeline(prev);
  // 缺 tags、只带过时的 trust_level=Known User：旧逻辑会据此把库里已升的 Trusted User 覆盖回去，
  // 于是 6 小时后的权威轮询（逐好友 GET /users/{id} 按 tags 推导）又报一次「升到 Trusted User」→ 每天刷一条。
  await pipeline.process({
    type: 'friend-update', userId: 'usr_xiaofang', displayName: 'XIAOFANG小芳',
    receivedAt: '2026-09-22T08:37:00.000Z',
    content: { userId: 'usr_xiaofang', user: { ...BASE_USER, trust_level: 'Known User' } },
  });
  const tl = events.filter((e) => e.contentJson && e.contentJson.type === 'trust_level');
  assert.equal(tl.length, 0, '缺 tags 时不得凭 trust_level 字段判定等级变化');
  const wrote = upserts.filter((u) => 'trustLevel' in u);
  assert.equal(wrote.length, 0, '缺 tags 时不得回写 trustLevel（否则会把权威值写坏）');
});
