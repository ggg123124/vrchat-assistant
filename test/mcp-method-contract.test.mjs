/**
 * mcp-method-contract.test.mjs — /mcp 的 HTTP 方法契约（用户实测刷屏回归）
 *
 * 背景（2026-09-13 群友反馈）：日志被「GET stream disconnected, reconnecting in 1000ms...」刷屏。
 * 该行来自 MCP Python SDK 客户端（mcp.client.streamable_http）；服务端 GET /mcp 曾返回
 * 200 + text/event-stream + 立即 end → SDK 的 handle_get_stream 判定流断开后把 attempt 归零
 * → 每 1000ms 无限重连（合规行为：405 会计入尝试，上限 2 次后停止）。
 * 本测试锁定：GET /mcp 必须 405（不提供 server→client 流），POST 仍为正常请求通道。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from '../core/http-server.js';
import { ctx } from '../core/server-context.js';
import { RateLimiter } from '../core/rate-limiter.js';

async function withServer(fn) {
  // 本测试只验证 HTTP 方法契约：清掉 .env 载入的 token，走「未配置 token」的开发态（fail-open），
  // 否则 #159 的 fail-closed（token 已配置但无 http.authenticate 服务）会把请求拦成 401。
  delete process.env.VRC_MONITOR_AUTH_TOKEN;
  delete process.env.VRC_MONITOR_API_KEY;
  ctx.storage = { getStats: () => ({ events: 1, friends: 1, world_cache: 0 }) };
  ctx.rateLimiter = new RateLimiter();
  ctx.serverState = { started: Date.now(), authUser: null, needsOtp: false, needsTotp: false };
  ctx.paths = { PORT: 0, HOST: '127.0.0.1' };
  ctx.httpRoutes = new Map();
  // hasService 恒 false：既不触发 fail-closed（token 已清），也不进入 http.authenticate 分支
  ctx.pluginLoader = { getStatus: () => [], hasService: () => false, consume: () => ({ token: null }) };
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const request = (path, options = {}) => new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${port}${path}`, options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, data, headers: res.headers }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
  try { return await fn(request); } finally { await new Promise((r) => server.close(r)); }
}

test('GET /mcp 返回 405（不提供 server→client SSE 流，避免客户端无限重连刷屏）', async () => {
  await withServer(async (request) => {
    const res = await request('/mcp', { method: 'GET' });
    assert.equal(res.status, 405, 'GET /mcp 必须是 405（规范二选一：长连 SSE 或 405）');
    assert.match(String(res.headers.allow || ''), /POST/, 'Allow 头应声明可用方法');
    assert.equal(res.headers['content-type'], 'application/json');
  });
});

test('DELETE /mcp 返回 204（会话终止，SDK 关闭连接时调用）', async () => {
  await withServer(async (request) => {
    const res = await request('/mcp', { method: 'DELETE' });
    assert.equal(res.status, 204);
  });
});

test('POST /mcp 仍正常（initialize → SSE + Mcp-Session-Id，GET 的改动未伤请求通道）', async () => {
  await withServer(async (request) => {
    const res = await request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type'] || ''), /text\/event-stream/);
    assert.ok(res.headers['mcp-session-id'], '应下发会话 id（客户端据此决定是否开 GET 流）');
    assert.match(res.data, /"result"/);
  });
});
