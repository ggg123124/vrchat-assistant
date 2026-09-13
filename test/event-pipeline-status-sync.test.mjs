/**
 * event-pipeline-status-sync.test.mjs — 事件状态落库回归
 *
 * 背景(2026-09-13 用户实测 bug):_handleOnline 曾硬编码 status:'active'——好友上线事件
 * 把实际状态(ask me=橙灯)无条件覆盖成 active(绿灯),网页端灯色与真值不符。
 * 另:friend-update 在 user 对象缺失时只记录事件、状态变更不落库。
 * 自包含:mock storage 记录 upsertFriend 载荷。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventPipeline } from '../core/event-pipeline.js';

function makePipeline() {
  const upserts = [];
  const storage = {
    upsertFriend(f) { upserts.push(f); },
    insertEvent() {},
    getFriend: () => null,
    getWorldName: () => ({ name: '', author_name: '', author_id: '' }),
    upsertWorld: () => {},
    query: () => [],
    run: () => {},
  };
  return { pipeline: new EventPipeline(storage, { get: () => null }), upserts };
}

const USER_ASKME = {
  id: 'usr_test', displayName: '测试好友', status: 'ask me', statusDescription: '我挂机',
  bio: '', userIcon: '', pronouns: '', currentAvatarImageUrl: '',
};
const ONLINE_EV = {
  type: 'friend-online', userId: 'usr_test', displayName: '测试好友',
  platform: 'standalonewindows', location: 'private', worldId: 'private',
  receivedAt: '2026-09-13T01:40:16.000Z', content: { userId: 'usr_test', platform: 'standalonewindows', location: 'private', worldId: 'private', user: USER_ASKME },
};

test('friend-online 不再把状态硬编码为 active，而是落事件真值 ask me', async () => {
  const { pipeline, upserts } = makePipeline();
  await pipeline.process({ ...ONLINE_EV });
  const statusWrites = upserts.map((u) => u.status).filter((v) => v !== undefined);
  assert.ok(statusWrites.length > 0, '应有状态写入');
  assert.ok(!statusWrites.includes('active'), '不得再出现硬编码 active（实际状态是 ask me）');
  assert.ok(statusWrites.includes('ask me'), '应落事件真值 ask me');
});

test('friend-online 的 user 对象资料字段一并回写（昵称/签名）', async () => {
  const { pipeline, upserts } = makePipeline();
  await pipeline.process({ ...ONLINE_EV });
  const merged = Object.assign({}, ...upserts);
  assert.equal(merged.status, 'ask me');
  assert.equal(merged.statusDescription, '我挂机');
  assert.equal(merged.displayName, '测试好友');
});

test('friend-active(web) 同样落状态真值（网页端在线时的状态不被清）', async () => {
  const { pipeline, upserts } = makePipeline();
  await pipeline.process({
    type: 'friend-active', userId: 'usr_test', displayName: '测试好友', platform: 'web',
    receivedAt: '2026-09-13T01:39:41.000Z', content: { userId: 'usr_test', platform: 'web', user: USER_ASKME },
  });
  const merged = Object.assign({}, ...upserts);
  assert.equal(merged.status, 'ask me');
  assert.equal(merged.platform, 'web');
});

test('事件缺 user 对象时不覆盖已有状态（部分 upsert 不写 status）', async () => {
  const { pipeline, upserts } = makePipeline();
  await pipeline.process({
    type: 'friend-online', userId: 'usr_test', displayName: '测试好友', platform: 'standalonewindows',
    location: 'wrld_x:1~region(jp)', worldId: 'wrld_x', receivedAt: '2026-09-13T02:00:00.000Z', content: {},
  });
  const statusWrites = upserts.map((u) => u.status).filter((v) => v !== undefined);
  assert.equal(statusWrites.length, 0, '无 user 对象时不应写 status');
});
