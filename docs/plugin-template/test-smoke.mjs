#!/usr/bin/env node
/**
 * test-smoke.mjs — 插件冒烟骨架（无凭据，可选）
 * =====================================================================
 * 验证一个插件「能被框架加载 + register(api) 成功 + registerTool 注册进注册表」。
 *
 * 用法：把插件放到 plugins/local/<name>/（loader 会扫描它），然后运行本骨架：
 *   node docs/plugin-template/test-smoke.mjs
 *   # 或用环境变量指定要验证的工具名：
 *   PLUGIN_SMOKE_TOOL=<你的工具名> node docs/plugin-template/test-smoke.mjs
 *
 * 说明：本骨架会用临时 SQLite 启动 PluginLoader，加载全部插件（含 plugins/local/），
 *      然后断言指定工具已注册（hasTool=true）并能 dispatch 到真实 handler。
 *      不触发任何真实 VRChat API。退出码：0=PASS / 1=FAIL。
 * =====================================================================
 */
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

// ── 向上找到仓库根（标记：core/plugin-loader.js）───────────────────────
let REPO_ROOT = __dirname;
while (!existsSync(path.join(REPO_ROOT, 'core', 'plugin-loader.js'))) {
  const parent = path.dirname(REPO_ROOT);
  if (parent === REPO_ROOT) {
    console.error('无法定位仓库根（找不到 core/plugin-loader.js）');
    process.exit(2);
  }
  REPO_ROOT = parent;
}

// ── 待验证的工具名（改成你插件实际注册的名字）─────────────────────────
const TOOL = process.env.PLUGIN_SMOKE_TOOL || 'my_plugin_ping';

const { ctx } = await import(pathToFileURL(path.join(REPO_ROOT, 'core', 'server-context.js')).href);
const { Storage } = await import(pathToFileURL(path.join(REPO_ROOT, 'core', 'storage.js')).href);
const { PluginLoader } = await import(pathToFileURL(path.join(REPO_ROOT, 'core', 'plugin-loader.js')).href);
const registry = await import(pathToFileURL(path.join(REPO_ROOT, 'core', 'registry.js')).href);

let pass = true;
const fail = (m) => { pass = false; console.error(' -', m); };

// ── 准备运行时（临时 DB + loader 加载全部插件）────────────────────────
const tmpDb = path.join(os_tmpdir(), 'vrmon-smoke-' + Date.now() + '.sqlite3');
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
await loader.loadAll();

// ── 断言：工具已注册进注册表 ──────────────────────────────────────────
if (!registry.hasTool(TOOL)) {
  fail(`工具 ${TOOL} 未注册（register(api) 未执行或 registerTool 未被调用；确保插件已放入 plugins/local/<name>/ 且命名/工具名正确）`);
} else {
  console.log(`[OK] 工具 ${TOOL} 已注册（hasTool=true）`);
}

// 尝试 dispatch（自包含工具应返回对象；需凭据的工具会抛业务错误而非 Unknown tool）
try {
  const r = await registry.dispatch(TOOL, {});
  if (r && typeof r === 'object') console.log('[OK] dispatch 返回:', JSON.stringify(r));
  else fail(`dispatch(${TOOL}) 返回非对象`);
} catch (err) {
  if (!err.message.startsWith('Unknown tool')) {
    console.log(`[OK] dispatch(${TOOL}) 到达 handler（业务错误而非 Unknown tool）: ${err.message}`);
  } else {
    fail(`dispatch(${TOOL}) 报 Unknown tool`);
  }
}

for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) { try { rmSync(f, { force: true }); } catch {} }
console.log(pass ? 'plugin smoke: PASS' : 'plugin smoke: FAIL');
process.exit(pass ? 0 : 1);

function os_tmpdir() {
  // 跨平台临时目录（避免依赖 node:os 之外的东西）
  return process.env.TEMP || process.env.TMP || '/tmp';
}
