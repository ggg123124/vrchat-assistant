/**
 * test-web-dashboard.mjs
 *
 * 全面验证 web-dashboard 官方插件与一元全栈视图注册机制：
 * 1. 静态资源托管与 MIME 类型解析
 * 2. REST API 接口数据结构与业务聚合（status, friends, friend-detail, feed, history, analytics, action）
 * 3. SSE 实时事件流广播与连接生命周期
 * 4. 跨插件视图注册（booth, planet, favorites, groups, media, auth-guard）
 * 5. 全局 Token 鉴权联动
 */

import http from 'node:http';
import assert from 'node:assert';
import { ctx } from './core/server-context.js';
import * as registry from './core/registry.js';
import { PluginLoader } from './core/plugin-loader.js';
import { Storage } from './core/storage.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    console.log('  ✅ ' + name);
    passed++;
  } catch (err) {
    console.error('  ❌ ' + name + ': ' + err.message);
    throw err;
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log('  ✅ ' + name);
    passed++;
  } catch (err) {
    console.error('  ❌ ' + name + ': ' + err.message);
    throw err;
  }
}

console.log('── 1. 插件加载与前端视图注册验证 ──');

// 初始化环境
const storage = new Storage({ inMemory: true, enableWal: false });
storage.init();
storage.upsertFriend({
  userId: 'usr_friend_1',
  displayName: 'FriendOne',
  isOnline: 1,
  status: 'active',
  worldName: 'Great Pug',
});
ctx.storage = storage;
ctx.serverState = { started: Date.now() - 3600000, authUser: { id: 'usr_test_123', displayName: 'TestUser' } };
ctx.friendState = {
  isOnline: (id) => id === 'usr_friend_1',
  getOnlineFriends: () => [
    { userId: 'usr_friend_1', displayName: 'FriendOne', status: 'active', worldName: 'Great Pug', durationMinutes: 45 }
  ],
  getStats: () => ({ online: 1, total: 10 }),
};
ctx.contactsStore = {
  getContact: (id) => ({ id, displayName: 'FriendOne', trustLevel: 'Trusted' }),
  getNickname: (id) => '本地小昵称',
  getNote: (id) => '常在酒馆挂机',
  setNickname: (id, name) => {},
  setNote: (id, note) => {},
};

const loader = new PluginLoader({
  registry,
  ctx,
  log: () => {},
});
ctx.pluginLoader = loader;

// 注册 core.authConfig 服务供 auth-guard
loader.services.set('core.authConfig', () => ({
  token: 'test_token_12345678901234567890',
  host: '0.0.0.0',
  port: 8799,
}));
loader.serviceOwners.set('core.authConfig', 'core');

await loader.loadAll();

const views = loader.getViews();
test('官方插件成功注册专属前端视图', () => {
  assert(views.length >= 5, '至少包含 5 个插件视图，当前: ' + views.length);
  const viewIds = views.map(v => v.id);
  assert(viewIds.includes('worlds-favorites'), '包含 worlds-favorites 视图');
  assert(viewIds.includes('booth-market'), '包含 booth-market 视图');
  assert(viewIds.includes('planet-radar'), '包含 planet-radar 视图');
  assert(viewIds.includes('groups-hub'), '包含 groups-hub 视图');
  assert(viewIds.includes('media-gallery'), '包含 media-gallery 视图');
  assert(viewIds.includes('security-settings'), '包含 security-settings 视图');
});

test('MCP 工具 dashboard_get_url 注册成功', () => {
  assert(registry.hasTool('dashboard_get_url'), 'dashboard_get_url 工具已注册');
});

console.log('\n── 2. HTTP 静态资源托管与 REST API 测试 ──');

// 动态启动测试 HTTP 服务器
import { createServer } from './core/http-server.js';
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const baseUrl = 'http://127.0.0.1:' + port;
const validAuth = 'Bearer test_token_12345678901234567890';

// 2.1 静态前端放行与 API 鉴权拦截
await asyncTest('未携带 Token 访问 /dashboard 成功获取静态 SPA 界面 (200)', async () => {
  const res = await fetch(baseUrl + '/dashboard');
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert(html.includes('VRChat Assistant'), '包含 Dashboard 标题');
  assert(html.includes('id="app"'), '包含 Vue 挂载节点');
});

