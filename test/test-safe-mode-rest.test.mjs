/**
 * test-safe-mode-rest.test.mjs — dashboard REST 层 safe-mode 拦截测试（#162）
 *
 * 覆盖 safeModeBlockIrreversible helper 与各路由语义：
 *   1. safeMode=true 时：画廊删除/照片删除/取消收藏(avatar via /favorites) 全部被拦，文案含「云端不可逆」
 *   2. safeMode=false 时：上述操作放行（走到下游调用）
 *   3. tracked/remove（本地软删除可恢复）：safeMode=true 下放行（#162 修复误拦）
 *   4. favorite-remove 的 avatar/friend 分支（此前漏网）在 safeMode=true 下被拦
 * 自包含：mock api.consume/api.tools.call/api.vrchat.fetch + 假 req/res。
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..');

const pluginMain = await import(pathToFileURL(path.join(REPO, 'plugins', 'official', 'web-dashboard', 'index.js')).href);

// 假 res：捕获 sendJson 输出
function makeRes() {
  const res = { statusCode: 0, headers: {}, body: null, ended: false };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.writeHead = (code, headers) => { res.statusCode = code; Object.assign(res.headers, headers || {}); };
  res.end = (data) => { res.ended = true; if (data) { try { res.body = JSON.parse(data); } catch { res.body = data; } } };
  return res;
}

function makeReq() { return { on: () => {}, method: 'POST' }; }

// 路由捕获：注册时按 path 存 handler
function makeMockApi({ safeMode, toolCalls = [], vrchatCalls = [], serviceCalls = [], snapshotFail = false }) {
  const routes = new Map();
  const api = {
    http: { registerRoute: (r) => routes.set(r.method + ' ' + r.path, r.handler) },
    consume: async (svc) => {
      if (svc === 'dashboard.snapshot') {
        if (snapshotFail) throw new Error('snapshot unavailable');
        return { safeMode };
      }
      serviceCalls.push(svc);
      return { ok: true };
    },
    tools: { call: async (name, args) => { toolCalls.push({ name, args }); return { ok: true }; } },
    vrchat: { fetch: async (p, opts) => { vrchatCalls.push({ p, opts }); if (opts?.method === 'POST') return { id: 'fav_1' }; return [{ id: 'fav_1', favoriteId: 'avtr_x' }]; } },
    log: () => {},
    registerTool: () => {},
    registerService: () => {},
  };
  return { api, routes, toolCalls, vrchatCalls, serviceCalls };
}

async function callRoute(api, routes, method, p, body) {
  const handler = routes.get(method + ' ' + p);
  assert.ok(handler, `route ${p} should be registered`);
  const req = makeReq();
  req.on = (ev, cb) => { if (ev === 'data') cb(JSON.stringify(body || {})); if (ev === 'end') cb(); };
  const res = makeRes();
  await handler(req, res);
  return res;
}

// 仅注册主 index.js 路由（favorites.js 的路由在 register 内一并注册——参考其 register(api) 入口）
function registerRoutes(mock) {
  pluginMain.default(mock.api);
  return mock.routes;
}

test('safe-mode REST: 云端不可逆操作被拦、本地软删除放行', async () => {
  const m = makeMockApi({ safeMode: true });
  const routes = registerRoutes(m);

  // 1) 画廊删除被拦（含统一文案语义）
  const r1 = await callRoute(m.api, routes, 'POST', '/api/dashboard/gallery/remove', { fileId: 'file_abc' });
  assert.equal(r1.body.ok, false, 'gallery remove blocked');
  assert.match(r1.body.error, /安全模式/);
  assert.match(r1.body.error, /不可逆/, '文案应表达云端不可语义（#162 统一）');
  assert.equal(m.toolCalls.length, 0, '下游工具不应被调用');

  // 2) 照片删除被拦
  const r2 = await callRoute(m.api, routes, 'POST', '/api/dashboard/prints/remove', { printId: 'prnt_abc' });
  assert.equal(r2.body.ok, false);
  assert.match(r2.body.error, /不可逆/);

  // 3) avatar 取消收藏被拦（此前漏网，#162 补齐）
  const r3 = await callRoute(m.api, routes, 'POST', '/api/dashboard/avatar/favorite', { avatarId: 'avtr_x', favorite: false });
  assert.equal(r3.body.ok, false);
  assert.match(r3.body.error, /不可逆/);

  // 4) favorite-remove（favorites.js，此前 avatar/friend 分支漏网）在 safeMode=true 下被拦
  //    且下游 DELETE /favorites/{id} 不被调用（review #170 inline：注释声称覆盖但原缺此断言）
  const r4 = await callRoute(m.api, routes, 'POST', '/api/dashboard/favorite-remove', { type: 'friend', id: 'usr_x' });
  assert.equal(r4.body.ok, false, 'favorite-remove 应被拦');
  assert.match(r4.body.error, /不可逆/);
  const m2 = makeMockApi({ safeMode: true });
  const routes2 = registerRoutes(m2);
  await callRoute(m2.api, routes2, 'POST', '/api/dashboard/favorite-remove', { type: 'avatar', id: 'avtr_x' });
  assert.equal(m2.vrchatCalls.filter(c => c.opts?.method === 'DELETE').length, 0, '拦截后不应有 DELETE 下发');
  const m3 = makeMockApi({ safeMode: true });
  const routes3 = registerRoutes(m3);
  await callRoute(m3.api, routes3, 'POST', '/api/dashboard/favorite-remove', { type: 'world', id: 'wrld_x' });
  assert.equal(m3.toolCalls.filter(t => t.name === 'unfavorite_world').length, 0, 'world 分支同样被拦（MCP unfavorite_world 不调用）');

  // 5) tracked/remove 本地软删除：放行（#162 修复误拦）
  const r5 = await callRoute(m.api, routes, 'POST', '/api/dashboard/tracked/remove', { userId: 'usr_abc' });
  assert.equal(r5.body.ok, true, 'tracked 软删除应放行');
  assert.ok(m.serviceCalls.includes('dashboard.trackedRemove'), '下游服务应被调用');
});

test('safe-mode REST: safeMode=false 全部放行；快照不可用也放行', async () => {
  const m1 = makeMockApi({ safeMode: false });
  const routes1 = registerRoutes(m1);
  const a1 = await callRoute(m1.api, routes1, 'POST', '/api/dashboard/gallery/remove', { fileId: 'file_abc' });
  assert.equal(a1.body.ok, true);
  assert.equal(m1.toolCalls.filter(t => t.name === 'remove_gallery_image').length, 1);
  const a2 = await callRoute(m1.api, routes1, 'POST', '/api/dashboard/avatar/favorite', { avatarId: 'avtr_x', favorite: false });
  assert.equal(a2.body.ok, true);
  assert.ok(m1.vrchatCalls.some(c => c.opts?.method === 'DELETE'), '取消收藏 DELETE 应执行');

  const m2 = makeMockApi({ safeMode: true, snapshotFail: true });
  const routes2 = registerRoutes(m2);
  const b1 = await callRoute(m2.api, routes2, 'POST', '/api/dashboard/prints/remove', { printId: 'prnt_abc' });
  assert.equal(b1.body.ok, true, '快照不可用时放行（与既有 catch 语义一致）');
});
