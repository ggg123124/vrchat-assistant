// 「在线好友数」计数口径的行为断言（PR #253）
//
// 为什么需要它：VRChat 转网页/移动端在线时 location='offline'、platform='web'，
// 旧口径"只看有有效 location"会把这些人算成离线 ⇒ 状态文案与 get_online_friends 比好友列表少一截。
// 这些断言直接 import 生产纯函数；把口径改回"只看 location"会变红。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readOnlineCountIncludeWeb, isOnlineForCount } from '../core/online-count-policy.js';

test('开关：未设 / 空串 ⇒ 默认计入（不能因为读不到 env 就静默改成不计入）', () => {
  assert.equal(readOnlineCountIncludeWeb({}), true);
  assert.equal(readOnlineCountIncludeWeb({ VRC_MONITOR_ONLINE_INCLUDE_WEB: '' }), true);
  assert.equal(readOnlineCountIncludeWeb({ VRC_MONITOR_ONLINE_INCLUDE_WEB: '   ' }), true);
});

test('开关：1/true 类真值 ⇒ 计入；显式 0 ⇒ 关闭', () => {
  assert.equal(readOnlineCountIncludeWeb({ VRC_MONITOR_ONLINE_INCLUDE_WEB: '1' }), true);
  assert.equal(readOnlineCountIncludeWeb({ VRC_MONITOR_ONLINE_INCLUDE_WEB: 'true' }), true);
  assert.equal(readOnlineCountIncludeWeb({ VRC_MONITOR_ONLINE_INCLUDE_WEB: '0' }), false);
});

test('游戏内在线（有有效 location）⇒ 一定算在线', () => {
  assert.equal(isOnlineForCount({ location: 'wrld_abc:12345~region(us)', platform: 'standalonewindows' }, true), true);
  assert.equal(isOnlineForCount({ location: 'wrld_abc:12345~region(us)', platform: 'standalonewindows' }, false), true);
});

test('网页端在线（location=offline + platform=web）⇒ 开关打开时算在线', () => {
  assert.equal(isOnlineForCount({ location: 'offline', platform: 'web' }, true), true);
});

test('网页端在线 + 开关关闭 ⇒ 不算在线（开关真的生效）', () => {
  assert.equal(isOnlineForCount({ location: 'offline', platform: 'web' }, false), false);
});

test('无位置 / 空记录（issue #114 的 active-但无位置用户）⇒ 不算在线', () => {
  assert.equal(isOnlineForCount({ location: '', platform: 'standalonewindows' }, true), false);
  assert.equal(isOnlineForCount({}, true), false);
  assert.equal(isOnlineForCount(null, true), false);
});

test('平台是 offline 字符串（离线占位）⇒ 不算在线', () => {
  assert.equal(isOnlineForCount({ location: 'offline', platform: 'offline' }, true), false);
});
