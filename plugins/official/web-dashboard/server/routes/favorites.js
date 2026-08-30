import { parseLimit, readJsonBody, sendJson } from '../http.js';
import { CACHE_TTLS, getCached, setCached } from '../state.js';

// 收藏变更后失效相关缓存（world→favoriteWorlds；avatar→avatars；friend→favoriteFriends）
function invalidateFavCaches(state, type) {
  try {
    if (type === 'world') setCached(state, 'favoriteWorlds', null, 0);
    else if (type === 'friend') setCached(state, 'favoriteFriends', null, 0);
    else if (type === 'avatar') setCached(state, 'avatars', null, 0);
  } catch { /* 缓存键不存在时忽略 */ }
}

// 收藏世界加载（路由 + 后台刷新共用）：get_my_favorite_worlds 首次逐个查世界详情较慢
async function loadFavoriteWorlds(api, limit) {
  // 上游 get_my_favorite_worlds 已一次拉全（/worlds/favorites，秒级）且返回 favoriteGroup/worldName/imageUrl 等完整字段，
  // 无需再单独拉 /favorites 收藏分组（旧实现多一次限流请求，串行排队拖慢冷加载）
  const worldsRes = await api.tools.call('get_my_favorite_worlds', { limit });
  const worlds = (worldsRes && Array.isArray(worldsRes.worlds)) ? worldsRes.worlds : [];
  return { worlds, count: worlds.length, message: (worldsRes && worldsRes.message) || 'ok' };
}

