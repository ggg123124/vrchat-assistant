/**
 * X 博主世界推荐 handler — x_world_digest / x_add_creator / x_remove_creator / x_scan_creators / x_creators
 */

import { ctx, log } from '../server-context.js';
import {
  getCreators, addCreator, removeCreator,
  scanCreatorWorlds, getWorldDigest,
} from '../fetch-x-worlds.js';

/** 聚合查询：按时间窗口输出博主推荐的世界，按收藏排序，收藏/浏览比≥1/5 标注 */
export async function handleXWorldDigest({ days = 7, highlightRatio = 0.2, limit = 50, creator, refresh = false } = {}) {
  if (refresh) {
    await scanCreatorWorlds();
  }
  return getWorldDigest({ days, highlightRatio, limit, creator });
}

/** 立即抓取所有博主的最新推文并入库 */
export async function handleXScanCreators() {
  return scanCreatorWorlds();
}

/** 列出已配置博主 */
export function handleXCreators() {
  const { storage } = ctx;
  return { creators: getCreators(storage) };
}

/** 添加博主 */
export function handleXAddCreator({ screen_name, name } = {}) {
  const { storage } = ctx;
  const result = addCreator(storage, { screen_name, name });
  log(`➕ x-creator added: ${screen_name} (${name || ''})`);
  return result;
}

/** 移除博主 */
export function handleXRemoveCreator({ screen_name } = {}) {
  const { storage } = ctx;
  const result = removeCreator(storage, screen_name || '');
  if (result.removed) log(`➖ x-creator removed: ${screen_name}`);
  return result;
}

/** 查看已收录世界（调试用） */
export function handleXWorlds({ limit = 50 } = {}) {
  const { storage } = ctx;
  const rows = storage.getAllXWorlds(limit);
  return {
    total: rows.length,
    worlds: rows.map(r => ({
      worldId: r.world_id,
      worldName: r.world_name,
      authorName: r.author_name,
      favorites: r.favorites,
      visits: r.visits,
      popularity: r.popularity,
      lastRecommendedAt: r.last_recommended_at,
      tweetCount: r.tweet_count,
    })),
  };
}

// ── MCP 自声明工具表 ──
export const tools = [
  {
    "name": "x_world_digest",
    "description": "[查询·X推荐] 聚合指定 X 博主近 1/3/7/15/30 天推荐的世界，按收藏数排序输出；收藏/浏览比 ≥ 1/5 的标注为 ⭐重点。可选 refresh=true 先抓取最新推文再查询。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "days": {
          "type": "number",
          "description": "时间窗口天数：1/3/7/15/30，默认 7",
          "default": 7
        },
        "highlightRatio": {
          "type": "number",
          "description": "收藏/浏览比标注阈值，默认 0.2（五分之一）",
          "default": 0.2
        },
        "limit": {
          "type": "number",
          "description": "返回条数上限，默认 50",
          "default": 50
        },
        "creator": {
          "type": "string",
          "description": "只显示某博主（screen_name）推荐的世界，省略=全部"
        },
        "refresh": {
          "type": "boolean",
          "description": "是否先抓取博主最新推文再查询，默认 false",
          "default": false
        }
      }
    },
    handler: async (args) => handleXWorldDigest(args)
  },
  {
    "name": "x_scan_creators",
    "description": "[查询·X推荐] 立即抓取所有已配置博主的最新推文，提取推荐的世界并查询收藏/浏览数据入库。",
    "inputSchema": {
      "type": "object",
      "properties": {}
    },
    handler: async (args) => handleXScanCreators(args)
  },
  {
    "name": "x_creators",
    "description": "[查询·X推荐] 列出当前配置的 X 博主清单。",
    "inputSchema": {
      "type": "object",
      "properties": {}
    },
    handler: async (args) => handleXCreators(args)
  },
  {
    "name": "x_add_creator",
    "description": "[配置·X推荐] 添加要追踪的 X 博主（VRChat 世界推荐博主）。screen_name 是 X 用户名（不带 @）。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "screen_name": {
          "type": "string",
          "description": "X 用户名，如 fox_yata9（必填）"
        },
        "name": {
          "type": "string",
          "description": "博主显示名（可选）"
        }
      },
      "required": [
        "screen_name"
      ]
    },
    handler: async (args) => handleXAddCreator(args)
  },
  {
    "name": "x_remove_creator",
    "description": "[配置·X推荐] 移除追踪的 X 博主。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "screen_name": {
          "type": "string",
          "description": "X 用户名（不带 @）"
        }
      },
      "required": [
        "screen_name"
      ]
    },
    handler: async (args) => handleXRemoveCreator(args)
  },
  {
    "name": "x_worlds",
    "description": "[查询·X推荐] 查看已收录的推荐世界列表（调试用）。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "limit": {
          "type": "number",
          "description": "返回条数上限，默认 50",
          "default": 50
        }
      }
    },
    handler: async (args) => handleXWorlds(args)
  }
];
