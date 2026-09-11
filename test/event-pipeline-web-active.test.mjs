/**
 * event-pipeline-web-active.test.mjs — 网页端在线 friend-active 处理回归
 *
 * 背景(2026-09-10 用户实测 bug):好友转网页端在线时 VRChat 不发 friend-offline,
 * 只发 platform=web 的 friend-active——处理器必须把 platform/location 真值落库并清
 * 残留世界,否则 friends 表保留最后进房世界,dashboard 假显示「在某世界」。
 * 自包含:mock storage 记录 upsertFriend 调用,不依赖真实 VRChat 凭据。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventPipeline } from '../core/event-pipeline.js';

function makePipeline() {
  const upserts = [];
  const events = [];
  const storage = {
    upsertFriend(f) { upserts.push(f); },
    insertEvent(e) { events.push(e); },
  };
  const pipeline = new EventPipeline(storage, { get: () => null });
  return { pipeline, upserts, events };
}

const WEB_ACTIVE = {
  type: 'friend-active',
  userId: 'usr_test',
  displayName: '测试网页在线好友',
  platform: 'web',
  receivedAt: '2026-09-10T13:35:39.557Z',
  content: { userId: 'usr_test', platform: 'web' },
};

const GAME_ACTIVE = {
  type: 'friend-active',
  userId: 'usr_test2',
  displayName: '测试游戏在线好友',
  platform: 'standalonewindows',
  receivedAt: '2026-09-10T13:35:39.557Z',
  content: { userId: 'usr_test2', platform: 'standalonewindows' },
};

test('platform=web → 落 platform/location=offline 并清残留世界', async () => {
  const { pipeline, upserts } = makePipeline();
  await pipeline.process({ ...WEB_ACTIVE });
  assert.strictEqual(upserts.length, 1);
  assert.strictEqual(upserts[0].platform, 'web');
  assert.strictEqual(upserts[0].location, 'offline');
  assert.strictEqual(upserts[0].worldId, '');
  assert.strictEqual(upserts[0].worldName, '');
  assert.strictEqual(upserts[0].isOnline, true);
});

test('platform=游戏端 → 保持原行为(不动 location/platform)', async () => {
  const { pipeline, upserts } = makePipeline();
  await pipeline.process({ ...GAME_ACTIVE });
  assert.strictEqual(upserts.length, 1);
  assert.strictEqual(upserts[0].platform, undefined);
  assert.strictEqual(upserts[0].location, undefined);
  assert.strictEqual(upserts[0].isOnline, true);
});

test('web-active 事件本身仍落 events 表', async () => {
  const { pipeline, events } = makePipeline();
  await pipeline.process({ ...WEB_ACTIVE });
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].type, 'friend-active');
});
