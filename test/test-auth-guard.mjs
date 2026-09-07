/**
 * test-auth-guard.mjs — auth-guard 插件与 HTTP 鉴权中间件单元及端到端测试
 *
 * 用法: node test-auth-guard.mjs
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { extractTokenFromRequest, safeCompare } from '../plugins/official/auth-guard/index.js';
import registerAuthGuard from '../plugins/official/auth-guard/index.js';
import { createServer } from '../core/http-server.js';
import { ctx } from '../core/server-context.js';
import { RateLimiter } from '../core/rate-limiter.js';

let passed = 0;
function ok(name) { passed++; console.log('  ✅ ' + name); }

console.log('── 1. 单元测试: Token 提取与安全比对 ──');
{
  // 1.1 Bearer Token
  assert.equal(extractTokenFromRequest({ headers: { authorization: 'Bearer my_token_123' } }), 'my_token_123');
  assert.equal(extractTokenFromRequest({ headers: { Authorization: 'bearer test_token' } }), 'test_token');
  ok('从 Authorization: Bearer 提取 Token 成功');

  // 1.2 X-API-Key
  assert.equal(extractTokenFromRequest({ headers: { 'x-api-key': 'key_abc' } }), 'key_abc');
  assert.equal(extractTokenFromRequest({ headers: { 'x-auth-token': 'key_def' } }), 'key_def');
  ok('从 X-API-Key / x-auth-token 提取 Token 成功');

  // 1.3 URL Query
  assert.equal(extractTokenFromRequest({ url: '/mcp?token=query_token' }), 'query_token');
  assert.equal(extractTokenFromRequest({ url: '/health?api_key=query_api_key' }), 'query_api_key');
  assert.equal(extractTokenFromRequest({ url: '/mcp?key=k123' }), 'k123');
  ok('从 URL Query 参数提取 Token 成功');

  // 1.4 无效输入
  assert.equal(extractTokenFromRequest(null), null);
  assert.equal(extractTokenFromRequest({ headers: {}, url: '/mcp' }), null);
  assert.equal(extractTokenFromRequest({ headers: { authorization: 'Basic dXNlcjpwYXNz' } }), null);
  ok('无效/缺失 Token 返回 null');

  // 1.5 安全比对
  assert.equal(safeCompare('same_secret_token', 'same_secret_token'), true);
  assert.equal(safeCompare('secret_a', 'secret_b'), false);
  assert.equal(safeCompare('short', 'longer_string'), false);
  assert.equal(safeCompare(null, 'test'), false);
  ok('安全常量时间比对 safeCompare 准确生效');
}

console.log('\n── 2. 插件注册与 MCP 工具验证 ──');
{
  const tools = new Map();
  const services = new Map();
  services.set('core.authConfig', () => ({
    token: process.env.VRC_MONITOR_AUTH_TOKEN || null,
    host: process.env.VRC_MONITOR_HOST || '127.0.0.1',
    port: 8799,
  }));
  const mockApi = {
    provide: (name, fn) => services.set(name, fn),
    consume: (name, ...args) => services.get(name)(...args),
    hasService: (name) => services.has(name),
    registerTool: (def) => tools.set(def.name, def),
    log: () => {},
  };

  registerAuthGuard(mockApi);
  assert.ok(services.has('http.authenticate'), '已注册 http.authenticate 服务');
  assert.ok(tools.has('auth_get_status'), '已注册 auth_get_status 工具');
  assert.ok(tools.has('auth_generate_token'), '已注册 auth_generate_token 工具');
  assert.ok(tools.has('auth_verify_token'), '已注册 auth_verify_token 工具');
  ok('插件成功注册服务与全部 3 个 MCP 工具');

  // 2.1 auth_generate_token
  const genResult = await tools.get('auth_generate_token').handler({ length: 32 });
  assert.equal(genResult.generatedToken.length, 64);
  assert.ok(genResult.envConfigSnippet.includes('VRC_MONITOR_AUTH_TOKEN='));
  ok('auth_generate_token 生成高强度 Token 成功');

  // 2.2 auth_verify_token
  process.env.VRC_MONITOR_AUTH_TOKEN = 'test_secret_for_verify';
  const matchResult = await tools.get('auth_verify_token').handler({ token: 'test_secret_for_verify' });
  const mismatchResult = await tools.get('auth_verify_token').handler({ token: 'wrong_secret' });
  assert.equal(matchResult.valid, true);
  assert.equal(mismatchResult.valid, false);
  ok('auth_verify_token 校验逻辑准确');
}

console.log('\n── 3. 端到端测试: HTTP 鉴权中间件 ──');
{
  // 准备 mock 上下文
  ctx.storage = { getStats: () => ({ events: 10, friends: 2, world_cache: 1 }) };
  ctx.rateLimiter = new RateLimiter();
  ctx.serverState = { started: Date.now(), authUser: { id: 'usr_test', displayName: 'tester' }, needsOtp: false, needsTotp: false };
  ctx.paths = { PORT: 0, HOST: '127.0.0.1' };
  ctx.httpRoutes = new Map();

  // 模拟 pluginLoader
  const services = new Map();
  services.set('core.authConfig', () => ({
    token: process.env.VRC_MONITOR_AUTH_TOKEN || null,
    host: process.env.VRC_MONITOR_HOST || '127.0.0.1',
    port: 8799,
  }));
  const mockApi = {
    provide: (name, fn) => services.set(name, fn),
    consume: (name, ...args) => services.get(name)(...args),
    hasService: (name) => services.has(name),
    registerTool: () => {},
    log: () => {},
    // 模拟 api.http.registerRoute（web-dashboard 等插件注册 HTTP 路由用）
    http: { registerRoute: (r) => ctx.httpRoutes.set(`${r.method} ${r.path}`, r) },
  };
  // 模拟 web-dashboard 注册的根路径重定向（GET/HEAD / → 302 /dashboard）与面板页面路由
  const rootRedirect = (_req, res) => { res.writeHead(302, { Location: '/dashboard' }); res.end(); };
  mockApi.http.registerRoute({ method: 'GET', path: '/', handler: rootRedirect });
  mockApi.http.registerRoute({ method: 'HEAD', path: '/', handler: rootRedirect });
  mockApi.http.registerRoute({ method: 'GET', path: '/dashboard', handler: (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>dashboard</html>'); } });
  registerAuthGuard(mockApi);

  ctx.pluginLoader = {
    hasService: (name) => services.has(name),
    consume: (name, ...args) => services.get(name)(...args),
    getStatus: () => [{ name: 'auth-guard', status: 'loaded' }],
  };

  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  async function request(path, options = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request('http://127.0.0.1:' + port + path, options, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => resolve({ status: res.statusCode, data, headers: res.headers }));
      });
      req.on('error', reject);
      if (options.body) req.write(options.body);
      req.end();
    });
  }

  // 3.1 未启用 Token 时（环境未配置），全放行
  delete process.env.VRC_MONITOR_AUTH_TOKEN;
  delete process.env.VRC_MONITOR_API_KEY;

  let res = await request('/health');
  assert.equal(res.status, 200, '未配置 Token 时 /health 正常访问');
  res = await request('/mcp');
  assert.equal(res.status, 200, '未配置 Token 时 /mcp 正常访问');
  ok('未配置 Token 时服务默认完全放行（向后兼容）');

  // 3.2 启用 Token
  const TEST_TOKEN = 'super_secret_token_abcdef123456';
  process.env.VRC_MONITOR_AUTH_TOKEN = TEST_TOKEN;

  // 3.2.1 无 Token 请求 -> 401
  res = await request('/health');
  assert.equal(res.status, 401);
  assert.ok(JSON.parse(res.data).error === 'Unauthorized');
  res = await request('/mcp');
  assert.equal(res.status, 401);
  ok('启用 Token 后无鉴权请求均被 401 拦截');

  // 3.2.2 错误 Token 请求 -> 401
  res = await request('/health', { headers: { authorization: 'Bearer wrong_token' } });
  assert.equal(res.status, 401);
  res = await request('/mcp?token=wrong_token');
  assert.equal(res.status, 401);
  ok('启用 Token 后错误鉴权请求均被 401 拦截');

  // 3.2.3 正确 Token - Bearer Header
  res = await request('/health', { headers: { authorization: 'Bearer ' + TEST_TOKEN } });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.data).ok, true);
  ok('携带正确 Authorization: Bearer 成功访问 /health');

  // 3.2.4 正确 Token - X-API-Key Header
  res = await request('/mcp', { headers: { 'x-api-key': TEST_TOKEN } });
  assert.equal(res.status, 200);
  ok('携带正确 X-API-Key 成功访问 /mcp');

  // 3.2.5 正确 Token - Query Parameter
  res = await request('/health?token=' + TEST_TOKEN);
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.data).ok, true);
  res = await request('/mcp?token=' + TEST_TOKEN);
  assert.equal(res.status, 200);
  ok('携带正确 URL Query ?token=... 成功访问 /mcp 与 /health');

  // 3.2.7 根路径豁免（PR #150）：GET/HEAD / → 302 /dashboard（无 token 也不返回 401）
  res = await request('/');
  assert.equal(res.status, 302, '配置 Token 时 GET / 豁免放行（不返回 401）');
  assert.equal(res.headers.location, '/dashboard', '302 重定向到 /dashboard');
  res = await request('/', { method: 'HEAD' });
  assert.equal(res.status, 302, 'HEAD / 同样豁免放行');
  assert.equal(res.headers.location, '/dashboard', 'HEAD 302 重定向到 /dashboard');
  res = await request('/dashboard');
  assert.equal(res.status, 200, '/dashboard 页面豁免回归正常');
  ok('根路径 GET/HEAD / 豁免 → 302 /dashboard，页面豁免回归正常');

  // 清理测试环境
  delete process.env.VRC_MONITOR_AUTH_TOKEN;
  await new Promise((resolve) => server.close(resolve));
}

console.log('\n── 4. 鉴权 fail-closed：token 已配置但 http.authenticate 服务缺失 ──');
{
  async function request(path, options = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request('http://127.0.0.1:' + port + path, options, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => resolve({ status: res.statusCode, data, headers: res.headers }));
      });
      req.on('error', reject);
      if (options.body) req.write(options.body);
      req.end();
    });
  }

  // 4.1 启动期阻断：token 已配置 + 无 http.authenticate → createServer 抛错拒绝启动
  process.env.VRC_MONITOR_AUTH_TOKEN = 'failclosed_test_token';
  ctx.pluginLoader = {
    hasService: () => false,
    consume: () => { throw new Error('service not found'); },
    getStatus: () => [],
  };
  assert.throws(() => createServer(), /fail-closed/, 'token 配置但无 http.authenticate 服务时 createServer 应拒绝启动');
  ok('启动期 fail-closed：createServer 抛出 fail-closed 错误');

  // 4.2 运行期 fail-closed：服务器在无 token 时创建，随后 token 生效 → 全部请求 401
  delete process.env.VRC_MONITOR_AUTH_TOKEN;
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  process.env.VRC_MONITOR_AUTH_TOKEN = 'failclosed_test_token';
  let res = await request('/health');
  assert.equal(res.status, 401, 'token 生效后 /health 应 401');
  assert.ok(res.data.includes('fail-closed'), `401 响应体应说明 fail-closed，实际: ${res.data}`);
  res = await request('/mcp');
  assert.equal(res.status, 401, 'token 生效后 /mcp 应 401');
  res = await request('/health', { headers: { authorization: 'Bearer failclosed_test_token' } });
  assert.equal(res.status, 401, '即使携带正确 token，无 http.authenticate 服务仍应 401');
  ok('运行期 fail-closed：token 生效后全部请求 401（含携带正确 token）');

  delete process.env.VRC_MONITOR_AUTH_TOKEN;
  res = await request('/health');
  assert.equal(res.status, 200, '移除 token 后恢复放行（无 token 开发场景 fail-open）');
  ok('移除 token 后恢复放行');

  // 清理测试环境
  ctx.pluginLoader = null;
  await new Promise((resolve) => server.close(resolve));
}

console.log('\n🎉 全部 ' + passed + ' 项测试通过！');
