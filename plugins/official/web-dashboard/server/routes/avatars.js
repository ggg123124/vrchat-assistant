import { parseLimit, readJsonBody, sendJson } from '../http.js';
import { getCached, setCached } from '../state.js';

// /auth/user 结果缓存：uid 与当前模型短时间内不变，避免每次冷缓存都串行多 1 个限流请求
let meCache = { at: 0, data: null };
const ME_TTL = 30_000;
export async function loadMe(api, fresh = false) {
  if (!fresh && meCache.data && Date.now() - meCache.at < ME_TTL) return meCache.data;
  const me = await api.vrchat.fetch('/auth/user');
  meCache = { at: Date.now(), data: me };
  return me;
}

// 拉取我的模型列表 + 收藏 + 当前使用（内部：auth/user → avatars 串行，favorites 并行）
async function loadAvatarsPayload(api, limit) {
  const me = await loadMe(api);
  const uid = me && me.id ? me.id : 'me';
  let uploaded = [];
  try {
    uploaded = await api.vrchat.fetch(`/avatars?userId=${encodeURIComponent(uid)}&n=${limit}&sort=updated&releaseStatus=all`);
  } catch {
    uploaded = await api.vrchat.fetch(`/avatars?userId=${encodeURIComponent(uid)}&n=${limit}&sort=updated`);
  }
  const [favoriteResult] = await Promise.allSettled([
    api.vrchat.fetch(`/avatars/favorites?n=${limit}`),
  ]);
  const avatars = (Array.isArray(uploaded) ? uploaded : []).map(avatar => ({
    avatarId: avatar.id,
    name: avatar.name,
    description: avatar.description || '',
    imageUrl: avatar.thumbnailImageUrl || avatar.imageUrl || '',
    releaseStatus: avatar.releaseStatus || '',
    version: avatar.version || 0,
    unityVersion: avatar.unityVersion || '',
    authorName: avatar.authorName || '',
    featured: !!avatar.featured,
  }));
  const favoriteAvatars = (favoriteResult.status === 'fulfilled' && Array.isArray(favoriteResult.value)
    ? favoriteResult.value : []).map(avatar => ({
      avatarId: avatar.id,
      name: avatar.name,
      releaseStatus: avatar.releaseStatus || '',
      imageUrl: avatar.thumbnailImageUrl || avatar.imageUrl || '',
      version: avatar.version || 0,
    }));
  return {
    count: avatars.length,
    avatars,
    favoriteAvatars,
    current: me ? {
      avatarId: me.currentAvatar || '',
      name: (avatars.find(a => a.avatarId === me.currentAvatar) || {}).name || '',
      imageUrl: me.currentAvatarImageUrl || me.currentAvatarThumbnailImageUrl || '',
    } : null,
  };
}

// avatar 详情缓存（VRChat API 限流，模型详情少变：30 分钟 + stale-while-revalidate，对齐 VRCX 本地库思路）
const avatarDetailCache = new Map();
const AVATAR_DETAIL_TTL = 30 * 60_000;
async function loadAvatarDetail(api, avatarId) {
  const avatar = await api.vrchat.fetch(`/avatars/${avatarId}`);
  return {
    avatarId: avatar.id,
    name: avatar.name,
    description: avatar.description || '',
    imageUrl: avatar.thumbnailImageUrl || avatar.imageUrl || '',
    authorName: avatar.authorName || '',
    releaseStatus: avatar.releaseStatus || '',
    version: avatar.version || 0,
    unityVersion: avatar.unityVersion || '',
    featured: !!avatar.featured,
    tags: Array.isArray(avatar.tags) ? avatar.tags : [],
    stats: avatar.avatarStats || null,
  };
}

// 按 avatarId 取模型名（/me 的 currentAvatar 等），复用 30min 缓存
export async function loadAvatarName(api, avatarId) {
  if (!avatarId || typeof avatarId !== 'string' || !avatarId.startsWith('avtr_')) return '';
  const c = avatarDetailCache.get(avatarId);
  if (c && Date.now() - c.at < AVATAR_DETAIL_TTL) return c.data.name || '';
  try {
    const d = await loadAvatarDetail(api, avatarId);
    avatarDetailCache.set(avatarId, { at: Date.now(), data: d });
    return d.name || '';
  } catch {
    // 过期有旧数据：秒回旧名 + 后台刷新
    if (c) {
      loadAvatarDetail(api, avatarId)
        .then((d) => avatarDetailCache.set(avatarId, { at: Date.now(), data: d }))
        .catch(() => {});
      return c.data.name || '';
    }
    return '';
  }
}

