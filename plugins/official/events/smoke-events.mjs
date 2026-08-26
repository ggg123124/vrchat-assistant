#!/usr/bin/env node
/**
 * test-events-plugin.mjs — events 插件冒烟测试
 * =====================================================================
 * 验证「events」插件能被框架加载、register(api) 成功、fetch_community_events
 * 注册进注册表、并能 dispatch 到真实 handler（不触发真实 VRChat API 时的
 * 行为：0 数据源返回空 / 有配置时开始采集）。
 *
 * 用法：node test-events-plugin.mjs
 *       EVS_SOURCES=cache(默认) 只验证注册与 dispatch，不发网络
 *       EVS_SOURCES=live         尝试真实采集（需要 Google key 已配置）
 * 退出码：0=PASS / 1=FAIL
 */
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

// ── 向上找仓库根 ──
let REPO_ROOT = __dirname;
while (!existsSync(path.join(REPO_ROOT, 'core', 'plugin-loader.js'))) {
  const parent = path.dirname(REPO_ROOT);
  if (parent === REPO_ROOT) { console.error('无法定位仓库根'); process.exit(2); }
  REPO_ROOT = parent;
}

const TOOL = 'fetch_community_events';
const { ctx } = await import(pathToFileURL(path.join(REPO_ROOT, 'core', 'server-context.js')).href);
const { Storage } = await import(pathToFileURL(path.join(REPO_ROOT, 'core', 'storage.js')).href);
const { PluginLoader } = await import(pathToFileURL(path.join(REPO_ROOT, 'core', 'plugin-loader.js')).href);
const registry = await import(pathToFileURL(path.join(REPO_ROOT, 'core', 'registry.js')).href);

let pass = true;
const fail = (m) => { pass = false; console.error(' -', m); };

// ── 运行时（临时 DB + 加载全部插件）────────────────────────
const os_tmpdir = () => process.env.TEMP || process.env.TMP || '/tmp';
const tmpDb = path.join(os_tmpdir(), 'evs-smoke-' + Date.now() + '.sqlite3');
for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) { try { rmSync(f, { force: true }); } catch {} }
ctx.storage = new Storage();
await ctx.storage.init(tmpDb);
ctx.serverState = { started: null, authUser: null, needsOtp: false, needsTotp: false };
ctx.rateLimiter = { execute: async (fn) => fn() };
ctx.api = null;
const log = () => {};
const notifier = { notifyAuth: () => {} };
const loader = new PluginLoader({ registry, ctx, log, notifier });
const whitelist = ['getGroupCached','upsertGroupCache','getGroupHeat'];
for (const n of whitelist) { if (typeof ctx.storage[n] === 'function') { const svc = 'storage.' + n; loader.services.set(svc, (...a) => ctx.storage[n](...a)); loader.serviceOwners.set(svc, 'core'); } }
await loader.loadAll();

// ── 断言 1：工具已注册 ──
if (!registry.hasTool(TOOL)) {
  fail(`工具 ${TOOL} 未注册（events 插件未加载或 registerTool 未调用）`);
} else {
  console.log(`[OK] 工具 ${TOOL} 已注册 (hasTool=true)`);
}
// events 插件全套工具清单
const EVS_TOOLS = ['fetch_community_events', 'get_community_events_config', 'set_community_events_google_key'];
for (const t of EVS_TOOLS) {
  if (registry.hasTool(t)) console.log(`[OK] 工具 ${t} 已注册`);
  else fail(`工具 ${t} 未注册`);
}

// ── 断言 2：插件在 /health 可见的 plugins 状态里 ──
const pluginMeta = loader.getPluginStates ? loader.getPluginStates() : [];
const evsMeta = Array.isArray(pluginMeta) ? pluginMeta.find(p => p.name === 'events') : null;
if (evsMeta) {
  console.log(`[OK] events 插件状态: ${evsMeta.status || 'loaded'} version=${evsMeta.version || '?'}`);
  if (evsMeta.error) fail(`events 插件加载报错: ${evsMeta.error}`);
} else {
  console.log('[-] getPluginStates 不可用或未找到 events（不影响 dispatch 断言）');
}

// ── 断言 3：dispatch 到 handler（用 sources 空串避免真实网络；应返回结构化对象而非 Unknown tool）──
try {
  const mode = process.env.EVS_SOURCES || 'cache';
  const args = mode === 'live' ? {} : { sources: 'rlvrc', window: 'week', focus: 'all', maxMine: 0, limit: 20 };
  const r = await registry.dispatch(TOOL, args);
  if (r && typeof r === 'object') {
    console.log(`[OK] dispatch 返回对象 keys: ${Object.keys(r).join(', ')}`);
    if (r.counts) console.log(`[OK] counts: ` + JSON.stringify(r.counts));
    if (r.error) fail(`dispatch 返回 error: ${r.error}`);
  } else {
    fail('dispatch 返回非对象');
  }
} catch (err) {
  if (err.message && err.message.startsWith('Unknown tool')) fail(`dispatch 报 Unknown tool: ${err.message}`);
  else console.log(`[OK] dispatch 到达 handler（业务错误而非 Unknown tool）: ${err.message}`);
}

// ── 清理 ──
for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) { try { rmSync(f, { force: true }); } catch {} }

// ── 断言 4：tool-order.json 已登记该工具名（DRIFT 门控）──
try {
  const fs = await import('node:fs');
  const order = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'core', 'tool-order.json'), 'utf-8'));
  const inOrder = (order.tool_order || []).includes(TOOL);
  if (inOrder) console.log(`[OK] tool-order.json 已登记 ${TOOL}`);
  else fail(`tool-order.json 未登记 ${TOOL}（插件工具需入 tool_order 才会出现在 tools/list）`);
} catch (e) {
  fail(`无法读 tool-order.json: ${e.message}`);
}

console.log(pass ? '\nevents plugin smoke: PASS' : '\nevents plugin smoke: FAIL');
process.exit(pass ? 0 : 1);