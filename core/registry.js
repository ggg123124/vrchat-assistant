/**
 * Tool registry — 收集自声明工具、提供 listTools / dispatch / safe-mode 过滤
 *
 * PR-2-1 改造：在核心工具注册表之外增加插件工具区，支持插件动态注册/移除工具。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ctx, log } from './server-context.js';
import { notifier } from './notifier.js';
import * as safeMode from './safe-mode.js';

// 导入所有自声明工具模块
import { tools as authTools } from './tools/auth.js';
import { tools as eventsTools } from './tools/events.js';
import { tools as friendsTools } from './tools/friends.js';
import { tools as instanceTools } from './tools/instance.js';
import { tools as miscTools } from './tools/misc.js';
import { tools as notificationsTools } from './tools/notifications.js';
import { tools as recommendTools } from './tools/recommend.js';
import { tools as recommendWorldsTools } from './tools/recommend-worlds.js';
import { tools as socialWriteTools } from './tools/social-write.js';
import { tools as xWorldsTools } from './tools/x-worlds.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ALL_TOOLS = [
  ...authTools,
  ...eventsTools,
  ...friendsTools,
  ...instanceTools,
  ...miscTools,
  ...notificationsTools,
  ...recommendTools,
  ...recommendWorldsTools,
  ...socialWriteTools,
  ...xWorldsTools,
];

const MANIFEST = JSON.parse(readFileSync(path.join(__dirname, 'tool-order.json'), 'utf-8'));
const ORDER = MANIFEST.tool_order;

// 核心工具注册表（PR-1 保留，键名 -> 完整 def）
const coreRegistry = new Map();

// 插件工具区：按注册顺序保存，同时提供 name -> def 的索引
const pluginTools = [];
const pluginToolMap = new Map();

export function registerTool(def) {
  if (!def || typeof def.name !== 'string') {
    log('[registry] registerTool: invalid def, skipping');
    return;
  }
  if (coreRegistry.has(def.name)) {
    log(`[registry] duplicate tool "${def.name}" — keeping first`);
    return;
  }
  const destructive = def.destructive ?? safeMode.DESTRUCTIVE_TOOLS.includes(def.name);
  coreRegistry.set(def.name, { ...def, destructive, origin: 'core' });
}

// 初始化注册核心工具
for (const def of ALL_TOOLS) {
  registerTool(def);
}

/**
 * 插件注册工具入口。
 * @param {object} def 工具定义（含 name / description / inputSchema / handler / destructive?）
 * @param {string} origin 来源插件名
 */
export function registerPluginTool(def, origin) {
  if (!def || typeof def.name !== 'string') {
    log(`[registry] registerPluginTool from ${origin}: invalid def, skipping`);
    return;
  }
  if (typeof def.handler !== 'function') {
    log(`[registry] plugin tool "${def.name}" from ${origin} missing handler, skipping`);
    return;
  }
  if (coreRegistry.has(def.name)) {
    throw new Error(`工具名冲突："${def.name}" 已由 core 注册`);
  }
  if (pluginToolMap.has(def.name)) {
    const existing = pluginToolMap.get(def.name);
    throw new Error(`工具名冲突："${def.name}" 已由 ${existing.origin} 注册`);
  }
  const destructive = def.destructive ?? safeMode.isDestructive(def.name);
  const tool = { ...def, destructive, origin };
  pluginTools.push(tool);
  pluginToolMap.set(def.name, tool);
}

/** 移除指定插件注册的全部工具 */
export function removePluginTools(origin) {
  for (let i = pluginTools.length - 1; i >= 0; i--) {
    if (pluginTools[i].origin === origin) {
      pluginToolMap.delete(pluginTools[i].name);
      pluginTools.splice(i, 1);
    }
  }
}

export function listTools() {
  const result = [];
  // PR-2-2: 整体遍历 ORDER，先核心、再插件，保证输出顺序与 tool-order.json 一致
  for (const name of ORDER) {
    const def = coreRegistry.get(name) || pluginToolMap.get(name);
    if (!def) {
      log(`[registry] tool "${name}" in manifest but not registered`);
      continue;
    }
    result.push({
      name: def.name,
      description: def.description,
      inputSchema: def.inputSchema,
    });
  }
  // 插件工具按注册顺序追加
  for (const def of pluginTools) {
    result.push({
      name: def.name,
      description: def.description,
      inputSchema: def.inputSchema,
    });
  }
  return safeMode.filterTools(result);
}

export async function dispatch(name, args) {
  // 插件工具优先（后加载的同名工具不可能存在，注册时已拦截冲突）
  const pluginDef = pluginToolMap.get(name);
  if (pluginDef) {
    safeMode.assertToolAllowed(name, pluginDef.destructive);
    return await pluginDef.handler(args);
  }

  const coreDef = coreRegistry.get(name);
  if (!coreDef) {
    throw new Error(`Unknown tool: ${name}`);
  }
  safeMode.assertToolAllowed(name, coreDef.destructive);
  try {
    return await coreDef.handler(args);
  } catch (err) {
    if (err.needsTotp) {
      ctx.serverState.needsTotp = true;
      log('🔑 检测到需要 TOTP 验证码，请调用 submit_totp 完成登录');
      notifier.notifyAuth('needsTotp', '运行期会话失效需 TOTP 验证码，服务暂停——请调用 submit_totp 提交当前验证码');
    }
    throw err;
  }
}

// 保留给测试/脚本使用：导出完整 Map（含 handler 与 origin）
export function getRegistryMap() {
  return new Map([...coreRegistry, ...pluginToolMap]);
}

/** 判断某个工具是否已注册 */
export function hasTool(name) {
  return coreRegistry.has(name) || pluginToolMap.has(name);
}

/** 获取插件区工具数组（供 loader 热重载回滚） */
export function getPluginTools() {
  return pluginTools;
}

/** 获取插件区 name->def 索引（供 loader 热重载回滚） */
export function getPluginToolMap() {
  return pluginToolMap;
}

export { safeMode };
