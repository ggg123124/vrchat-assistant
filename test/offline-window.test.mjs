/**
 * test/offline-window.test.mjs — 对账补记离线的窗口下界（2026-09-21 用户报障回流）
 *
 * 回归场景：一次 2 秒 WS 瞬断被当成窗口起点 → 显示「离线（03:15 ~ 07:50）」4.5 小时，
 * 用户读成「服务掉线 4.5 小时」。实际服务全程在对账，真正确定离线是 07:50。
 * 断言：窗口下界取「最后一次能证明他在线的时刻」，而不是那次瞬断。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickOfflineWindowStart } from '../core/offline-window.js';

test('回归：2 秒瞬断不得被当成窗口起点（取更晚的"最后一次确认在线"）', () => {
  const got = pickOfflineWindowStart({
    disconnectedAt: '2026-09-20T19:15:26.061Z', // 03:15 本地那次瞬断
    lastSeen: '2026-09-20T23:23:43.665Z',       // 该好友 07:23 的 friend-active
    lastOnlineSeen: '2026-09-20T23:45:38.678Z', // 07:45 对账时他还在在线集合
  });
  assert.equal(got, '2026-09-20T23:45:38.678Z', '应取三者中最大（07:45），窗口缩到分钟级');
  assert.notEqual(got, '2026-09-20T19:15:26.061Z');
});

test('三者取最大：只有 lastSeen 时用它', () => {
  assert.equal(pickOfflineWindowStart({ lastSeen: '2026-09-20T23:23:43.665Z' }), '2026-09-20T23:23:43.665Z');
});

test('真断线场景仍可用：断线时刻更晚时取它', () => {
  const got = pickOfflineWindowStart({
    disconnectedAt: '2026-09-20T23:40:00.000Z',
    lastSeen: '2026-09-20T23:23:43.665Z',
  });
  assert.equal(got, '2026-09-20T23:40:00.000Z', '断线窗口更晚时（真实的断线期间）应取断线时刻');
});

test('无可用下界时返回空串（由调用方决定兜底文案）', () => {
  assert.equal(pickOfflineWindowStart({}), '');
  assert.equal(pickOfflineWindowStart({ lastSeen: '   ', lastOnlineSeen: undefined }), '');
});
