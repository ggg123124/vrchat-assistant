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


// issue #247 评审 🔴：stop() 必须在 close 前摘掉 handler —— 否则迟到的 close 会触发
// _onClose ⇒ _scheduleReconnect，多排一次 _connect（两条连接同时存活、事件双投）。
test('stop() 会摘掉当前 socket 的 handler（防迟到 close 多排重连）', () => {
  const m = new WsManager({ apiClient: {}, onEvent: () => {}, onStatusChange: () => {} });
  let removed = 0;
  let closed = 0;
  m.ws = {
    readyState: 1,
    close() { closed += 1; },
    removeAllListeners() { removed += 1; },
    ping() {},
    terminate() {},
    on() {},
  };
  m.stop();
  assert.equal(removed, 1, 'socket 的 handler 应被摘掉');
  assert.equal(closed, 1, 'socket 仍应被关闭');
});

// 评审 ⚠️1：真正驱动 _onOpen() 的回归护栏。
// 上一版第 3 例只是把「无计时起点」当预期行为断言 —— 把 _onOpen 里的赋值移除后它照样绿（被突变测试证伪）。
test('回归：_onOpen() 必须真正开始计时（否则首个连接零消息时静默检测永不触发）', () => {
  const { m } = makeManager();
  try { m._onOpen(); } catch { /* 测试环境无完整上下文；赋值在第一行已完成 */ }
  try { m._clearHeartbeat(); } catch { /* 清掉 30s 定时器，避免测试进程挂住 */ }
  assert.ok(m.lastMessageAt, '_onOpen() 应设置 lastMessageAt');
  assert.notEqual(m.getState().silentForSec, null, 'getState() 应能输出 silentForSec（不是 null）');
});