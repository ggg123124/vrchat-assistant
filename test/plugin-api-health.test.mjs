/**
 * plugin-api-health.test.mjs — api.health 契约回归（review #187 ⚠️2/⚠️3）
 *
 * 覆盖：按插件名命名空间收纳 / 核心字段不可被覆盖 / 卸载清理 / 非法参数忽略 / 无接口能力探测。
 * 自包含：构造最小 fake ctx + registry，直接调用 buildPluginApi。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPluginApi } from '../core/plugin-api.js';

function makeApi(pluginName, ctx) {
  const registry = { hasTool: () => false, registerPluginTool: () => {}, removePluginTools: () => {} };
  return buildPluginApi(pluginName, {
    registry, ctx, services: new Map(), serviceOwners: new Map(), log: () => {},
  });
}

test('api.health 按插件名收纳到 ctx.healthExtras[pluginName]', () => {
  const ctx = { httpRoutes: new Map() };
  const api = makeApi('web-dashboard', ctx);
  api.health({ dashboardUi: { state: 'built' } });
  assert.deepStrictEqual(ctx.healthExtras, { 'web-dashboard': { dashboardUi: { state: 'built' } } });
});

test('多插件互不干扰（键空间隔离）', () => {
  const ctx = { httpRoutes: new Map() };
  makeApi('plug-a', ctx).health({ k: 1 });
  makeApi('plug-b', ctx).health({ k: 2 });
  assert.deepStrictEqual(ctx.healthExtras, { 'plug-a': { k: 1 }, 'plug-b': { k: 2 } });
});

test('插件无法覆盖核心 /health 字段（auth 等不在 extras 命名空间内）', () => {
  const ctx = { httpRoutes: new Map() };
  const api = makeApi('evil', ctx);
  api.health({ auth: { authenticated: true }, plugins: [] });
  // 上报内容落 extras.evil 下，核心字段名不会被顶替
  assert.deepStrictEqual(ctx.healthExtras.evil, { auth: { authenticated: true }, plugins: [] });
  assert.strictEqual(ctx.healthExtras.auth, undefined);
});

test('同插件重复上报为合并（后者覆盖同键）', () => {
  const ctx = { httpRoutes: new Map() };
  const api = makeApi('p', ctx);
  api.health({ a: 1, b: 1 });
  api.health({ b: 2 });
  assert.deepStrictEqual(ctx.healthExtras.p, { a: 1, b: 2 });
});

test('removeHealth 清理该插件键（卸载语义）', () => {
  const ctx = { httpRoutes: new Map() };
  const api = makeApi('p', ctx);
  api.health({ a: 1 });
  api.removeHealth();
  assert.strictEqual(ctx.healthExtras.p, undefined);
});

test('非法参数被忽略（null/字符串/数字不产生上报）', () => {
  const ctx = { httpRoutes: new Map() };
  const api = makeApi('p', ctx);
  api.health(null); api.health('x'); api.health(42);
  assert.strictEqual(ctx.healthExtras, undefined);
});
