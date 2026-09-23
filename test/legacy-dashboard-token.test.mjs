/**
 * legacy-dashboard-token.test.mjs — legacy UI 的令牌传输回归（issue #217 审核 ⚠️）
 *
 * 背景：legacy UI（client/js/vue/core.js）的 get/post 曾把令牌拼进 query string，
 * 而它在 `?legacy=1` 或 ui/dist 缺失时是**默认被服务的**主通道 → 令牌会进反代访问日志。
 * 本用例以全局桩驱动那段浏览器 IIFE，断言：普通请求走 Authorization 头、URL 不含 token；
 * 仅 EventSource 仍用 query 形态（它无法自定义请求头）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = path.resolve(import.meta.dirname, '..');
const CORE = path.join(REPO, 'plugins/official/web-dashboard/client/js/vue/core.js');

async function loadLegacy(search = '?token=abc123') {
  const calls = [];
  globalThis.window = globalThis;
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};
  globalThis.document = { querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, addEventListener: () => {}, body: { appendChild: () => {} }, createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }) };
  globalThis.Vue = { reactive: (o) => o };
  globalThis.location = { search, pathname: '/dashboard' };
  const mem = new Map();
  globalThis.sessionStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
  };
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    return { ok: true, status: 200, json: async () => ({}) };
  };
  globalThis.EventSource = class { constructor(u) { this.url = u; } };
  // legacy 文件尾部会做 DOM 初始化（addEventListener/innerHTML 等），在 Node 里必然失败；
  // 但 __get/__post/__api 在其之前已定义——本用例只关心令牌传输，故容错导入。
  try {
    await import(pathToFileURL(CORE).href + '?v=' + Math.random());   // 每次独立执行
  } catch (e) {
    if (!globalThis.window.__get) throw e;   // 若连 __get 都没定义，说明不是 DOM 初始化问题
  }
  return calls;
}

test('legacy get/post：走 Authorization 头，URL 不含 token（issue #217）', async () => {
  const calls = await loadLegacy('?token=abc123');
  await globalThis.window.__get('/api/dashboard/x');
  assert.equal(calls[0].url, '/api/dashboard/x');
  assert.ok(!String(calls[0].url).includes('token='), 'URL 不得带 token');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer abc123');
  await globalThis.window.__post('/api/dashboard/y', { a: 1 });
  assert.equal(calls[1].url, '/api/dashboard/y');
  assert.equal(calls[1].opts.headers['Content-Type'], 'application/json');
  assert.equal(calls[1].opts.headers.Authorization, 'Bearer abc123');
});

test('legacy EventSource：仍用 query 形态（已知例外，无法自定义请求头）', async () => {
  await loadLegacy('?token=abc123');
  assert.equal(globalThis.window.__api('/api/dashboard/stream'), '/api/dashboard/stream?token=abc123');
});
