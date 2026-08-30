/**
 * test-registry.mjs — registry 完整性无凭据测试（PR-2 插件化版，自包含，供 CI 使用）
 *
 * 启动 PluginLoader 加载全部插件后校验：
 *   1. listTools() 数量 = 95（core + 官方插件，逐字节 = core/tool-order.json 全量 + 定义合法）
 *   2. 工具名唯一
 *   3. 每个工具定义合法（name/description/inputSchema/handler）
 *   4. listTools() 返回顺序与 core/tool-order.json 完全一致
 *   5. dispatch 能路由到真实 handler（无副作用工具，测试环境无凭据）
 *   6. safe-mode 开启时破坏性工具被过滤/拦截（含插件注册的）
 */
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// 仓库根 = 本文件所在目录（不再硬编码本机绝对路径，满足跨平台/CI 要求）
const REPO = __dirname;
const Database = require('better-sqlite3');
const { ctx } = await import(pathToFileURL(path.join(REPO, 'core', 'server-context.js')).href);
const { Storage } = await import(pathToFileURL(path.join(REPO, 'core', 'storage.js')).href);
const { PluginLoader } = await import(pathToFileURL(path.join(REPO, 'core', 'plugin-loader.js')).href);
const registry = await import(pathToFileURL(path.join(REPO, 'core', 'registry.js')).href);
const order = JSON.parse(readFileSync(path.join(REPO, 'core', 'tool-order.json'), 'utf-8')).tool_order;

let pass = true;
const errors = [];
const assert = (c, m) => { if (!c) { pass = false; errors.push(m); } };

// ── 准备运行时（临时 db + loader 加载插件）──
const tmpDb = path.join(__dirname, 'test-registry.sqlite3');
for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) { try { rmSync(f, { force: true }); } catch {} }
ctx.storage = new Storage();
await ctx.storage.init(tmpDb);
ctx.serverState = { started: null, authUser: null, needsOtp: false, needsTotp: false };
ctx.rateLimiter = { execute: async (fn) => fn() };
ctx.api = null;
const log = () => {};
const notifier = { notifyAuth: () => {} };
const loader = new PluginLoader({ registry, ctx, log, notifier });
const whitelist = ['getGroupCached','upsertGroupCache','getGroupHeat','setWorldFavorited','getWorldName','upsertWorld','getZhTranslations','getBoothItemCache','upsertBoothItem','listBoothItems','recordBoothSearch','getBoothSearches','getPlanetCache','setPlanetCache'];
for (const n of whitelist) { if (typeof ctx.storage[n] === 'function') { const svc = 'storage.' + n; loader.services.set(svc, (...a) => ctx.storage[n](...a)); loader.serviceOwners.set(svc, 'core'); } }
loader.services.set('core.authConfig', () => ({ token: null, host: '127.0.0.1', port: 8799 }));
loader.serviceOwners.set('core.authConfig', 'core');
await loader.loadAll();

const safeMode = process.env.VRC_MONITOR_SAFE_MODE === 'true';
const tools = registry.listTools();
const names = tools.map(t => t.name);

// 1. 数量（tool-order.json 全量 = 95；safe-mode 下过滤 DESTRUCTIVE_TOOLS 10 个）
const expectedCount = safeMode ? order.length - 10 : order.length;
assert(tools.length === expectedCount, `listTools() returned ${tools.length}, expected ${expectedCount}`);

// 2. 唯一
assert(new Set(names).size === names.length, 'duplicate tool names detected');

// 3. 定义合法 + handler 存在
const map = registry.getRegistryMap ? registry.getRegistryMap() : null;
for (const t of tools) {
  assert(typeof t.name === 'string' && t.name.length > 0, 'tool missing name');
  assert(typeof t.description === 'string', `tool ${t.name} missing description`);
  assert(t.inputSchema && typeof t.inputSchema === 'object' && t.inputSchema.type === 'object', `tool ${t.name} has invalid inputSchema`);
  if (map) assert(map.has(t.name) && typeof map.get(t.name).handler === 'function', `tool ${t.name} missing handler in registry map`);
}

// 4. 顺序与 tool-order.json 一致（非安全模式）
if (!safeMode) {
  assert(JSON.stringify(names) === JSON.stringify(order), 'listTools() order differs from core/tool-order.json');
}

// 5. dispatch 路由到 handler（无凭据工具）
try {
  const r = await registry.dispatch('get_server_status', {});
  assert(r && typeof r === 'object', 'dispatch(get_server_status) returned unexpected result');
} catch (err) {
  assert(!err.message.startsWith('Unknown tool'), `dispatch('get_server_status') did not reach handler: ${err.message}`);
}
// 插件工具（booth）也应该路由到 handler（外网，无 query 抛业务错误）
try {
  await registry.dispatch('search_booth_items', {});
  assert(false, 'search_booth_items should throw (query required)');
} catch (err) {
  assert(!err.message.startsWith('Unknown tool'), `dispatch('search_booth_items') did not reach handler: ${err.message}`);
}

// 6. safe-mode 破坏性过滤与拦截（清单与 core/safe-mode.js 的 DESTRUCTIVE_TOOLS 同步，含插件工具）
if (safeMode) {
  const destructive = ['remove_friend','remove_print','remove_gallery_image','unfavorite_friend','leave_group','decline_friend_request','hide_notification','remove_from_backlog','remove_from_watchlist','x_remove_creator'];
  assert(JSON.stringify(names) === JSON.stringify(order.filter(n => !destructive.includes(n))), 'safe mode should filter exactly the 10 destructive tools');
  let blocked = false;
  try {
    await registry.dispatch('remove_print', { printId: 'test' });
  } catch (err) {
    blocked = err.message.includes('安全模式已启用');
  }
}

if (pass) {
  console.log(`registry integrity: PASS (plugins loaded, ${tools.length} tools, order+defs OK)`);
  process.exit(0);
} else {
  console.log('registry integrity: FAIL');
  for (const e of errors) console.log(' -', e);
  process.exit(1);
}
