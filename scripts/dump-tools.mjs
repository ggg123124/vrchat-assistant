#!/usr/bin/env node
/**
 * dump-tools.mjs — 加载全部插件后，把 registry.listTools() 的工具名输出到 stdout（每行一个）。
 *
 * 供 scripts/check-doc-drift.py 等作为权威工具清单来源使用（插件化后工具分布在 core + 官方插件，
 * 需启动 PluginLoader 才能拿到完整 92 个工具名）。无凭据、无副作用，用临时 SQLite。
 */
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── stdout 是**数据通道**（每行一个工具名，供 check-doc-drift.py 解析），必须与日志通道隔离 ──
// 插件加载期 core/logger.js 写出的 INFO 行会混进 stdout 并被当成工具名——实测 2026-09-22：
// events 插件加载失败时 3 行 `[registry] tool "..." in manifest but not registered` 被
// check-doc-drift.py 解析成工具名，误报「新增工具未登记」+「skill 引用了不存在的工具」。
// 同时本脚本承诺"无副作用"：文件通道一并关闭，避免每跑一次就往生产 logs/ 写噪音。
// 注意必须在**动态 import 之前**设置（logger 惰性初始化，首个 write() 时读 env）；
// 需调试插件加载日志时请另写诊断脚本（给 PluginLoader 传自定义 log），不要放开这里。
process.env.VRC_MONITOR_LOGGER_LEVEL = 'silent';
process.env.VRC_MONITOR_LOGGER_FILE = '0';

const { ctx } = await import(pathToFileURL(path.join(__dirname, '..', 'core', 'server-context.js')).href);
const { Storage } = await import(pathToFileURL(path.join(__dirname, '..', 'core', 'storage.js')).href);
const { PluginLoader } = await import(pathToFileURL(path.join(__dirname, '..', 'core', 'plugin-loader.js')).href);
const registry = await import(pathToFileURL(path.join(__dirname, '..', 'core', 'registry.js')).href);

const tmpDb = path.join(os.tmpdir(), 'vrmon-dump-' + Date.now() + '.sqlite3');
ctx.storage = new Storage();
await ctx.storage.init(tmpDb);
ctx.serverState = { started: null, authUser: null, needsOtp: false, needsTotp: false };
ctx.rateLimiter = { execute: async (fn) => fn() };
ctx.api = null;
const loader = new PluginLoader({ registry, ctx, log: () => {}, notifier: { notifyAuth: () => {} } });
// 复现 start-monitor 的 registerCoreServices 白名单
const whitelist = ['getGroupCached','upsertGroupCache','getGroupHeat','setWorldFavorited','getWorldName','upsertWorld','getZhTranslations','getBoothItemCache','upsertBoothItem','listBoothItems','recordBoothSearch','getBoothSearches','getPlanetCache','setPlanetCache'];
for (const n of whitelist) {
  if (typeof ctx.storage[n] === 'function') { const svc = 'storage.' + n; loader.services.set(svc, (...a) => ctx.storage[n](...a)); loader.serviceOwners.set(svc, 'core'); }
}
await loader.loadAll();

// ── 工具清单**残缺**时必须响亮失败，绝不输出短清单（三种形态都实测过）──
// 为什么：下游 check-doc-drift.py 把 stdout 当权威清单。清单短了它不会说「清单不可信」，
//   而会去报「skill 引用了不存在的工具」—— **环境坏了却让文档背锅**，排查方向被整个带偏。
//   宁可在这里 exit != 0，让它直接报真因。
const status = loader.getStatus();

// 形态 B（审核指出后实测复现）：plugins/ 目录整体缺失或路径不对 ⇒ getStatus() 连一个插件
//   都扫不到 ⇒ 下面那条「逐个查插件状态」的守卫天然为空、不会触发，照旧静默吐短清单
//   （实测：dump 46 行、exit 0，下游报 80 处假死引用）。
//   ⇒ 必须先判「有没有扫到插件」，再判「扫到的插件里有没有失败的」。
if (!status.length) {
  console.error('[dump-tools] 一个插件都没扫到（plugins/ 目录缺失或路径不对？）→ 工具清单不完整，终止');
  process.exit(2);
}

// 形态 A（实测：隔离 worktree 漏挂 plugins/official/emoji-notes/node_modules，
//   该插件自带依赖 pinyin-pro ⇒ 少 3 个工具 ⇒ 下游报 3 处假死引用）。
//   注意：'disabled' 只在**运行时卸载插件**时出现（core/plugin-loader.js:535），
//   新起进程里每个插件非 loaded 即 error ⇒ 按 'error' 过滤不会误伤。
const failedPlugins = status.filter((p) => p.status === 'error');
if (failedPlugins.length) {
  for (const p of failedPlugins) {
    console.error(`[dump-tools] 插件加载失败: ${p.name} — ${p.error || '未知原因'}`);
  }
  console.error(
    `[dump-tools] ${failedPlugins.length} 个插件未加载，工具清单不完整 → 终止。` +
    `（不是文档漂移；先修环境：依赖是否装齐、每个插件子目录的 node_modules 是否就位）`
  );
  process.exit(2);
}

const tools = registry.listTools();

// 形态 C：数量自校验。CI 已有同款断言（行数 == core/tool-order.json 的 tool_order），
//   内置进来是为了让**本地/开发环境**的 check-doc-drift 也拿到硬门禁，而不只依赖 CI。
//   读不到 tool-order.json 只告警不终止：这层是加固，不该自己变成新的失败点。
try {
  const expected = JSON.parse(
    readFileSync(path.join(__dirname, '..', 'core', 'tool-order.json'), 'utf8')
  ).tool_order?.length;
  if (Number.isInteger(expected) && tools.length !== expected) {
    console.error(
      `[dump-tools] 工具数 ${tools.length} != core/tool-order.json 的 ${expected} → 清单不完整，终止`
    );
    process.exit(2);
  }
} catch (err) {
  console.error(`[dump-tools] 跳过数量自校验（读不到 core/tool-order.json: ${err.message}）`);
}
for (const t of tools) console.log(t.name);

try { rmSync(tmpDb + '-wal', { force: true }); rmSync(tmpDb + '-shm', { force: true }); rmSync(tmpDb, { force: true }); } catch {}
process.exit(0);
