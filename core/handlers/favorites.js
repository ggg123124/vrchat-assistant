/**
 * 收藏 handler — favorite_world 云端收藏（Issue #25）
 *
 * POST /favorites 把世界加入用户云端收藏夹分组。
 * 成功后写本地 world_cache.favorited = 1（供 recommend_worlds 反馈加权，免每次调 API 查收藏）。
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

  const body = { type: 'world', favoriteId: tag, tags: [tag], worldId };
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
