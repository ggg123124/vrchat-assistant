import { parseLimit, readJsonBody, sendJson } from '../http.js';
import { getCached, setCached } from '../state.js';

export function registerSocialRoutes(api, dashboardState) {
  // groups 缓存（VRChat API 限流，用户群组少变：10 分钟 + stale-while-revalidate，对齐 VRCX 本地库思路）
  const groupsCache = new Map();
  const GROUPS_TTL = 10 * 60_000;
  // 最近一起玩（右侧栏「最近一起玩」区）：get_recent_cooplay 是纯 DB 聚合（周报同屏引擎），
  // 但 7 天窗口逐日查询不轻，缓存 10 分钟避免 30s 自动刷新反复扫库
  api.http.registerRoute({
    method: 'GET',
    path: '/api/dashboard/co-play',
    handler: async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const days = Math.min(Math.max(Number.parseInt(url.searchParams.get('days') || '7', 10) || 7, 1), 90);
      const limit = parseLimit(url.searchParams.get('limit') || '30', 30, 100);
      const cached = getCached(dashboardState, 'coPlay');
      if (cached && cached.days === days) return sendJson(res, cached);
      try {
        const r = await api.tools.call('get_recent_cooplay', { days, limit });
        setCached(dashboardState, 'coPlay', r);
        sendJson(res, r);
      } catch (e) {
        sendJson(res, { days, total: 0, companions: [], error: String(e.message || e) });
      }
    },
  });

  api.http.registerRoute({
    method: 'GET',
    path: '/api/dashboard/pair-screen',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost');
        const userId = url.searchParams.get('userId') || '';
        const days = Math.min(Math.max(Number.parseInt(url.searchParams.get('days') || '30', 10) || 30, 1), 90);
        const snap = await api.consume('dashboard.snapshot');
        const meId = snap?.auth?.user?.id || '';
        if (!meId || !userId) return sendJson(res, { error: 'missing-params' });
        const r = await api.tools.call('get_friend_pair_screen', { userIdA: meId, userIdB: userId, days });
        sendJson(res, { matchCount: r.matchCount || 0, totalMinutes: r.totalMinutes || 0, worlds: r.worlds || [] });
      } catch (e) {
        sendJson(res, { error: String(e.message || e) });
      }
    },
  });

  api.http.registerRoute({
    method: 'POST',
    path: '/api/dashboard/invite-request',
    handler: async (req, res) => {
      try {
        const body = await readJsonBody(req);
        const userId = (body && body.userId) || '';
        if (!userId || !userId.startsWith('usr_')) return sendJson(res, { error: 'missing-params' });
        const r = await api.tools.call('request_invite', { userId });
        sendJson(res, { ok: true, ...(r || {}) });
      } catch (e) {
        sendJson(res, { error: String(e.message || e) });
      }
    },
  });

  api.http.registerRoute({
    method: 'GET',
    path: '/api/dashboard/profile-changes',
    handler: async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const userId = url.searchParams.get('userId') || '';
      const limit = parseLimit(url.searchParams.get('limit') || 20, 20, 50);
      sendJson(res, await api.tools.call('get_friend_profile_changes', { userId, limit }));
    },
  });

  api.http.registerRoute({
    method: 'GET',
    path: '/api/dashboard/groups',
    handler: async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const userId = url.searchParams.get('userId') || '';
      if (!userId) return sendJson(res, { groups: [] });
      const c = groupsCache.get(userId);
      if (c && Date.now() - c.at < GROUPS_TTL) return sendJson(res, c.data);
      if (c) {
        // 过期有旧数据：先返回秒开，后台刷新
        sendJson(res, c.data);
        api.tools.call('get_user_groups', { userId, withDetails: false }).then((d) => groupsCache.set(userId, { at: Date.now(), data: d })).catch(() => {});
        return;
      }
      try {
        const d = await api.tools.call('get_user_groups', { userId, withDetails: false });
        groupsCache.set(userId, { at: Date.now(), data: d });
        sendJson(res, d);
      } catch (e) {
        sendJson(res, { error: String(e.message || e) });
      }
    },
  });

  api.http.registerRoute({
    method: 'GET',
    path: '/api/dashboard/notifications',
    handler: async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const limit = parseLimit(url.searchParams.get('limit') || 30, 30, 100);
      const offset = Math.max(Number.parseInt(url.searchParams.get('offset') || '0', 10) || 0, 0);
      const types = url.searchParams.get('types') || undefined;
      const [current, history] = await Promise.allSettled([
        api.tools.call('get_notifications', { limit, offset, types }),
        api.consume('dashboard.notificationEvents', { limit: Math.min(limit, 50) }),
      ]);
      const currentData = current.status === 'fulfilled' && current.value
        ? current.value
        : { returned: 0, shown: 0, notifications: [] };
      // 通知增强（VRCX 对齐）：群组检测 + invite 世界封面/名字（details.worldId → world_cache）
      const enrich = async (n) => {
        const isGroup = String(n.senderUserId || '').startsWith('grp_') || String(n.type || '').startsWith('group.');
        let worldId = (n.details && (n.details.worldId || n.details.instanceId)) || '';
        let worldCover = '', worldName = '';
        if (worldId && worldId.startsWith('wrld_')) {
          const w = await api.consume('dashboard.world', { worldId }).catch(() => null);
          if (w && w.name) { worldName = w.name; worldCover = w.imageUrl || ''; }
        }
        return { ...n, isGroup, worldId, worldCover, worldName };
      };
      const notifications = await Promise.all((currentData.notifications || []).map(enrich));
      sendJson(res, {
        ...currentData,
        notifications,
        history: history.status === 'fulfilled' ? history.value : [],
      });
    },
  });

  api.http.registerRoute({
    method: 'POST',
    path: '/api/dashboard/notifications/see',
    handler: async (req, res) => {
      const body = await readJsonBody(req);
      sendJson(res, await api.tools.call('see_notification', { notificationId: body.notificationId }));
    },
  });

  api.http.registerRoute({
    method: 'POST',
    path: '/api/dashboard/notifications/see-all',
    handler: async (req, res) => {
      // VRChat API 无批量已读端点：逐个标记当前未读通知（受限流影响，cap 15 条避免拖慢其他请求）
      try {
        const r = await api.vrchat.fetch('/auth/user/notifications?n=50');
        const list = (Array.isArray(r) ? r : []).filter(x => !x.hidden && !x.seen).slice(0, 15);
        let seen = 0;
        for (const n of list) {
          try { await api.tools.call('see_notification', { notificationId: n.id }); seen++; } catch { /* 单条失败继续 */ }
        }
        sendJson(res, { ok: true, seen, total: list.length });
      } catch (e) {
        sendJson(res, { ok: false, error: String(e.message || e) });
      }
    },
  });

  api.http.registerRoute({
    method: 'GET',
    path: '/api/dashboard/notifications/count',
    handler: async (_req, res) => {
      // 当前未读通知数（导航徽标；API 调用，轻量）
      try {
        const r = await api.vrchat.fetch('/auth/user/notifications?n=50');
        const list = (Array.isArray(r) ? r : []).filter((x) => !x.hidden && !x.seen);
        sendJson(res, { count: list.length });
      } catch (e) {
        sendJson(res, { count: 0, error: String(e.message || e) });
      }
    },
  });

  api.http.registerRoute({
    method: 'POST',
    path: '/api/dashboard/notifications/respond',
    handler: async (req, res) => {
      const body = await readJsonBody(req);
      const { notificationId, action, confirmed } = body;
      if (!notificationId || !['accept', 'decline'].includes(action)) {
        return sendJson(res, { ok: false, error: '参数不完整' }, 400);
      }
      const tool = action === 'accept' ? 'accept_friend_request' : 'decline_friend_request';
      try {
        const result = await api.tools.call(tool, {
          notificationId,
          confirm: confirmed === true,
        });
        sendJson(res, { ok: true, ...result });
      } catch (e) {
        sendJson(res, { ok: false, error: String(e.message || e) });
      }
    },
  });

  api.http.registerRoute({
    method: 'POST',
    path: '/api/dashboard/notifications/invite-response',
    handler: async (req, res) => {
      try {
        const body = await readJsonBody(req);
        const { notificationId, accept } = body;
        if (!notificationId) return sendJson(res, { ok: false, error: '参数不完整' });
        const r = await api.vrchat.fetch(`/invite/${encodeURIComponent(notificationId)}/response`, {
          method: 'PUT',
          body: JSON.stringify({ responseSlot: accept ? 0 : 1 }),
          headers: { 'Content-Type': 'application/json' },
        });
        sendJson(res, { ok: true, accepted: !!accept });
      } catch (e) {
        sendJson(res, { ok: false, error: String(e.message || e) });
      }
    },
  });

  api.http.registerRoute({
    method: 'POST',
    path: '/api/dashboard/notifications/group-join',
    handler: async (req, res) => {
      try {
        const body = await readJsonBody(req);
        const groupId = (body && body.groupId) || '';
        if (!groupId || !groupId.startsWith('grp_')) return sendJson(res, { ok: false, error: '缺少群组 ID' });
        const r = await api.vrchat.fetch(`/groups/${encodeURIComponent(groupId)}/join`, { method: 'POST' });
        sendJson(res, { ok: true, joined: true });
      } catch (e) {
        sendJson(res, { ok: false, error: String(e.message || e) });
      }
    },
  });

  api.http.registerRoute({
    method: 'GET',
    path: '/api/dashboard/user',
    handler: async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const userId = url.searchParams.get('userId') || '';
      if (!userId) return sendJson(res, {});
      try {
        const user = await api.vrchat.fetch(`/users/${userId}`);
        sendJson(res, {
          userId: user.id || '',
          displayName: user.displayName || '',
          pastDisplayNames: Array.isArray(user.pastDisplayNames) ? user.pastDisplayNames : [],
          statusHistory: Array.isArray(user.statusHistory) ? user.statusHistory : [],
          statusDescription: user.statusDescription || '',
          bio: user.bio || '',
          pronouns: user.pronouns || '',
          dateJoined: user.date_joined || '',
          lastLogin: user.last_login || '',
          lastPlatform: user.last_platform || '',
          tags: Array.isArray(user.tags) ? user.tags : [],
          avatarImageUrl: user.currentAvatarImageUrl || user.userIcon || '',
        });
      } catch (e) {
        sendJson(res, { error: String(e.message || e) });
      }
    },
  });
}