export function registerAvatarRoutes(api, dashboardState) {
  api.http.registerRoute({
    method: 'GET',
    path: '/api/dashboard/moderation',
    handler: async (_req, res) => {
      const cached = getCached(dashboardState, 'moderation');
      if (cached) return sendJson(res, cached);
      const [blocked, muted] = await Promise.allSettled([
        api.vrchat.fetch('/auth/user/blocked'),
        api.vrchat.fetch('/auth/user/muted'),
      ]);
      const normalize = (arr) => (Array.isArray(arr) ? arr.map(user => ({
        userId: user.id,
        displayName: user.displayName,
        status: user.status || '',
        trustLevel: user.trustLevel || '',
        avatarImageUrl: user.currentAvatarImageUrl || user.currentAvatarThumbnailImageUrl || '',
      })) : []);
      const payload = {
        blocked: blocked.status === 'fulfilled' ? normalize(blocked.value) : null,
        muted: muted.status === 'fulfilled' ? normalize(muted.value) : null,
      };
      setCached(dashboardState, 'moderation', payload);
      sendJson(res, payload);
    },
  });

  // 解除屏蔽/静音（PUT /auth/user/unplayermoderate {moderated, type}——VRChat 无按 moderationId 删除，
  // 按 userId + type 操作；成功后失效缓存）。旧前端曾调本路由但后端从未实现（补全）。
  api.http.registerRoute({
    method: 'POST',
    path: '/api/dashboard/moderation/delete',
    handler: async (req, res) => {
      try {
        const body = await readJsonBody(req);
        const userId = (body && body.userId) || '';
        const type = (body && body.type) || '';
        if (!userId || !['block', 'mute'].includes(type)) {
          return sendJson(res, { error: 'bad-params: 需要 userId 与 type(block|mute)' });
        }
        // 解除屏蔽/静音属破坏性操作：安全模式下拦截（与 remove_from_watchlist 等走 tools.call 的工具一致）
        try {
          const snap = await api.consume('dashboard.snapshot');
          if (snap && snap.safeMode) {
            return sendJson(res, { error: '🔒 安全模式已启用：解除屏蔽/静音（unplayerModerate）属破坏性操作，已被禁用。' });
          }
        } catch { /* 快照不可用时放行（保持可用性） */ }
        await api.vrchat.unplayerModerate(userId, type);
        setCached(dashboardState, 'moderation', null); // 失效缓存，下次拉新
        sendJson(res, { ok: true });
      } catch (e) {
        sendJson(res, { error: String(e.message || e) });
      }
    },
  });

  api.http.registerRoute({
    method: 'GET',
    path: '/api/dashboard/avatars',
    handler: async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const limit = parseLimit(url.searchParams.get('limit') || 40, 30, 100);
      // 1) 有效缓存：直接返回
      const cached = getCached(dashboardState, 'avatars');
      if (cached) return sendJson(res, cached);
      // 2) 过期但有旧数据：先返回旧数据秒开，后台异步刷新（stale-while-revalidate）
      const stale = dashboardState.avatars && dashboardState.avatars.data;
      if (stale) {
        loadAvatarsPayload(api, limit)
          .then(payload => setCached(dashboardState, 'avatars', payload))
          .catch(() => {});
        return sendJson(res, stale);
      }
      // 3) 真正冷缓存：同步拉取
      try {
        const payload = await loadAvatarsPayload(api, limit);
        setCached(dashboardState, 'avatars', payload);
        sendJson(res, payload);
      } catch (e) {
        sendJson(res, { count: 0, avatars: [], favoriteAvatars: [], error: String(e.message || e) });
      }
    },
  });

  // avatar 详情缓存与 loadAvatarDetail/loadAvatarName 已提升到模块级（供 /me 复用）
  api.http.registerRoute({
    method: 'GET',
    path: '/api/dashboard/avatar',
    handler: async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const avatarId = url.searchParams.get('avatarId') || '';
      if (!avatarId) return sendJson(res, {});
      const c = avatarDetailCache.get(avatarId);
      if (c && Date.now() - c.at < AVATAR_DETAIL_TTL) return sendJson(res, c.data);
      if (c) {
        // 过期有旧数据：先返回秒开，后台刷新
        sendJson(res, c.data);
        loadAvatarDetail(api, avatarId).then((d) => avatarDetailCache.set(avatarId, { at: Date.now(), data: d })).catch(() => {});
        return;
      }
      try {
        const d = await loadAvatarDetail(api, avatarId);
        avatarDetailCache.set(avatarId, { at: Date.now(), data: d });
        sendJson(res, d);
      } catch (e) {
        sendJson(res, { error: String(e.message || e) });
      }
    },
  });
}
