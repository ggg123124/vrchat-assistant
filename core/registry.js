/**
 * Tool registry — 收集自声明工具、提供 listTools / dispatch / safe-mode 过滤
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ctx, log } from './server-context.js';
import { notifier } from './notifier.js';
import * as safeMode from './safe-mode.js';

// 导入所有自声明工具模块
import { tools as authTools } from './tools/auth.js';
import { tools as boothTools } from './tools/booth.js';
import { tools as eventsTools } from './tools/events.js';
import { tools as favoritesTools } from './tools/favorites.js';
import { tools as favoriteWorldsTools } from './tools/favorite-worlds.js';
import { tools as friendFavoritesTools } from './tools/friend-favorites.js';
import { tools as friendsTools } from './tools/friends.js';
import { tools as groupsTools } from './tools/groups.js';
import { tools as instanceTools } from './tools/instance.js';
import { tools as mediaTools } from './tools/media.js';
import { tools as miscTools } from './tools/misc.js';
import { tools as notificationsTools } from './tools/notifications.js';
import { tools as planetTools } from './tools/planet.js';
import { tools as recommendTools } from './tools/recommend.js';
import { tools as recommendWorldsTools } from './tools/recommend-worlds.js';
import { tools as socialWriteTools } from './tools/social-write.js';
import { tools as xWorldsTools } from './tools/x-worlds.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ALL_TOOLS = [
  ...authTools,
  ...boothTools,
  ...eventsTools,
  ...favoritesTools,
  ...favoriteWorldsTools,
  ...friendFavoritesTools,
  ...friendsTools,
  ...groupsTools,
  ...instanceTools,
  ...mediaTools,
  ...miscTools,
  ...notificationsTools,
  ...planetTools,
  ...recommendTools,
  ...recommendWorldsTools,
  ...socialWriteTools,
  ...xWorldsTools,
];

const MANIFEST = JSON.parse(readFileSync(path.join(__dirname, 'tool-order.json'), 'utf-8'));
const ORDER = MANIFEST.tool_order;

const registry = new Map();

export function registerTool(def) {
  if (!def || typeof def.name !== 'string') {
    log('[registry] registerTool: invalid def, skipping');
    return;
  }
  if (registry.has(def.name)) {
    log(`[registry] duplicate tool "${def.name}" — keeping first`);
    return;
  }
  const destructive = def.destructive ?? safeMode.DESTRUCTIVE_TOOLS.includes(def.name);
  registry.set(def.name, { ...def, destructive });
}

// 初始化注册
for (const def of ALL_TOOLS) {
  registerTool(def);
}

export function listTools() {
  const result = [];
  for (const name of ORDER) {
    const def = registry.get(name);
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
  return safeMode.filterTools(result);
}

export async function dispatch(name, args) {
  const def = registry.get(name);
  if (!def) {
    throw new Error(`Unknown tool: ${name}`);
  }
  safeMode.assertToolAllowed(name);
  try {
    return await def.handler(args);
  } catch (err) {
    if (err.needsTotp) {
      ctx.serverState.needsTotp = true;
      log('🔑 检测到需要 TOTP 验证码，请调用 submit_totp 完成登录');
      notifier.notifyAuth('needsTotp', '运行期会话失效需 TOTP 验证码，服务暂停——请调用 submit_totp 提交当前验证码');
    }
    throw err;
  }
}

// 保留给测试/脚本使用：导出完整 Map（含 handler）
export function getRegistryMap() {
  return new Map(registry);
}

export { safeMode };
