/**
 * HTTP 服务器 — MCP SSE 端点 + 健康检查
 *
 * 提供 McpSession 管理、SSE 响应辅助、HTTP 服务器创建与请求路由。
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { ctx, log } from './server-context.js';
import { getLogger } from './logger.js';
import * as registry from './registry.js';

// 命名日志：MCP 协议层（JSON-RPC 往返），请求日志默认降为 debug 级避免 ping/keepalive 刷屏
const logMCP = getLogger('mcp');
const logApp = getLogger('app');

// ── MCP 会话管理 ──
const sessions = new Map();

class McpSession {
  constructor() {
    this.id = randomUUID();
    this.initialized = false;
  }
}

function getOrCreateSession(sessionId) {
  if (!sessionId || !sessions.has(sessionId)) {
    const s = new McpSession();
    sessions.set(s.id, s);
    return s;
  }
  return sessions.get(sessionId);
}

// ── SSE 响应辅助 ──
export function sendSSE(res, events, sessionId) {
  if (res.headersSent) return;
  let body = '';
  for (const event of events) {
    body += `data: ${JSON.stringify(event)}\n\n`;
  }
  const headers = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Content-Length': Buffer.byteLength(body),
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  res.writeHead(200, headers);
  res.end(body);
}

export function sendError(res, id, message) {
  sendSSE(res, [{
    jsonrpc: '2.0', id,
    error: { code: -32603, message },
  }]);
}

// ── 鉴权 fail-closed ──
// 读取当前生效的鉴权 token：优先 core.authConfig 服务（start-monitor.js 提供，
// 读 VRC_MONITOR_AUTH_TOKEN / VRC_MONITOR_API_KEY），服务缺失时回退环境变量。
function getConfiguredAuthToken() {
  try {
    if (ctx.pluginLoader?.hasService?.('core.authConfig')) {
      const cfg = ctx.pluginLoader.consume('core.authConfig');
      if (cfg?.token) return cfg.token;
    }
  } catch { /* 服务异常按未配置处理 */ }
  return process.env.VRC_MONITOR_AUTH_TOKEN || process.env.VRC_MONITOR_API_KEY || null;
}

function authFailClosedBody() {
  return JSON.stringify({
    error: 'Unauthorized',
    message: '鉴权已启用但 http.authenticate 服务不可用（auth-guard 插件缺失或加载失败），fail-closed 拒绝访问',
  });
}

// ── 请求路由 ──
async function handleRequest(req, res) {
  const { storage, rateLimiter, wsManager, friendState, eventPipeline, serverState, paths } = ctx;
  const pathname = (req.url || '').split('?')[0];

  // ── 全局 HTTP 鉴权中间件（由 auth-guard 插件或环境配置提供）──
  // fail-closed：token 已配置但 http.authenticate 服务缺失（auth-guard 缺失/加载失败/热重载中被卸载）
  // → 一律 401 拒绝，绝不放行。fail-open 仅限「未配置 token」的开发场景。
  if (getConfiguredAuthToken() && !ctx.pluginLoader?.hasService?.('http.authenticate')) {
    const errBody = authFailClosedBody();
    res.writeHead(401, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(errBody),
      'WWW-Authenticate': 'Bearer error="invalid_token"',
    });
    res.end(errBody);
    return;
  }
  if (ctx.pluginLoader?.hasService('http.authenticate')) {
    const authResult = ctx.pluginLoader.consume('http.authenticate', req);
    if (!authResult || !authResult.ok) {
      const errBody = JSON.stringify({ error: 'Unauthorized', message: authResult?.message || 'Invalid or missing API token' });
      res.writeHead(401, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(errBody),
        'WWW-Authenticate': 'Bearer error="invalid_token"',
      });
      res.end(errBody);
      return;
    }
  }

  // ── 插件注册的 HTTP 路由（api.http.registerRoute）──
  // 在鉴权中间件之后分发：插件路由与 /health、/mcp 同级，按 method+path 精确匹配。
  const route = ctx.httpRoutes?.get(`${req.method} ${pathname}`);
  if (route) {
    try {
      await route.handler(req, res);
    } catch (err) {
      logApp.error(`插件 HTTP 路由失败 [${route.pluginName} ${pathname}]: ${err.message}`, { stack: err.stack, pathname, pluginName: route.pluginName });
      if (!res.headersSent) {
        const body = JSON.stringify({ error: 'Internal Server Error', message: err.message });
        res.writeHead(500, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
        res.end(body);
      }
    }
    return;
  }

  // Health check
  if (req.method === 'GET' && pathname === '/health') {
    const uptime = serverState.started ? Math.floor((Date.now() - serverState.started) / 1000) : 0;
    const status = {
      ok: true,
      // needsTotp 状态下账号并未真正登录（运行期 401 需 TOTP），即使 authUser 仍保留上次缓存，
      // 也必须报 authenticated:false 并暴露 needsTotp，避免 /health 误报已认证（issue #59）
      auth: serverState.authUser && !serverState.needsTotp
        ? { authenticated: true, user: serverState.authUser }
        : { authenticated: false, needsOtp: serverState.needsOtp, needsTotp: serverState.needsTotp },
      totpAutoEnabled: !!(ctx.api?.totpFetcher),
      db: storage.getStats(),
      rateLimiter: rateLimiter.getStats(),
      ws: wsManager?.getState(),
      friendState: friendState?.getStats(),
      eventPipeline: eventPipeline?.getStats(),
      plugins: ctx.pluginLoader?.getStatus() || [],
      uptime,
    };
    const body = JSON.stringify(status, null, 2);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
    return;
  }

  // MCP endpoint probe
  if (req.method === 'GET' && pathname === '/mcp') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Content-Length': 0 });
    res.end();
    return;
  }

  // MCP session termination（SDK 关闭连接时调用，2026-08-17 加：之前 404 导致客户端 warning）
  if (req.method === 'DELETE' && pathname === '/mcp') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== 'POST' || pathname !== '/mcp') {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  let body = '';
  req.on('data', (chunk) => body += chunk);
  req.on('end', async () => {
    try {
      const rpc = JSON.parse(body);
      const sessionId = req.headers['mcp-session-id'];
      const session = getOrCreateSession(sessionId);
      logMCP.debug(`MCP ${rpc.method || '?'} ${body.slice(0, 60)}...`);
      await handleRpc(rpc, session, res);
    } catch (err) {
      log(`Parse error: ${err.message}`);
      sendError(res, null, 'Parse error: ' + err.message);
    }
  });
}

