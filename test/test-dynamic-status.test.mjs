/**
 * test-dynamic-status.test.mjs — 动态状态引擎测试（按在线好友数更新自定义状态）
 *
 * 覆盖:开关默认关闭/unchanged 早退/冷却闸/文本变化才 PUT/模板渲染/PUT body 保留 status 种类。
 * 自包含:mock ctx(api._request 拦截、friendState 计数、storage 内存态),不依赖真实 VRChat 凭据。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const REPO = new URL('.', import.meta.url).pathname.replace(/test\/$/, '');
const { DynamicStatusSync } = await import(new URL('../core/status-sync.js', import.meta.url).href);

/** 构造 mock ctx:onlineCount 可变,PUT/GET 拦截记录 */
function makeCtx({ online = 3, remoteDesc = '', remoteStatus = 'active' } = {}) {
  const calls = { get: 0, put: [], putBodies: [] };
  const cfgStore = new Map();
  const ctx = {
    storage: {
      getConfig: (k) => (cfgStore.has(k) ? cfgStore.get(k) : null),
      setConfig: (k, v) => cfgStore.set(k, v),
    },
    friendState: { getOnlineCount: () => online },
    api: {
      _request: async (method, path, body) => {
        if (method === 'GET' && path === '/auth/user') {
          calls.get++;
          return { status: 200, data: { status: remoteStatus, statusDescription: remoteDesc } };
        }
        if (method === 'PUT' && path === '/auth/user') {
          calls.put.push(body);
          remoteDesc = body.statusDescription ?? remoteDesc;
          remoteStatus = body.status ?? remoteStatus;
          return { status: 200, data: {} };
        }
        return { status: 404, data: null };
      },
    },
  };
  return { ctx, calls };
}

test('默认关闭:未配置时 sync 直接跳过(disabled)', async () => {
  const { ctx } = makeCtx({ online: 5 });
  const s = new DynamicStatusSync(ctx, {});
  const r = await s.sync();
  assert.equal(r.action, 'skipped');
  assert.equal(r.reason, 'disabled');
});

test('set_config 开启后:模板渲染 + 文本变化才 PUT + body 保留 status 种类', async () => {
  const { ctx, calls } = makeCtx({ online: 3, remoteDesc: '旧的文本', remoteStatus: 'join me' });
  const s = new DynamicStatusSync(ctx, {});
  s.setConfig({ enabled: true, template: '在线 {online} 人' });

  const r = await s.sync();
  assert.equal(r.action, 'synced');
  assert.equal(r.statusDescription, '在线 3 人');
  assert.equal(r.online, 3);
  assert.equal(calls.put.length, 1, 'PUT 恰好 1 次');
  assert.equal(calls.put[0].statusDescription, '在线 3 人');
  assert.equal(calls.put[0].status, 'join me', 'PUT body 保留原 status 种类');
});

test('unchanged 早退:远端文本已等于渲染结果时不 PUT', async () => {
  const { ctx, calls } = makeCtx({ online: 2, remoteDesc: '在线 2 人' });
  const s = new DynamicStatusSync(ctx, {});
  s.setConfig({ enabled: true, template: '在线 {online} 人' });
  const r = await s.sync();
  assert.equal(r.action, 'skipped');
  assert.equal(r.reason, 'unchanged');
  assert.equal(calls.put.length, 0, '不应发起 PUT');
});

test('冷却闸:65s 内第二次变化不 PUT(首次提交后冷却生效)', async () => {
  const { ctx, calls } = makeCtx({ online: 3 });
  const s = new DynamicStatusSync(ctx, {});
  s.setConfig({ enabled: true, template: '在线 {online} 人' });
  await s.sync(); // 第一次 PUT(远端空→'在线 3 人')
  assert.equal(calls.put.length, 1);
  // 在线数变化(3→7)→文本变化,但在冷却窗口内
  ctx.friendState.getOnlineCount = () => 7;
  const r2 = await s.sync();
  assert.equal(r2.action, 'skipped');
  assert.equal(r2.reason, 'cooldown');
  assert.equal(calls.put.length, 1, '冷却期内不应第二次 PUT');
});

test('force 绕过开关与冷却:disabled+force 也同步', async () => {
  const { ctx, calls } = makeCtx({ online: 4, remoteDesc: 'x' });
  const s = new DynamicStatusSync(ctx, {});
  // 未开启(disabled),但 force=true
  const r = await s.sync(true);
  assert.equal(r.action, 'synced');
  assert.equal(r.statusDescription, '在线 4 人');
  assert.equal(calls.put.length, 1);
});

test('模板渲染:{online} 占位符替换 + 64 字符截断', async () => {
  const s = new DynamicStatusSync({ storage: { getConfig: () => null, setConfig: () => {} } }, {});
  assert.equal(s.render('在线 {online} 人', 12), '在线 12 人');
  assert.equal(s.render('好友 {online}', 0), '好友 0');
  const long = s.render('{online}'.repeat(30), 11111); // 多占位符长文本 → 截断到 64
  assert.ok(long.length <= 64, '渲染结果应截断到 64 字符内');
});
