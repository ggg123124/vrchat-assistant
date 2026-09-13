/**
 * plugin-loader-failure-cleanup.test.mjs — 加载失败路径的资源清理回归（review #187 💡C/💡2）
 *
 * 背景：插件 register 可能「先上报 /health、先注册路由，再抛错」。
 * 失败后插件处于禁用状态，其 /health 键与路由必须被清理——否则 /health 会给
 * 未加载的插件签名（诚报语义被破坏），路由则泄漏为无法卸载的端点。
 * 该测试是机械化校验：作者若声称修好却未改代码（#187 二轮曾出现），这里会红。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PluginLoader } from '../core/plugin-loader.js';

function makePlugin(root, dirName, indexJs) {
  const dir = path.join(root, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'index.js'), indexJs, 'utf-8');
  writeFileSync(path.join(dir, 'plugin.json'),
    JSON.stringify({ name: dirName, version: '1.0.0', description: 'test' }), 'utf-8');
  return {
    name: dirName, dir, entryFile: path.join(dir, 'index.js'),
    schemaFile: null, manifestFile: path.join(dir, 'plugin.json'),
  };
}

const REGISTER_REPORTS_THEN_THROWS = `
export default function register(api) {
  api.health({ leaked: { state: 'reported-then-threw' } });
  api.http.registerRoute({ method: 'GET', path: '/routeleak-probe', handler: (req, res) => res.end('x') });
  throw new Error('boom after report');
}
`;

test('首载 register 抛错：/health 键与路由均被清理（插件禁用后不得残留）', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'plg-fail-'));
  try {
    const ctx = { httpRoutes: new Map(), healthExtras: {} };
    const registry = {
      removePluginTools() {}, registerPluginTool() {},
      getPluginTools: () => [], getPluginToolMap: () => new Map(),
    };
    const loader = new PluginLoader({ registry, ctx, log: () => {} });
    const plugin = makePlugin(root, 'leaky', REGISTER_REPORTS_THEN_THROWS);

    let threw = false;
    try { await loader._loadPlugin(plugin); } catch { threw = true; }
    if (threw) loader._setError(plugin, 'boom after report'); // 与 loadAll 的错误路径等价

    assert.equal(plugin.status === 'loaded', false, '插件不应处于 loaded');
    assert.equal(ctx.healthExtras.leaky, undefined, '/health 不得残留未加载插件的键');
    assert.equal(ctx.httpRoutes.has('GET /routeleak-probe'), false, '失败插件的路由必须被清理');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('健康上报与路由在正常加载时保留（对照：清理不误伤成功插件）', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'plg-ok-'));
  try {
    const ctx = { httpRoutes: new Map(), healthExtras: {} };
    const registry = {
      removePluginTools() {}, registerPluginTool() {},
      getPluginTools: () => [], getPluginToolMap: () => new Map(),
    };
    const loader = new PluginLoader({ registry, ctx, log: () => {} });
    const plugin = makePlugin(root, 'healthy', `
      export default function register(api) {
        api.health({ leaked: { state: 'ok' } });
        api.http.registerRoute({ method: 'GET', path: '/healthy-probe', handler: (req, res) => res.end('x') });
      }
    `);
    await loader._loadPlugin(plugin);
    assert.deepStrictEqual(ctx.healthExtras.healthy, { leaked: { state: 'ok' } });
    assert.equal(ctx.httpRoutes.has('GET /healthy-probe'), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('热重载失败回滚：清掉失败新版残留，并恢复旧版路由与 /health 上报（R4 💡②）', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'plg-reload-'));
  try {
    const ctx = { httpRoutes: new Map(), healthExtras: {} };
    const registry = {
      removePluginTools() {}, registerPluginTool() {},
      getPluginTools: () => [], getPluginToolMap: () => new Map(),
    };
    const loader = new PluginLoader({ registry, ctx, log: () => {} });
    // v1：正常上报 + 注册路由
    const plugin = makePlugin(root, 'flappy', `
      export default function register(api) {
        api.health({ v: 1 });
        api.http.registerRoute({ method: 'GET', path: '/flappy-v1', handler: (req, res) => res.end('v1') });
      }
    `);
    await loader._loadPlugin(plugin);
    plugin.status = 'loaded';
    loader.plugins.set('flappy', plugin);
    assert.deepStrictEqual(ctx.healthExtras.flappy, { v: 1 });
    assert.equal(ctx.httpRoutes.has('GET /flappy-v1'), true);

    // v2：先上报 + 注册自己的路由，再抛错
    writeFileSync(path.join(plugin.dir, 'index.js'), `
      export default function register(api) {
        api.health({ v: 2, broken: true });
        api.http.registerRoute({ method: 'GET', path: '/flappy-v2-broken', handler: (req, res) => res.end('v2') });
        throw new Error('v2 boom');
      }
    `, 'utf-8');

    await loader._reloadPlugin('flappy');

    // 失败新版不得残留
    assert.equal(ctx.httpRoutes.has('GET /flappy-v2-broken'), false, '失败新版路由必须清理');
    assert.notDeepStrictEqual(ctx.healthExtras.flappy, { v: 2, broken: true }, '/health 不得显示失败新版本数据');
    // 旧版运行态必须恢复（旧版仍在跑）
    assert.deepStrictEqual(ctx.healthExtras.flappy, { v: 1 }, '旧版 /health 上报需恢复');
    assert.equal(ctx.httpRoutes.has('GET /flappy-v1'), true, '旧版路由需恢复');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('失败插件的服务被释放（后续插件可复用同名服务，R4 💡①）', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'plg-svc-'));
  try {
    const ctx = { httpRoutes: new Map(), healthExtras: {} };
    const registry = {
      removePluginTools() {}, registerPluginTool() {},
      getPluginTools: () => [], getPluginToolMap: () => new Map(),
    };
    const loader = new PluginLoader({ registry, ctx, log: () => {} });
    const broken = makePlugin(root, 'svc-broken', `
      export default function register(api) {
        api.provide('demo.service', () => 1);
        throw new Error('boom after provide');
      }
    `);
    let threw = false;
    try { await loader._loadPlugin(broken); } catch { threw = true; }
    if (threw) loader._setError(broken, 'boom after provide');
    assert.equal(loader.serviceOwners.has('demo.service'), false, '失败插件的服务占用必须释放');

    // 后续插件可注册同名服务
    const good = makePlugin(root, 'svc-good', `
      export default function register(api) { api.provide('demo.service', () => 2); }
    `);
    await loader._loadPlugin(good);
    assert.equal(loader.serviceOwners.get('demo.service'), 'svc-good');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