await asyncTest('未携带 Token 访问 /api/dashboard/status 被 401 拦截', async () => {
  const res = await fetch(baseUrl + '/api/dashboard/status');
  assert.strictEqual(res.status, 401);
});

await asyncTest('静态资源 app.js 与 style.css 正常托管', async () => {
  const resJs = await fetch(baseUrl + '/dashboard/app.js', { headers: { 'Authorization': validAuth } });
  assert.strictEqual(resJs.status, 200);
  assert(resJs.headers.get('content-type').includes('javascript'), 'JS MIME 类型正确');

  const resCss = await fetch(baseUrl + '/dashboard/style.css', { headers: { 'Authorization': validAuth } });
  assert.strictEqual(resCss.status, 200);
  assert(resCss.headers.get('content-type').includes('css'), 'CSS MIME 类型正确');
});

// 2.3 REST API 测试
await asyncTest('GET /api/dashboard/status 返回状态与视图', async () => {
  const res = await fetch(baseUrl + '/api/dashboard/status', { headers: { 'Authorization': validAuth } });
  assert.strictEqual(res.status, 200);
  const json = await res.json();
  assert.strictEqual(json.ok, true);
  assert.strictEqual(json.user?.displayName, 'TestUser');
  assert(Array.isArray(json.views), 'views 为数组');
  assert(json.views.length >= 5);
});

await asyncTest('GET /api/dashboard/friends 返回在线好友', async () => {
  const res = await fetch(baseUrl + '/api/dashboard/friends', { headers: { 'Authorization': validAuth } });
  assert.strictEqual(res.status, 200);
  const json = await res.json();
  assert.strictEqual(json.ok, true);
  assert.strictEqual(json.totalOnline, 1);
  assert.strictEqual(json.online[0].displayName, 'FriendOne');
});

await asyncTest('GET /api/dashboard/friend-detail 返回好友深度档案与备注', async () => {
  const res = await fetch(baseUrl + '/api/dashboard/friend-detail?userId=usr_friend_1', { headers: { 'Authorization': validAuth } });
  assert.strictEqual(res.status, 200);
  const json = await res.json();
  assert.strictEqual(json.ok, true);
  assert.strictEqual(json.nickname, '本地小昵称');
  assert.strictEqual(json.note, '常在酒馆挂机');
});

await asyncTest('GET /api/dashboard/feed 返回空事件数组', async () => {
  const res = await fetch(baseUrl + '/api/dashboard/feed?limit=10', { headers: { 'Authorization': validAuth } });
  assert.strictEqual(res.status, 200);
  const json = await res.json();
  assert.strictEqual(json.ok, true);
  assert(Array.isArray(json.events));
});

await asyncTest('GET /api/dashboard/analytics 返回统计结构', async () => {
  const res = await fetch(baseUrl + '/api/dashboard/analytics?days=30', { headers: { 'Authorization': validAuth } });
  assert.strictEqual(res.status, 200);
  const json = await res.json();
  assert.strictEqual(json.ok, true);
  assert.strictEqual(json.days, 30);
});

await asyncTest('POST /api/dashboard/action 保存本地备注成功', async () => {
  const res = await fetch(baseUrl + '/api/dashboard/action', {
    method: 'POST',
    headers: {
      'Authorization': validAuth,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      action: 'set_note',
      args: { userId: 'usr_friend_1', note: '测试新备注' },
    }),
  });
  assert.strictEqual(res.status, 200);
  const json = await res.json();
  assert.strictEqual(json.ok, true);
  assert.strictEqual(json.message, '备注保存成功');
});

// 2.4 SSE 连接测试
await asyncTest('GET /api/dashboard/events/stream 握手成功', async () => {
  const ctrl = new AbortController();
  const res = await fetch(baseUrl + '/api/dashboard/events/stream', {
    headers: { 'Authorization': validAuth },
    signal: ctrl.signal,
  });
  assert.strictEqual(res.status, 200);
  assert(res.headers.get('content-type').includes('text/event-stream'));
  ctrl.abort();
});

// 清理关闭
await new Promise(resolve => server.close(resolve));
storage.close();

console.log('\n🎉 全部 ' + passed + ' 项测试通过！');
