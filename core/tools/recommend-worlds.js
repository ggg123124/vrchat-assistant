/**
 * MCP: recommend_worlds — 多源融合世界推荐（local world_kb × PlanetVRC 排行 × 官方主题搜索）
 *
 * 注意：本 handler 内部已对官方/planet API 调用逐请求限流，
 * registry 分发时不能再包 rateLimiter.execute（嵌套死锁，参照 scan_new_worlds）。
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

// ── MCP 自声明工具表 ──
export const tools = [
  {
    "name": "recommend_worlds",
    "description": "[query·推荐] Multi-source world recommendation: fuses local world_kb + PlanetVRC popularity ranking + official theme search, scored by heat × user feedback × freshness × theme match × author affinity. Returns scored candidates with explainable reasons and canOpen flag (planet cards are resolved to wrld_ ids via official name lookup).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "theme": {
          "type": "string",
          "enum": [
            "sleep",
            "chat",
            "onsen",
            "game",
            "default"
          ],
          "default": "default",
          "description": "Theme to boost (sleep boosts sleep_ok worlds strongly; other themes boost keyword matches)"
        },
        "excludeTheme": {
          "type": "string",
          "description": "Comma-separated themes to exclude (matched against author_tag_* and name/description keywords, e.g. \"game,horror\")"
        },
        "limit": {
          "type": "number",
          "default": 5,
          "description": "Max results (1-10, default 5)"
        },
        "sources": {
          "type": "string",
          "default": "local,planet",
          "description": "Comma-separated sources: local (world_kb table), planet (PlanetVRC ranking), official (theme keyword search)"
        },
        "excludeVisited": {
          "type": "boolean",
          "default": true,
          "description": "Skip worlds already visited"
        },
        "detail": {
          "type": "boolean",
          "default": true,
          "description": "Enrich description/imageUrl/note from world_cache"
        }
      }
    },
    handler: async (args) => handleRecommendWorlds(args)
  }
];
