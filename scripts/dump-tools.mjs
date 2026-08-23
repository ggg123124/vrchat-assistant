#!/usr/bin/env node
/**
 * dump-tools.mjs — 加载全部插件后，把 registry.listTools() 的工具名输出到 stdout（每行一个）。
 *
 * 供 scripts/check-doc-drift.py 等作为权威工具清单来源使用（插件化后工具分布在 core + 官方插件，
 * 需启动 PluginLoader 才能拿到完整 91 个工具名）。无凭据、无副作用，用临时 SQLite。
 */
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

const tools = registry.listTools();
for (const t of tools) console.log(t.name);

try { rmSync(tmpDb + '-wal', { force: true }); rmSync(tmpDb + '-shm', { force: true }); rmSync(tmpDb, { force: true }); } catch {}
process.exit(0);