export function registerFavoriteRoutes(api, dashboardState) {
  api.http.registerRoute({
    method: 'GET',
    path: '/api/dashboard/favorites',
    handler: async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const type = url.searchParams.get('type') || 'worlds';
      const limit = parseLimit(url.searchParams.get('limit') || 30, 30, 200);

      if (type === 'friends') {
        const cached = getCached(dashboardState, 'favoriteFriends');
        if (cached) return sendJson(res, cached);
        try {
          const favs = await api.vrchat.fetch('/favorites?type=friend');
          const list = (Array.isArray(favs) ? favs : []).map(f => ({
            userId: f.friendId || f.id || '',
            name: f.displayName || f.name || '',
            note: f.note || '',
            tags: Array.isArray(f.tags) ? f.tags : [],
          }));
          const payload = { count: list.length, favorites: list };
          setCached(dashboardState, 'favoriteFriends', payload);
          sendJson(res, payload);
        } catch (e) {
          sendJson(res, { count: 0, favorites: [], error: String(e.message || e) });
        }
      } else if (type === 'groups') {
        sendJson(res, await api.tools.call('get_my_favorite_groups', {}));
      } else if (type === 'avatars') {
        try {
          // 收藏记录（含 favoriteGroup 分组）+ 模型详情合并；
          // 区分「无收藏」与「API 失败」：收藏列表拉取失败时如实报错，不返回误导的空列表
          const [favsRes, avsRes] = await Promise.allSettled([
            api.vrchat.fetch('/favorites?type=avatar&n=100'),
            api.vrchat.fetch(`/avatars/favorites?n=${limit}`),
          ]);
          const favs = (favsRes.status === 'fulfilled' && Array.isArray(favsRes.value)) ? favsRes.value : null;
          const avs = (avsRes.status === 'fulfilled' && Array.isArray(avsRes.value)) ? avsRes.value : [];
          if (!favs) {
            return sendJson(res, { count: 0, avatars: [], error: '收藏列表拉取失败（限流或网络），请重试' });
          }
          const avMap = new Map((Array.isArray(avs) ? avs : []).map(a => [a.id, a]));
          const list = (Array.isArray(favs) ? favs : []).map(f => {
            const a = avMap.get(f.favoriteId) || {};
            return {
              favoriteId: f.id,      // 收藏记录 id（取消收藏用 DELETE /favorites/{id}）
              avatarId: f.favoriteId,
              group: (f.tags || [])[0] || '',
              name: a.name || f.name || '',
              imageUrl: a.thumbnailImageUrl || a.imageUrl || '',
              authorName: a.authorName || '',
              releaseStatus: a.releaseStatus || '',
            };
          });
          sendJson(res, { count: list.length, avatars: list });
        } catch (e) {
          sendJson(res, { count: 0, avatars: [], error: String(e.message || e) });
        }
      } else {
        const cached = getCached(dashboardState, 'favoriteWorlds');
        if (cached) return sendJson(res, cached);
        // stale-while-revalidate：有旧缓存先秒回，后台刷新（避免冷缓存 7s+ 干等）
        const stale = dashboardState.favoriteWorlds && dashboardState.favoriteWorlds.data;
        if (stale) {
          loadFavoriteWorlds(api, limit).then(payload => setCached(dashboardState, 'favoriteWorlds', payload)).catch(() => {});
          return sendJson(res, stale);
        }
        try {
          const payload = await loadFavoriteWorlds(api, limit);
          setCached(dashboardState, 'favoriteWorlds', payload);
          sendJson(res, payload);
        } catch (e) {
          sendJson(res, { worlds: [], count: 0, message: '加载失败', error: String(e.message || e) });
        }
      }
    },
  });

  // 取消收藏（世界/模型/好友）
  api.http.registerRoute({
    method: 'POST',
    path: '/api/dashboard/favorite-remove',
    handler: async (req, res) => {
      let body = {};
      try { body = await readJsonBody(req); } catch { return sendJson(res, { ok: false, error: 'bad body' }); }
      try {
        const { type, id } = body;
        if (!type || !id) return sendJson(res, { ok: false, error: 'type & id required' });
        if (type === 'world') {
          const r = await api.tools.call('unfavorite_world', { worldId: id, confirm: true });
          return sendJson(res, { ok: !!r.ok, removedGroups: r.removedGroups || [], error: r.error });
        }
        if (type === 'avatar' || type === 'friend') {
          const t = type === 'avatar' ? 'avatar' : 'friend';
          const favs = await api.vrchat.fetch(`/favorites?type=${t}&n=100`);
          const key = type === 'avatar' ? 'avatarId' : 'friendId';
          const rec = (Array.isArray(favs) ? favs : []).find(f => f.favoriteId === id || f[key] === id);
          if (!rec) return sendJson(res, { ok: false, error: '未找到收藏记录' });
          invalidateFavCaches(dashboardState, type);
          await api.vrchat.fetch(`/favorites/${rec.id}`, { method: 'DELETE' });
          return sendJson(res, { ok: true });
        }
        return sendJson(res, { ok: false, error: 'unknown type' });
      } catch (e) {
        return sendJson(res, { ok: false, error: String(e.message || e) });
      }
    },
  });

  // 收藏（世界）——加入云端收藏夹
  api.http.registerRoute({
    method: 'POST',
    path: '/api/dashboard/favorite-add',
    handler: async (req, res) => {
      let body = {};
      try { body = await readJsonBody(req); } catch { return sendJson(res, { ok: false, error: 'bad body' }); }
      try {
        if (!body.type || !body.id) return sendJson(res, { ok: false, error: 'type & id required' });
        if (body.type === 'world') {
          // 不显式传默认 tag：favorite_world 动态发现分组（worlds0 或首个可用；账号无 worlds0 时显式传会报错）
          const args = { worldId: body.id };
          if (body.group) args.tag = body.group;
          const r = await api.tools.call('favorite_world', args);
          if (r.favorited) invalidateFavCaches(dashboardState, 'world');
          return sendJson(res, { ok: !!r.favorited, tag: r.tag, error: r.error });
        }
        if (body.type === 'avatar' || body.type === 'friend') {
          // 通用收藏：POST /favorites {type, favoriteId, tags}（模型/好友收藏无独立 MCP 工具）
          const t = body.type === 'avatar' ? 'avatar' : 'friend';
          const r = await api.vrchat.fetch('/favorites', {
            method: 'POST',
            body: { type: t, favoriteId: body.id, tags: [body.group || (t === 'avatar' ? 'avatars1' : 'friends1')] },
          });
          if (r && r.id) invalidateFavCaches(dashboardState, body.type);
          return sendJson(res, { ok: !!(r && r.id), favoriteId: r && r.favoriteId, error: (r && r.error && r.error.message) || undefined });
        }
        return sendJson(res, { ok: false, error: 'unsupported type' });
      } catch (e) {
        return sendJson(res, { ok: false, error: String(e.message || e) });
      }
    },
  });

  // 移动收藏分组（move_world_group，删旧建新；安全模式下被拦截——破坏性工具）
  api.http.registerRoute({
    method: 'POST',
    path: '/api/dashboard/favorites/move',
    handler: async (req, res) => {
      try {
        const body = await readJsonBody(req);
        const worldId = (body && body.worldId) || '';
        const toGroup = (body && body.toGroup) || '';
        if (!worldId || !worldId.startsWith('wrld_') || !toGroup) {
          return sendJson(res, { ok: false, error: 'bad-params: 需要 worldId 与 toGroup' });
        }
        const r = await api.tools.call('move_world_group', { worldId, toGroup, confirm: true });
        if (r && r.moved) invalidateFavCaches(dashboardState, 'world');
        sendJson(res, r);
      } catch (e) {
        sendJson(res, { ok: false, error: String(e.message || e) });
      }
    },
  });

  // 收藏分组管理（update_favorite_group：重命名/公开私密切换；非破坏性，安全模式可用）
  api.http.registerRoute({
    method: 'POST',
    path: '/api/dashboard/favorites/group',
    handler: async (req, res) => {
      try {
        const body = await readJsonBody(req);
        const group = (body && body.group) || '';
        const displayName = (body && body.displayName) != null ? String(body.displayName) : undefined;
        const visibility = (body && body.visibility) || undefined;
        if (!group) return sendJson(res, { ok: false, error: 'bad-params: 需要 group（收藏夹 tag 或 displayName）' });
        if (displayName === undefined && visibility === undefined) {
          return sendJson(res, { ok: false, error: 'bad-params: displayName 或 visibility 至少填一个' });
        }
        const args = { group, confirm: true };
        if (displayName !== undefined) args.displayName = displayName;
        if (visibility !== undefined) args.visibility = visibility;
        const r = await api.tools.call('update_favorite_group', args);
        if (r && r.updated) invalidateFavCaches(dashboardState, 'world');
        sendJson(res, r);
      } catch (e) {
        sendJson(res, { ok: false, error: String(e.message || e) });
      }
    },
  });

  // 写世界备注（本地存储，API 刷新不覆盖；空串清除）
  api.http.registerRoute({
    method: 'POST',
    path: '/api/dashboard/world-note',
    handler: async (req, res) => {
      let body = {};
      try { body = await readJsonBody(req); } catch { return sendJson(res, { ok: false, error: 'bad body' }); }
      try {
        if (!body.worldId || !String(body.worldId).startsWith('wrld_')) return sendJson(res, { ok: false, error: 'worldId required' });
        await api.tools.call('set_world_note', { worldId: body.worldId, note: String(body.note || '') });
        return sendJson(res, { ok: true });
      } catch (e) {
        return sendJson(res, { ok: false, error: String(e.message || e) });
      }
    },
  });
}
