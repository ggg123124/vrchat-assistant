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

// ── 插件没全加载 = 工具清单**残缺**，必须响亮失败，绝不输出短清单 ──
// 实测 2026-09-26：隔离 worktree 里只挂了顶层 node_modules、漏了插件自己的
//   plugins/official/emoji-notes/node_modules（该插件自带依赖 pinyin-pro），
//   emoji-notes 加载失败 ⇒ dump 少 3 个工具 ⇒ check-doc-drift.py 把它报成
//   「skill 引用了不存在的工具」（假漂移，真因是环境）——排查方向被整个带偏。
// 下游拿到残缺清单只会去改文档；宁可在这里 exit != 0，让它直接报「清单不可信」。
// 注意：故意禁用的插件 status 是 'disabled'，不在此列，不会误伤。
const failedPlugins = loader.getStatus().filter((p) => p.status === 'error');
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
for (const t of tools) console.log(t.name);

try { rmSync(tmpDb + '-wal', { force: true }); rmSync(tmpDb + '-shm', { force: true }); rmSync(tmpDb, { force: true }); } catch {}
process.exit(0);
