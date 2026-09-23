import test from 'node:test';
import assert from 'node:assert/strict';

// issue #247：应用层静默检测的单测（用极短阈值 + 直接构造实例，不建立真实连接）
// 覆盖：超阈值 ⇒ 记 warn + 触发重连；阈值内 ⇒ 不触发；未连接/无计时 ⇒ 不触发。
process.env.VRC_MONITOR_WS_SILENT_RECONNECT_MS = '50';

const { WsManager } = await import('../core/ws-manager.js');

function makeManager() {
  const m = new WsManager({ apiClient: {}, onEvent: () => {}, onStatusChange: () => {} });
  let reconnects = 0;
  m.forceReconnect = async () => { reconnects += 1; };
  return { m, count: () => reconnects };
}

test('静默超过阈值 ⇒ 触发一次重连并返回 true', () => {
  const { m, count } = makeManager();
  m.status = 'connected';
  m.lastMessageAt = Date.now() - 200;   // 阈值 50ms
  assert.equal(m._checkSilent(), true);
  assert.equal(count(), 1);
});

test('阈值内 ⇒ 不触发', () => {
  const { m, count } = makeManager();
  m.status = 'connected';
  m.lastMessageAt = Date.now() - 5;
  assert.equal(m._checkSilent(), false);
  assert.equal(count(), 0);
});

test('未连接或没有计时起点 ⇒ 不触发（不会误伤空闲连接）', () => {
  const a = makeManager();
  a.m.status = 'reconnecting';
  a.m.lastMessageAt = Date.now() - 500;
  assert.equal(a.m._checkSilent(), false);
  const b = makeManager();
  b.m.status = 'connected';
  b.m.lastMessageAt = null;
  assert.equal(b.m._checkSilent(), false);
  assert.equal(a.count() + b.count(), 0);
});