// ── MCP JSON-RPC 协议分发 ──
async function handleRpc(rpc, session, res) {
  const { id, method, params } = rpc;

  switch (method) {
    case 'initialize': {
      session.initialized = true;
      sendSSE(res, [{
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'vrc-monitor', version: '1.14.0' },
        },
      }], session.id);
      break;
    }

    case 'notifications/initialized':
      sendSSE(res, [], session.id);
      break;

    case 'ping':
      // MCP 协议要求：ping 必须返回 JSON-RPC 结果，否则客户端 keepalive 判定连接不健康
      sendSSE(res, [{ jsonrpc: '2.0', id, result: {} }], session.id);
      break;

    case 'tools/list': {
      sendSSE(res, [{
        jsonrpc: '2.0', id,
        result: { tools: registry.listTools() },
      }], session.id);
      break;
    }

    case 'tools/call': {
      const { name, arguments: args } = params;
      try {
        const result = await registry.dispatch(name, args);
        sendSSE(res, [{
          jsonrpc: '2.0', id,
          result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] },
        }], session.id);
      } catch (err) {
        logApp.error(`工具调用失败 [${name}]: ${err.message}`, { stack: err.stack, name });
        sendError(res, id, err.message);
      }
      break;
    }

    default:
      // 未实现的方法：带 id 的请求必须返回 -32601 Method not found，
      // 空响应会让客户端等不到匹配响应而挂起
      if (id === undefined) {
        sendSSE(res, [], session.id);
      } else {
        sendSSE(res, [{ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } }], session.id);
      }
  }
}

// ── 服务器创建 ──
export function createServer() {
  const { PORT } = ctx.paths;

  // 鉴权 fail-closed 启动期阻断：token 已配置但 http.authenticate 服务不存在
  // （auth-guard 插件缺失或加载失败）→ 拒绝创建服务器。监听 0.0.0.0 + 有 token 却无鉴权
  // = 危险配置，绝不能 fail-open；未配置 token 的开发场景不受影响。
  if (getConfiguredAuthToken() && !ctx.pluginLoader?.hasService?.('http.authenticate')) {
    throw new Error(
      '鉴权 fail-closed：已配置 VRC_MONITOR_AUTH_TOKEN（或 VRC_MONITOR_API_KEY），' +
      '但 http.authenticate 服务不存在（auth-guard 插件缺失或加载失败）。' +
      '为安全起见拒绝启动：请检查 plugins/official/auth-guard 插件状态，或移除鉴权 token 配置。'
    );
  }

  const server = http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res);
    } catch (err) {
      log(` Unhandled: ${err.message}`);
      if (!res.headersSent) {
        try { res.writeHead(502); res.end(err.message); } catch {}
      }
    }
  });

  server.on('clientError', (err, socket) => {
    if (socket.writable) {
      try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {}
    }
  });

  // 端口冲突 → 立即退出（防双实例并存互抢 OTP 验证码，issue #49）
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log(`[失败] 端口 ${PORT} 已被占用，请检查是否有旧进程残留`);
      log('   检测到监控服务可能已在运行，本进程立即退出，避免双实例并存互抢 OTP 验证码');
      process.exit(1);
    } else {
      log(`[失败] 服务器错误: ${err.message}`);
    }
  });

  return server;
}
