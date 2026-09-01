/**
 * MCP: recommend_worlds — 多源融合世界推荐（local world_kb × PlanetVRC 排行 × 官方主题搜索）
 *
 * 注意：本 handler 内部已对官方/planet API 调用逐请求限流，
 * rpc-router 分发时不能再包 rateLimiter.execute（嵌套死锁，参照 scan_new_worlds）。
 */

import { ctx } from '../server-context.js';
import { recommendWorlds } from '../recommend-worlds.js';

/**
 * @param {object} args {theme, excludeTheme, limit, sources, excludeVisited, detail}
 *   theme: sleep|chat|onsen|game|default（默认 default）
 *   excludeTheme: 逗号分隔主题（author_tag_* 或名称关键词命中即剔除）
 *   limit: 1-10（默认 5）
 *   sources: 逗号分隔 local,planet,official（默认 local,planet）
 *   excludeVisited: 排除已逛过的世界（默认 true）
 *   detail: 从 world_cache 补 description/imageUrl（默认 true）
 */
export async function handleRecommendWorlds({ theme = 'default', excludeTheme = '', limit = 5, sources = 'local,planet', excludeVisited = true, detail = true } = {}) {
  try {
    return await recommendWorlds(ctx, { theme, excludeTheme, limit, sources, excludeVisited, detail });
  } catch (e) {
    return {
      error: String((e && e.message) || e),
      recommended: [],
      sourcesUsed: [],
      skippedVisited: 0,
      total: 0,
    };
  }
}
