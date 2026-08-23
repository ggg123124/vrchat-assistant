/**
 * 收藏 handler — favorite_world 云端收藏（Issue #25）
 *
 * POST /favorites 把世界加入用户云端收藏夹分组。
 * 成功后写本地 world_cache.favorited = 1（供 recommend_worlds 反馈加权，免每次调 API 查收藏）。
 *
 * ⚠️ VRChat API 契约（官方文档 Add Favorite，2026-08 实测验证）：
 *   - favoriteId 必须是被收藏对象本身的 ID（world 类型为 wrld_...），不是收藏分组 ID；
 *     传分组名（worldsN）会被 400 拒绝（"favoriteId must be an ID"），传 fvgrp_ 分组 ID 会按对象 ID 校验失败。
 *   - 分组通过 tags 数组指定（tags: ["worlds1"]），无 worldId 字段。
 */

import { ctx, log } from '../server-context.js';

const FAVORITE_TAGS = ['worlds0', 'worlds1', 'worlds2', 'worlds3', 'worlds4'];
const DEFAULT_TAG = 'worlds0';

export async function handleFavoriteWorld({ worldId, tag }) {
  const { api, storage } = ctx;
  if (!worldId || typeof worldId !== 'string' || !worldId.startsWith('wrld_')) {
    throw new Error('worldId is required and must start with wrld_');
  }
  if (tag == null || tag === '') tag = DEFAULT_TAG;
  if (!FAVORITE_TAGS.includes(tag)) {
    throw new Error(`tag must be one of ${FAVORITE_TAGS.join('/')} (got "${tag}")`);
  }

  const body = { type: 'world', favoriteId: worldId, tags: [tag] };
  const r = await api._request('POST', '/favorites', body);
  if (r.status >= 400) {
    // 透传 API 错误（如重复收藏同分组被拒），不崩溃
    const msg = typeof r.data?.error?.message === 'string'
      ? r.data.error.message
      : (typeof r.data === 'string' && r.data ? r.data : '');
    return {
      worldId,
      favorited: false,
      tag,
      error: { status: r.status, message: msg || `API error ${r.status}` },
    };
  }

  storage.setWorldFavorited({ worldId, favorited: 1 });
  const result = { worldId, favorited: true, tag };
  const name = storage.getWorldName(worldId)?.name || r.data?.name || r.data?.displayName;
  if (name) result.displayName = name;
  log(`⭐ 云端收藏: ${worldId} → ${tag}`);
  return result;
}

// ── MCP 自声明工具表 ──
export const tools = [
  {
    "name": "favorite_world",
    "description": "[action·写操作] 把世界加入你的 VRChat 云端收藏夹（POST /favorites，云端写入，调用前请与用户确认）。tag 为收藏分组（worlds0/worlds1/worlds2/worlds3/worlds4，默认 worlds0）。成功后本地 world_cache 标记 favorited=1（供推荐加权）。API 拒绝（如重复收藏）时返回 favorited:false + error，不抛错。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "worldId": {
          "type": "string",
          "description": "VRChat world id (wrld_...)"
        },
        "tag": {
          "type": "string",
          "description": "收藏夹分组 tag（worlds0/worlds1/worlds2/worlds3/worlds4，默认 worlds0）"
        }
      },
      "required": [
        "worldId"
      ]
    },
    handler: async (args) => ctx.rateLimiter.execute(() => handleFavoriteWorld(args))
  }
];
