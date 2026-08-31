export const CACHE_TTLS = Object.freeze({
  homeFavorites: 5 * 60_000,     // 首页收藏好友位置：数据变化不频繁，5 分钟
  avatars: 30 * 60_000,          // 我的模型（3 个限流请求 ~5s）：用户模型列表很少变，30 分钟
  moderation: 30 * 60_000,       // 屏蔽管理（2 个限流请求 ~5s）：屏蔽列表很少变，30 分钟
  favoriteWorlds: 30 * 60_000,   // 收藏世界（逐个查详情 ~7s）：30 分钟
  favoriteFriends: 10 * 60_000,  // 收藏好友：10 分钟
  coPlay: 10 * 60_000,           // 最近一起玩（DB 聚合 7 天同屏）：10 分钟
});

export function createDashboardState() {
  return {
    homeFavorites: { at: 0, data: null },
    avatars: { at: 0, data: null },
    moderation: { at: 0, data: null },
    favoriteWorlds: { at: 0, data: null },
    favoriteFriends: { at: 0, data: null },
    coPlay: { at: 0, data: null },
    worldRefillRunning: false,
  };
}

export function getCached(state, key) {
  const entry = state[key];
  const ttl = CACHE_TTLS[key];
  if (!entry || !ttl || !entry.data) return null;
  return Date.now() - entry.at < ttl ? entry.data : null;
}

export function setCached(state, key, data, at = Date.now()) {
  if (!state[key]) throw new Error(`未知 Dashboard 缓存: ${key}`);
  state[key].at = at;
  state[key].data = data;
  return data;
}
