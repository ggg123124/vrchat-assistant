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
