import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLimit, readJsonBody, sendHtml, sendJson } from './server/http.js';
import { CACHE_TTLS, createDashboardState, setCached } from './server/state.js';
import { registerSearchRoutes } from './server/routes/search.js';
import { registerFavoriteRoutes } from './server/routes/favorites.js';
import { registerAvatarRoutes, loadMe, loadAvatarName } from './server/routes/avatars.js';
import { registerSocialRoutes } from './server/routes/social.js';
import { registerImageProxyRoutes } from './server/routes/image-proxy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// VRChat file URL → 256 缩略图：/file/{file_id}/[version]/[/file|/] → /image/{file_id}/1/256。
// 理由：当前 avatarImageUrl 是"穿戴的3D模型外观图"，userIcon 是用户设置的真正头像；
//       userIcon 的原始 /file/xxx/1/ URL 经代理会返回 SVG 占位，需转成 256 缩略图才显示真图。
//       已是 /image/ 缩略图则原样返回。
function avatarThumb(u) {
  if (!u) return u;
  const s = String(u);
  const m = s.match(/\/file\/(file_[a-f0-9-]+)\//);
  return m ? `https://api.vrchat.cloud/api/1/image/${m[1]}/1/256` : s;
}
const indexHtml = readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8')
  .replaceAll('__DASHBOARD_CSS__', readFileSync(path.join(__dirname, 'client', 'dashboard.css'), 'utf8'))
  .replaceAll('__VUE_VENDOR__', readFileSync(path.join(__dirname, 'client', 'vendor', 'vue.global.prod.js'), 'utf8'))
  .replaceAll('__DASHBOARD_UTIL_JS__', readFileSync(path.join(__dirname, 'client', 'js', 'util.js'), 'utf8'))
  .replaceAll('__DASHBOARD_CORE_JS__', readFileSync(path.join(__dirname, 'client', 'js', 'vue', 'core.js'), 'utf8'))
  .replaceAll('__DASHBOARD_VIEWS_JS__', readFileSync(path.join(__dirname, 'client', 'js', 'vue', 'views.js'), 'utf8'))
  .replaceAll('__DASHBOARD_DIALOGS_JS__', readFileSync(path.join(__dirname, 'client', 'js', 'vue', 'dialogs.js'), 'utf8'))
  .replaceAll('__DASHBOARD_RIGHTBAR_JS__', readFileSync(path.join(__dirname, 'client', 'js', 'vue', 'rightbar.js'), 'utf8'))
  .replaceAll('__DASHBOARD_APP_JS__', readFileSync(path.join(__dirname, 'client', 'js', 'vue', 'app.js'), 'utf8'));

// 新 UI（Vite + PrimeVue 单文件构建）：存在则优先服务；?legacy=1 回退旧版
const uiDistIndex = path.join(__dirname, 'ui', 'dist', 'index.html');
const uiHtml = existsSync(uiDistIndex) ? readFileSync(uiDistIndex, 'utf8') : null;

// 群组信息缓存：VRChat API 限流 + 路由器网络延迟高（单请求 ~8-20s）。
// info（名称/描述/公告）少变 → 30min；实例（当前开的房）动态 → 2min。
const groupInfoCache = new Map();
const groupInstCache = new Map();
const GROUP_INFO_TTL = 30 * 60_000;
const GROUP_INST_TTL = 2 * 60_000;

// 周报缓存：get_weekly_report 同屏匹配较重（~5s），按 days 缓存 5 分钟
const weeklyCache = new Map();
const WEEKLY_TTL = 5 * 60_000;

// 世界推荐缓存：recommend_worlds 含 PlanetVRC 拉取（首拉 ~11s），按 theme 缓存 15 分钟
const recCache = new Map();
const REC_TTL = 15 * 60_000;

// 我的群组缓存：get_user_groups 约 2 个限流请求，5 分钟
const groupsCache = new Map();
const GROUPS_TTL = 5 * 60_000;

// 社区活动缓存：fetch_community_events 含群组挖掘/外部拉取（首拉 ~48s），按 window 缓存 30 分钟
// （活动变化不频繁；TTL 过长会错过新增，30min 平衡慢拉频率与新鲜度）
const evtCache = new Map();
const EVT_TTL = 30 * 60_000;
const evtInflight = new Map();   // window -> in-flight Promise（去重）

export default function register(api) {
  const dashboardState = createDashboardState();
  const { homeFavorites: homeFavCache } = dashboardState;
  const HOME_FAV_TTL = CACHE_TTLS.homeFavorites;

  api.http.registerRoute({
    method: 'GET',
    path: '/dashboard',
    handler: async (req, res) => {
      const legacy = new URL(req.url, 'http://localhost').searchParams.get('legacy') === '1';
      // 新 UI（PrimeVue 单文件构建）；?legacy=1 回退旧版
      if (!legacy && uiHtml) return sendHtml(res, uiHtml);
      return sendHtml(res, indexHtml);
    },
  });

  // Vue 3 运行时（本地 vendor，避免 CDN 依赖）
  api.http.registerRoute({
    method: 'GET',
    path: '/dashboard/vendor/vue.global.prod.js',
    handler: (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'public, max-age=86400' });
      res.end(readFileSync(path.join(__dirname, 'client', 'vendor', 'vue.global.prod.js')));
    },
  });

  api.http.registerRoute({
    method: 'GET',
    path: '/api/dashboard/player-list',
    handler: async (_req, res) => {
      try {
        const me = await api.vrchat.fetch('/auth/user').catch(() => null);
        const myLoc = (me && me.location) || '';
        if (!myLoc || myLoc === 'offline' || !myLoc.includes(':')) {
          return sendJson(res, { inInstance: false, location: myLoc || 'offline' });
        }
        const [worldId, instFull] = myLoc.split(':');
        const instRes = await api.vrchat.fetch(`/instances/${encodeURIComponent(worldId)}:${encodeURIComponent(instFull)}`).catch(() => null);
        const fr = await api.consume('dashboard.friends').catch(() => null);
        const friends = Array.isArray(fr) ? fr : ((fr && fr.friends) || []);
        const players = friends
          .filter(f => f.isOnline && (f.location || '') === myLoc)
          .map(f => ({ userId: f.userId, displayName: f.displayName, platform: f.platform, status: f.status, statusDescription: f.statusDescription, avatarUrl: f.avatarUrl, userIcon: f.userIcon, trustLevel: f.trustLevel }));
        const inst = instRes || {};
        const world = {
          worldId,
          name: inst.name || (inst.world && inst.world.name) || '',
          imageUrl: (inst.world && (inst.world.imageUrl || inst.world.thumbnailImageUrl)) || '',
          authorName: (inst.world && inst.world.authorName) || '',
        };
        sendJson(res, {
          inInstance: true,
          location: myLoc,
          world,
          instance: {
            id: inst.id || myLoc,
            type: inst.type || '',
            region: inst.region || '',
            nUsers: (inst.n_users ?? inst.userCount) || 0,
            capacity: inst.capacity || inst.recommendedCapacity || 0,
            platforms: inst.platforms || null,
          },
          players,
          friendsInInstance: players.length,
        });
      } catch (e) {
        sendJson(res, { inInstance: false, error: String(e.message || e) });
      }
    },
  });

  api.http.registerRoute({
    method: 'GET',
    path: '/api/dashboard/game-sessions',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost');
        const days = url.searchParams.get('days') || '7';
        const d = await api.consume('dashboard.gameSessions', { days });
        sendJson(res, d);
      } catch (e) {
        sendJson(res, { error: String(e.message || e) });
      }
    },
  });

  api.http.registerRoute({
    method: 'POST',
    path: '/api/dashboard/status',
    handler: async (req, res) => {
      try {
        const body = await readJsonBody(req);
        const valid = ['active', 'join me', 'ask me', 'busy'];
        const status = valid.includes(body && body.status) ? body.status : 'active';
        const desc = String(body && body.statusDescription || '').slice(0, 64);
        // VRChat 已移除 PUT /auth/user/status（404）；现改状态走 PUT /users/{id}（VRCX 同款端点）
        const me = await api.vrchat.fetch('/auth/user').catch(() => null);
        const uid = me && me.id;
        if (!uid) throw new Error('无法获取当前用户 ID');
        await api.vrchat.fetch(`/users/${encodeURIComponent(uid)}`, {
          method: 'PUT',
          // 传对象：api.vrchat.fetch 内部会 JSON.stringify（传字符串会双重序列化 → VRChat 报 JSON failed to parse）
          body: { status, statusDescription: desc || '' },
        });
        sendJson(res, { ok: true, status, statusDescription: desc });
      } catch (e) {
        const detail = e && e.response && e.response.error
          ? JSON.stringify(e.response.error).slice(0, 300)
          : '';
        sendJson(res, { error: String(e.message || e) + (detail ? ' | ' + detail : '') });
      }
    },
  });

  api.http.registerRoute({
    method: 'GET',
    path: '/api/dashboard/vrc-status',
    handler: async (_req, res) => {
      try {
        const r = await fetch('https://status.vrchat.com/api/v2/status.json', { signal: AbortSignal.timeout(15000) });
        if (!r.ok) return sendJson(res, { error: 'vrc-status-unavailable' });
        const d = await r.json();
        sendJson(res, { page: d.page || null, status: d.status || null });
      } catch (e) {
        sendJson(res, { error: String(e.message || e) });
      }
    },
  });

  api.http.registerRoute({
    method: 'GET',
    path: '/api/dashboard/group',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost');
        const groupId = url.searchParams.get('groupId') || '';
        if (!groupId || !groupId.startsWith('grp_')) return sendJson(res, { error: 'missing-params' });

        // 缓存：info 30min / 实例 2min（避免每次打开群组都等 2 次 VRChat API）
        const cInfo = groupInfoCache.get(groupId);
        const cInst = groupInstCache.get(groupId);
        const needInfo = !cInfo || Date.now() - cInfo.at > GROUP_INFO_TTL;
        const needInst = !cInst || Date.now() - cInst.at > GROUP_INST_TTL;
        let g = cInfo ? cInfo.data : {};
        let instances = cInst ? cInst.data : [];

        if (needInfo || needInst) {
          const [info, inst] = await Promise.allSettled([
            needInfo ? api.tools.call('get_group_info', { groupId, includeAnnouncement: true }) : Promise.resolve({ status: 'fulfilled', value: g }),
            needInst ? api.tools.call('get_group_instances', { groupId }) : Promise.resolve({ status: 'fulfilled', value: { instances } }),
          ]);
          if (info.status === 'fulfilled' && info.value) {
            g = info.value;
            groupInfoCache.set(groupId, { data: g, at: Date.now() });
          }
          if (inst.status === 'fulfilled') {
            const iv = (inst.value && inst.value.instances) || (Array.isArray(inst.value) ? inst.value : []);
            instances = Array.isArray(iv) ? iv : [];
            groupInstCache.set(groupId, { data: instances, at: Date.now() });
          }
        }
        sendJson(res, { ...g, instances });
      } catch (e) {
        sendJson(res, { error: String(e.message || e) });
      }
    },
  });

  api.http.registerRoute({
    method: 'GET',
    path: '/api/dashboard/group-announcements',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost');
        const groupId = url.searchParams.get('groupId') || '';
        if (!groupId || !groupId.startsWith('grp_')) return sendJson(res, { error: 'missing-params' });
        // 本地历史公告（WS 推送过的 group.announcement，VRChat API 只提供当前单条）
        sendJson(res, { announcements: await api.consume('dashboard.groupAnnouncements', { groupId }) });
      } catch (e) {
        sendJson(res, { error: String(e.message || e) });
      }
    },
  });

  api.http.registerRoute({
    method: 'GET',
    path: '/api/dashboard/activity-heatmap',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost');
        const days = url.searchParams.get('days') || '7';
        sendJson(res, await api.consume('dashboard.activityHeatmap', { days }));
      } catch (e) {
        sendJson(res, { error: String(e.message || e) });
      }
    },
  });

  api.http.registerRoute({
    method: 'GET',
    path: '/api/dashboard/home',
    handler: async (_req, res) => {
      const [snap, stats, events] = await Promise.allSettled([
        api.consume('dashboard.snapshot'),
        api.consume('dashboard.stats', { days: 7 }),
        api.consume('dashboard.events', { limit: 8 }),
      ]);
      let favoriteFriends = null;
      const now = Date.now();
      if (now - homeFavCache.at < HOME_FAV_TTL && homeFavCache.data) {
        favoriteFriends = homeFavCache.data;
      } else if (homeFavCache.data) {
        const stale = homeFavCache.data;
        (async () => {
          try {
            const ov2 = await api.tools.call('get_favorite_friends_locations', {});
            const f2 = (ov2 && ov2.mode === 'overview' && ov2.groups && ov2.groups.length)
              ? await api.tools.call('get_favorite_friends_locations', { groupName: ov2.groups[0].groupName }).catch(() => ov2)
              : ov2;
            setCached(dashboardState, 'homeFavorites', f2, Date.now());
          } catch {}
        })();
        favoriteFriends = stale;
      } else {
        try {
          const ov = await api.tools.call('get_favorite_friends_locations', {});
          favoriteFriends = (ov && ov.mode === 'overview' && ov.groups && ov.groups.length)
            ? await api.tools.call('get_favorite_friends_locations', { groupName: ov.groups[0].groupName }).catch(() => ov)
            : ov;
          setCached(dashboardState, 'homeFavorites', favoriteFriends, now);
        } catch {
          favoriteFriends = homeFavCache.data || null;
        }
      }
      const ev = events.status === 'fulfilled' ? events.value : null;
      sendJson(res, {
        overview: snap.status === 'fulfilled' ? snap.value : null,
        stats: stats.status === 'fulfilled' ? stats.value : null,
        favoriteFriends,
        recent: Array.isArray(ev) ? ev : (ev && ev.events) || [],
      });
    },
  });

  api.http.registerRoute({
    method: 'GET',
    path: '/api/dashboard/overview',
    handler: async (_req, res) => sendJson(res, await api.consume('dashboard.snapshot')),
  });

  api.http.registerRoute({
    method: 'GET',
    path: '/api/dashboard/friends',
    handler: async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const limit = parseLimit(url.searchParams.get('limit') || 100, 100, 200);
      sendJson(res, { friends: await api.consume('dashboard.friends', { limit }) });
    },
  });

  // 非好友追踪列表（VRCX-Luo 对齐：历史非好友，定时拉取资料/头像）
  api.http.registerRoute({
    method: 'GET',
    path: '/api/dashboard/tracked',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost');
        const limit = parseLimit(url.searchParams.get('limit') || 200, 200, 500);
        sendJson(res, await api.consume('dashboard.trackedNonFriends', { limit }));
      } catch (e) {
        sendJson(res, { tracked: [], error: String(e.message || e) });
      }
    },
  });

  // 非好友资料变化历史（bio/status 变更时间线，本地 events 表，秒回）
  api.http.registerRoute({
    method: 'GET',
    path: '/api/dashboard/tracked-changes',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost');
        const userId = url.searchParams.get('userId') || '';
        const limit = parseLimit(url.searchParams.get('limit') || 20, 20, 100);
        sendJson(res, await api.consume('dashboard.trackedChanges', { userId, limit }));
      } catch (e) {
        sendJson(res, { changes: [], error: String(e.message || e) });
      }
    },
  });

  // 手动触发非好友资料刷新（立即返回，后台执行；列表稍后自动更新）
  api.http.registerRoute({
    method: 'POST',
    path: '/api/dashboard/tracked/refresh',
    handler: async (_req, res) => {
      try {
        sendJson(res, await api.consume('dashboard.refreshTracked'));
      } catch (e) {
        sendJson(res, { ok: false, error: String(e.message || e) });
      }
    },
  });

  // 非好友追踪：添加（幂等，刷新循环自动接管新用户）
  api.http.registerRoute({
    method: 'POST',
    path: '/api/dashboard/tracked',
    handler: async (req, res) => {
      try {
        const body = await readJsonBody(req);
        const userId = String((body && body.userId) || '').trim();
        const displayName = String((body && body.displayName) || '').trim();
        if (!userId.startsWith('usr_')) return sendJson(res, { ok: false, error: 'bad-params: 需要 usr_ 开头的 userId' });
        const r = await api.consume('dashboard.trackedAdd', { userId, displayName });
        if (r.ok) {
          // 立即触发一次刷新（同步调用，内部 fire-and-forget 限流队列执行），让新用户尽快有资料快照
          api.consume('dashboard.refreshTracked');
        }
        sendJson(res, r);
      } catch (e) {
        sendJson(res, { ok: false, error: String(e.message || e) });
      }
    },
  });

  // 非好友追踪：移除（安全模式下拦截——与 watchlist remove 一致）
  api.http.registerRoute({
    method: 'POST',
    path: '/api/dashboard/tracked/remove',
    handler: async (req, res) => {
      try {
        const body = await readJsonBody(req);
        const userId = String((body && body.userId) || '').trim();
        if (!userId.startsWith('usr_')) return sendJson(res, { ok: false, error: 'bad-params: 需要 usr_ 开头的 userId' });
        try {
          const snap = await api.consume('dashboard.snapshot');
          if (snap && snap.safeMode) {
            return sendJson(res, { ok: false, error: '🔒 安全模式已启用：移除追踪属破坏性操作，已被禁用。' });
          }
        } catch { /* 快照不可用时放行 */ }
        const r = await api.consume('dashboard.trackedRemove', { userId });
        sendJson(res, r);
      } catch (e) {
        sendJson(res, { ok: false, error: String(e.message || e) });
      }
    },
  });

  // 全部群组公告时间线（跨群组汇总本地公告历史）
  api.http.registerRoute({
    method: 'GET',
    path: '/api/dashboard/group-announcements-all',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost');
        const limit = parseLimit(url.searchParams.get('limit') || 100, 100, 200);
        sendJson(res, await api.consume('dashboard.groupAnnouncementsAll', { limit }));
      } catch (e) {
        sendJson(res, { announcements: [], error: String(e.message || e) });
      }
    },
  });

  // 周报（复用 MCP 工具 get_weekly_report，纯本地计算；同屏匹配较重 ~5s，按 days 缓存 5 分钟）
  api.http.registerRoute({
    method: 'GET',
    path: '/api/dashboard/weekly-report',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost');
        const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 7, 1), 90);
        const ck = `weekly:${days}`;
        const hit = weeklyCache.get(ck);
        if (hit && Date.now() - hit.at < WEEKLY_TTL) return sendJson(res, hit.data);
        const r = await api.tools.call('get_weekly_report', { days });
        weeklyCache.set(ck, { at: Date.now(), data: r });
        sendJson(res, r);
      } catch (e) {
        sendJson(res, { error: String(e.message || e) });
      }
    },
  });

  // X 博主世界推荐（本地 x_world_recommendations 表 + 博主清单，秒回）
  api.http.registerRoute({
    method: 'GET',
    path: '/api/dashboard/x-worlds',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost');
        const limit = parseLimit(url.searchParams.get('limit') || 50, 50, 200);
        const [worlds, creators] = await Promise.allSettled([
          api.consume('x.worlds', { limit }),
          api.consume('x.creators'),
        ]);
        sendJson(res, {
          worlds: worlds.status === 'fulfilled' ? (worlds.value.worlds || []) : [],
          total: worlds.status === 'fulfilled' ? (worlds.value.total || 0) : 0,
          creators: creators.status === 'fulfilled' ? (creators.value.creators || []) : [],
        });
      } catch (e) {
        sendJson(res, { worlds: [], creators: [], error: String(e.message || e) });
      }
    },
  });

  // X 博主管理（走 MCP 工具以尊重安全模式：x_remove_creator 属破坏性，SAFE_MODE 下被拦截）
  api.http.registerRoute({
    method: 'POST',
    path: '/api/dashboard/x-creators',
    handler: async (req, res) => {
      try {
        const body = await readJsonBody(req);
        const screenName = String((body && body.screen_name) || '').trim().replace(/^@/, '');
        if (!screenName) return sendJson(res, { error: 'bad-params: 需要 screen_name' });
        const r = await api.tools.call('x_add_creator', { screen_name: screenName, name: (body && body.name) || '' });
        sendJson(res, r);
      } catch (e) {
        sendJson(res, { error: String(e.message || e) });
      }
    },
  });
  api.http.registerRoute({
    method: 'POST',
    path: '/api/dashboard/x-creators/scan',
    handler: async (_req, res) => {
      try {
        // 抓取较慢（Nitter/浏览器通道），fire-and-forget 立即返回，前端稍后刷新
        api.tools.call('x_scan_creators', {}).catch(() => {});
        sendJson(res, { ok: true, started: true });
      } catch (e) {
        sendJson(res, { error: String(e.message || e) });
      }
    },
  });
  api.http.registerRoute({
    method: 'POST',
    path: '/api/dashboard/x-creators/remove',
    handler: async (req, res) => {
      try {
        const body = await readJsonBody(req);
        const screenName = String((body && body.screen_name) || '').trim().replace(/^@/, '');
        if (!screenName) return sendJson(res, { error: 'bad-params: 需要 screen_name' });
        const r = await api.tools.call('x_remove_creator', { screen_name: screenName });
        sendJson(res, r);
      } catch (e) {
        sendJson(res, { error: String(e.message || e) });
      }
    },
  });

  // 上传画廊图片（浏览器 base64 → 容器临时文件 → upload_gallery_image → 清理；非破坏性）
  api.http.registerRoute({
    method: 'POST',
    path: '/api/dashboard/gallery/upload',
    handler: async (req, res) => {
      const fs = await import('node:fs');
      const os = await import('node:os');
      const path = await import('node:path');
      let tmpPath = '';
      try {
        const body = await readJsonBody(req);
        const data = String((body && body.data) || '');
        if (!data || data.length < 100) return sendJson(res, { ok: false, error: 'bad-params: 缺少图片数据' });
        const base64 = data.includes(',') ? data.split(',')[1] : data;
        const buf = Buffer.from(base64, 'base64');
        if (buf.length < 100 || buf.length > 15 * 1024 * 1024) return sendJson(res, { ok: false, error: 'bad-params: 图片大小需在 100B-15MB' });
        tmpPath = path.join(os.tmpdir(), 'dash_gal_' + Date.now() + '.png');
        fs.writeFileSync(tmpPath, buf);
        const r = await api.tools.call('upload_gallery_image', { imagePath: tmpPath });
        sendJson(res, r);
      } catch (e) {
        sendJson(res, { ok: false, error: String(e.message || e) });
      } finally {
        if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch { /* 忽略 */ } }
      }
    },
  });

  // 删除画廊图片（remove_gallery_image 破坏性；安全模式下拦截）
  api.http.registerRoute({
    method: 'POST',
    path: '/api/dashboard/gallery/remove',
    handler: async (req, res) => {
      try {
        const body = await readJsonBody(req);
        const fileId = String((body && body.fileId) || '').trim();
        if (!fileId.startsWith('file_')) return sendJson(res, { ok: false, error: 'bad-params: 需要 file_ 开头的 fileId' });
        try {
          const snap = await api.consume('dashboard.snapshot');
          if (snap && snap.safeMode) {
            return sendJson(res, { ok: false, error: '🔒 安全模式已启用：删除画廊图片属破坏性操作，已被禁用。' });
          }
        } catch { /* 快照不可用时放行 */ }
        const r = await api.tools.call('remove_gallery_image', { fileId, confirm: true });
        sendJson(res, r);
      } catch (e) {
        sendJson(res, { ok: false, error: String(e.message || e) });
      }
    },
  });

  // 画廊（VRChat Plus 资料展示图，get_gallery_images 工具；按需实时拉取）
  api.http.registerRoute({
    method: 'GET',
    path: '/api/dashboard/gallery',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost');
        const limit = parseLimit(url.searchParams.get('limit') || 100, 100, 100);
        const r = await api.tools.call('get_gallery_images', { limit });
        sendJson(res, r);
      } catch (e) {
        sendJson(res, { images: [], error: String(e.message || e) });
      }
    },
  });

  // BOOTH 素材搜索（search_booth_items；detail:false 快速列表，点击看详情）
  api.http.registerRoute({
    method: 'GET',
    path: '/api/dashboard/booth-search',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost');
        const q = (url.searchParams.get('q') || '').trim();
        const limit = parseLimit(url.searchParams.get('limit') || 10, 10, 10);
        if (!q) return sendJson(res, { results: [], total: 0 });
        const r = await api.tools.call('search_booth_items', { query: q, limit, detail: false });
        sendJson(res, r);
      } catch (e) {
        sendJson(res, { results: [], error: String(e.message || e) });
      }
    },
  });
  // BOOTH 最近搜索（get_booth_searches 本地历史）
  api.http.registerRoute({
    method: 'GET',
    path: '/api/dashboard/booth-searches',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost');
        const limit = parseLimit(url.searchParams.get('limit') || 10, 10, 50);
        const r = await api.tools.call('get_booth_searches', { limit });
        sendJson(res, r);
      } catch (e) {
        sendJson(res, { searches: [], error: String(e.message || e) });
      }
    },
  });

  // BOOTH 素材详情（get_booth_item：wishlistCount/shop/tags）
  api.http.registerRoute({
    method: 'GET',
    path: '/api/dashboard/booth-item',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost');
        const itemId = url.searchParams.get('itemId') || '';
        if (!itemId) return sendJson(res, { error: 'missing itemId' });
        const r = await api.tools.call('get_booth_item', { itemId });
        sendJson(res, r);
      } catch (e) {
        sendJson(res, { error: String(e.message || e) });
      }
    },
  });

  // 创建房间实例（create_instance：hidden/friends/group/public + region；非破坏性——只是建个房间）
  api.http.registerRoute({
    method: 'POST',
    path: '/api/dashboard/instance/create',
    handler: async (req, res) => {
      try {
        const body = await readJsonBody(req);
        const worldId = String((body && body.worldId) || '').trim();
        const type = String((body && body.type) || 'hidden').trim();
        const region = String((body && body.region) || 'jp').trim();
        if (!worldId.startsWith('wrld_')) return sendJson(res, { ok: false, error: 'bad-params: 需要 wrld_ 开头的 worldId' });
        if (!['hidden', 'friends', 'group', 'public'].includes(type)) return sendJson(res, { ok: false, error: 'bad-params: type 需为 hidden/friends/group/public' });
        const r = await api.tools.call('create_instance', { worldId, type, region });
        sendJson(res, r);
      } catch (e) {
        sendJson(res, { ok: false, error: String(e.message || e) });
      }
    },
  });

  // 设为当前模型（selectAvatar：PUT /avatars/{id}/select；非破坏性——可随时换回）
  api.http.registerRoute({
    method: 'POST',
    path: '/api/dashboard/avatar/select',
    handler: async (req, res) => {
      try {
        const body = await readJsonBody(req);
        const avatarId = String((body && body.avatarId) || '').trim();
        if (!avatarId.startsWith('avtr_')) return sendJson(res, { ok: false, error: 'bad-params: 需要 avtr_ 开头的 avatarId' });
        const r = await api.vrchat.fetch(`/avatars/${encodeURIComponent(avatarId)}/select`, { method: 'PUT' });
        sendJson(res, { ok: !!r, avatarId });
      } catch (e) {
        sendJson(res, { ok: false, error: String(e.message || e) });
      }
    },
  });

  // 上传相册照片（浏览器 base64 → 容器临时文件 → upload_print → 清理；非破坏性）
  api.http.registerRoute({
    method: 'POST',
    path: '/api/dashboard/prints/upload',
    handler: async (req, res) => {
      const fs = await import('node:fs');
      const os = await import('node:os');
      const path = await import('node:path');
      let tmpPath = '';
      try {
        const body = await readJsonBody(req);
        const data = String((body && body.data) || '');
        const note = String((body && body.note) || '').slice(0, 200);
        if (!data || data.length < 100) return sendJson(res, { ok: false, error: 'bad-params: 缺少图片数据' });
        const base64 = data.includes(',') ? data.split(',')[1] : data;
        const buf = Buffer.from(base64, 'base64');
        if (buf.length < 100 || buf.length > 15 * 1024 * 1024) return sendJson(res, { ok: false, error: 'bad-params: 图片大小需在 100B-15MB' });
        tmpPath = path.join(os.tmpdir(), 'dash_upload_' + Date.now() + '.png');
        fs.writeFileSync(tmpPath, buf);
        const r = await api.tools.call('upload_print', { imagePath: tmpPath, note });
        sendJson(res, r);
      } catch (e) {
        sendJson(res, { ok: false, error: String(e.message || e) });
      } finally {
        if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch { /* 忽略 */ } }
      }
    },
  });

  // 删除相册照片（remove_print 破坏性；安全模式下拦截）
  api.http.registerRoute({
    method: 'POST',
    path: '/api/dashboard/prints/remove',
    handler: async (req, res) => {
      try {
        const body = await readJsonBody(req);
        const printId = String((body && body.printId) || '').trim();
        if (!printId.startsWith('prnt_')) return sendJson(res, { ok: false, error: 'bad-params: 需要 prnt_ 开头的 printId' });
        try {
          const snap = await api.consume('dashboard.snapshot');
          if (snap && snap.safeMode) {
            return sendJson(res, { ok: false, error: '🔒 安全模式已启用：删除照片属破坏性操作，已被禁用。' });
          }
        } catch { /* 快照不可用时放行 */ }
        const r = await api.tools.call('remove_print', { printId, confirm: true });
        sendJson(res, r);
      } catch (e) {
        sendJson(res, { ok: false, error: String(e.message || e) });
      }
    },
  });

  // 相册（VRChat Plus 照片，get_prints 工具；按需实时拉取）
  api.http.registerRoute({
    method: 'GET',
    path: '/api/dashboard/prints',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost');
        const limit = parseLimit(url.searchParams.get('limit') || 100, 100, 100);
        const r = await api.tools.call('get_prints', { limit });
        sendJson(res, r);
      } catch (e) {
        sendJson(res, { prints: [], error: String(e.message || e) });
      }
    },
  });

  // 某作者的其他世界（get_worlds_by_author：authorId 或 authorName）
  api.http.registerRoute({
    method: 'GET',
    path: '/api/dashboard/worlds-by-author',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost');
        const authorId = url.searchParams.get('authorId') || '';
        const authorName = url.searchParams.get('authorName') || '';
        const limit = parseLimit(url.searchParams.get('limit') || 10, 10, 20);
        const args = { limit };
        if (authorId) args.authorId = authorId;
        else if (authorName) args.authorName = authorName;
        else return sendJson(res, { worlds: [], error: 'bad-params: 需要 authorId 或 authorName' });
        const r = await api.tools.call('get_worlds_by_author', args);
        sendJson(res, r);
      } catch (e) {
        sendJson(res, { worlds: [], error: String(e.message || e) });
      }
    },
  });

  // 世界推荐（多源融合 recommend_worlds；Planet 拉取较重，按 theme 缓存 5 分钟）
  api.http.registerRoute({
    method: 'GET',
    path: '/api/dashboard/recommend-worlds',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost');
        const theme = ['default', 'sleep', 'chat', 'onsen', 'game'].includes(url.searchParams.get('theme')) ? url.searchParams.get('theme') : 'default';
        const ck = `rec:${theme}`;
        const hit = recCache.get(ck);
        if (hit && Date.now() - hit.at < REC_TTL) return sendJson(res, hit.data);
        const r = await api.tools.call('recommend_worlds', { theme, limit: 10, detail: true });
        recCache.set(ck, { at: Date.now(), data: r });
        sendJson(res, r);
      } catch (e) {
        sendJson(res, { error: String(e.message || e), recommended: [] });
      }
    },
  });

  // 世界推荐反馈闭环：评分（rate_world 1/-1/0）与标记已逛（mark_world_visited）——喂给推荐引擎
  api.http.registerRoute({
    method: 'POST',
    path: '/api/dashboard/world/rate',
    handler: async (req, res) => {
      try {
        const body = await readJsonBody(req);
        const worldId = (body && body.worldId) || '';
        const rating = Number(body && body.rating);
        if (!worldId || ![1, -1, 0].includes(rating)) return sendJson(res, { error: 'bad-params: 需要 worldId 与 rating(1|-1|0)' });
        const r = await api.tools.call('rate_world', { worldId, rating });
        sendJson(res, r);
      } catch (e) {
        sendJson(res, { error: String(e.message || e) });
      }
    },
  });
  api.http.registerRoute({
    method: 'POST',
    path: '/api/dashboard/world/visited',
    handler: async (req, res) => {
      try {
        const body = await readJsonBody(req);
        const worldId = (body && body.worldId) || '';
        if (!worldId || !worldId.startsWith('wrld_')) return sendJson(res, { error: 'bad-params: 需要 worldId' });
        const r = await api.tools.call('mark_world_visited', { worldId });
        sendJson(res, r);
      } catch (e) {
        sendJson(res, { error: String(e.message || e) });
      }
    },
  });

  // 我的群组（get_user_groups，~2 个限流请求，缓存 5 分钟；详情由 GroupDialog 走 /group 缓存）
  api.http.registerRoute({
    method: 'GET',
    path: '/api/dashboard/my-groups',
    handler: async (_req, res) => {
      try {
        const hit = groupsCache.get('mine');
        if (hit && Date.now() - hit.at < GROUPS_TTL) return sendJson(res, hit.data);
        const r = await api.tools.call('get_user_groups', {});
        groupsCache.set('mine', { at: Date.now(), data: r });
        sendJson(res, r);
      } catch (e) {
        sendJson(res, { groups: [], error: String(e.message || e) });
      }
    },
  });

  // 社区活动（读库：api.consume('events.listStore')，数据由 events 插件每日离线刷新落库；
  // 页面访问零限流 API 秒回，不再触发群组挖掘。evtCache 内存缓存 + evtInflight 去重保留）
  api.http.registerRoute({
    method: 'GET',
    path: '/api/dashboard/community-events',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost');
        const window = ['tonight', 'week', 'month'].includes(url.searchParams.get('window')) ? url.searchParams.get('window') : 'week';
        const ck = `evt:${window}`;
        const hit = evtCache.get(ck);
        if (hit && Date.now() - hit.at < EVT_TTL) return sendJson(res, hit.data);
        // in-flight 去重：重复请求共享同一 Promise（读库很快，主要防并发重复查询）
        if (evtInflight.has(ck)) return sendJson(res, await evtInflight.get(ck));
        const task = (async () => {
          // events.listStore 返回 { retrievedAt, source, window, counts, events }（字段与 fetch_community_events
          // 工具返回结构对齐，前端 EventsView 用到蛇形字段 + start_bj/join_info_zh 派生物 + counts.output）
          const r = await api.consume('events.listStore', { window });
          return { ...r, source: 'store', window: r.window || window };
        })();
        evtInflight.set(ck, task);
        try {
          const r = await task;
          evtCache.set(ck, { at: Date.now(), data: r });
          sendJson(res, r);
        } finally {
          evtInflight.delete(ck);
        }
      } catch (e) {
        sendJson(res, { events: [], error: String(e.message || e) });
      }
    },
  });

  // 关注名单（watchlist：get/add/remove 复用核心工具；动态页「只看关注」筛选 + 资料弹窗关注按钮）
  api.http.registerRoute({
    method: 'GET',
    path: '/api/dashboard/watchlist',
    handler: async (_req, res) => {
      try {
        const r = await api.tools.call('get_watchlist', {});
        sendJson(res, r);
      } catch (e) {
        sendJson(res, { watchlist: [], error: String(e.message || e) });
      }
    },
  });
  api.http.registerRoute({
    method: 'POST',
    path: '/api/dashboard/watchlist',
    handler: async (req, res) => {
      try {
        const body = await readJsonBody(req);
        const userId = (body && body.userId) || '';
        if (!userId || !userId.startsWith('usr_')) return sendJson(res, { error: 'bad-params: 需要 userId' });
        const r = await api.tools.call('add_to_watchlist', { userId, displayName: (body && body.displayName) || '', priority: Number(body && body.priority) || 1 });
        sendJson(res, r);
      } catch (e) {
        sendJson(res, { error: String(e.message || e) });
      }
    },
  });
  api.http.registerRoute({
    method: 'POST',
    path: '/api/dashboard/watchlist/remove',
    handler: async (req, res) => {
      try {
        const body = await readJsonBody(req);
        const userId = (body && body.userId) || '';
        if (!userId || !userId.startsWith('usr_')) return sendJson(res, { error: 'bad-params: 需要 userId' });
        const r = await api.tools.call('remove_from_watchlist', { userId });
        sendJson(res, r);
      } catch (e) {
        sendJson(res, { error: String(e.message || e) });
      }
    },
  });

  // 当前用户（VRCX 侧栏 me-item / 同实例判定）：复用 avatars.js 的 5min /auth/user 缓存
  api.http.registerRoute({
    method: 'GET',
    path: '/api/dashboard/me',    handler: async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost');
        const me = await loadMe(api, url.searchParams.get('fresh') === '1').catch(() => null);
        // 用本地 events 表最新 user-update status 覆盖（即时反映别的客户端改状态，不依赖 loadMe 5min 缓存）
        // 即使 loadMe 失败（/auth/user 限流/异常），也用本地数据兜底返回，保证前端能拿到最新状态
        let status = (me && me.status) || '';
        let statusDescription = (me && me.statusDescription) || '';
        let uid = (me && me.id) || '';
        try {
          const latest = await api.consume('dashboard.latestSelfStatus').catch(() => null);
          if (latest && latest.status) {
            status = latest.status;
            statusDescription = latest.statusDescription || '';
            if (latest.userId) uid = latest.userId;
          }
        } catch { /* 本地状态覆盖失败不影响 */ }
        // /auth/user 只给 currentAvatar(ID) 不给名字：按 ID 查 /avatars/{id} 拿精确模型名（30min 缓存 + stale-while-revalidate）
        const avName = (me && me.currentAvatar && String(me.currentAvatar).startsWith('avtr_'))
          ? await loadAvatarName(api, me.currentAvatar).catch(() => '')
          : '';
        sendJson(res, {
          userId: uid,
          displayName: (me && me.displayName) || '',
          location: (me && me.location) || '',
          travelingToLocation: (me && me.travelingToLocation) || '',
          status,
          statusDescription,
          avatarUrl: avatarThumb(me && (me.userIcon || me.currentAvatarThumbnailImageUrl || me.currentAvatarImageUrl)),
          userIcon: (me && me.userIcon) || '',
          trustLevel: (me && me.trustLevel) || '',
          currentAvatar: (me && me.currentAvatar) || '',
          currentAvatarName: avName,
        });
      } catch (e) {
        sendJson(res, { error: String(e.message || e) });
      }
    },
  });

  // 动态数据时间范围（最早/最新事件日期）：日历筛选可选范围
  api.http.registerRoute({
    method: 'GET',
    path: '/api/dashboard/events-range',
    handler: async (_req, res) => {
      try {
        // eventsRange 服务是同步返回，consume 返回对象（无 .catch）——用 try/catch
        let r = null;
        try { r = api.consume('dashboard.eventsRange'); } catch { r = null; }
        sendJson(res, r || { min: null, max: null });
      } catch (e) {
        sendJson(res, { error: String(e.message || e) });
      }
    },
  });

  api.http.registerRoute({
    method: 'GET',
    path: '/api/dashboard/world-history',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost');
        const worldId = url.searchParams.get('worldId') || '';
        // worldHistory 同步返回——用 try/catch
        let r = null;
        try { r = api.consume('dashboard.worldHistory', { worldId }); } catch { r = null; }
        sendJson(res, r || { visits: 0, minutes: 0, last: '' });
      } catch (e) {
        sendJson(res, { visits: 0, minutes: 0, last: '', error: String(e.message || e) });
      }
    },
  });

  // /api/dashboard/notifications 由 server/routes/social.js 注册（富版：当前通知+历史+enrich）——勿重复注册
  api.http.registerRoute({
    method: 'POST',
    path: '/api/dashboard/notification-action',
    handler: async (req, res) => {
      try {
        const body = await readJsonBody(req);
        const id = body.notificationId || '';
        const actions = {
          see: ['see_notification', { notificationId: id }],
          hide: ['hide_notification', { notificationId: id }],
          accept: ['accept_friend_request', { notificationId: id }],
          decline: ['decline_friend_request', { notificationId: id }],
        };
        const act = actions[body.action];
        if (!id || !act) { sendJson(res, { error: 'bad-params' }); return; }
        await api.tools.call(act[0], act[1]);
        sendJson(res, { ok: true });
      } catch (e) {
        sendJson(res, { error: String(e.message || e) });
      }
    },
  });

  api.http.registerRoute({
    method: 'GET',
    path: '/api/dashboard/search',
    handler: async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const type = ['users', 'worlds', 'groups', 'avatars'].includes(url.searchParams.get('type')) ? url.searchParams.get('type') : 'users';
      const q = (url.searchParams.get('q') || '').trim();
      const limit = parseLimit(url.searchParams.get('limit') || 20, 20, 50);
      if (!q) { sendJson(res, { results: [] }); return; }
      const toolMap = { users: 'search_users', worlds: 'search_worlds', groups: 'search_groups' };
      try {
        // 模型搜索无 MCP 工具：独立走 /avatars?search= API
        if (type === 'avatars') {
          const a = await api.vrchat.fetch(`/avatars?search=${encodeURIComponent(q)}&n=${limit}&marketplace=all`);
          const results = (Array.isArray(a) ? a : []).map((av) => ({
            kind: 'avatar', id: av.id || av.avatarId || '', name: av.name || '?',
            sub: [(av.authorName ? '作者 ' + av.authorName : ''), av.releaseStatus === 'public' ? '公开' : av.releaseStatus ? '私有' : ''].filter(Boolean).join(' · '),
            image: av.imageUrl || av.thumbnailImageUrl || '',
          }));
          return sendJson(res, { results });
        }
        // 工具参数名：search_users={query,limit}，search_worlds/groups={query,n}
        const r = await api.tools.call(toolMap[type], { query: q, limit, n: limit });
        // 各工具返回形状不同：users={results:[{userId,displayName,bio,isFriend}]}，
        // worlds={worlds:[{worldId,name,authorName,capacity,imageUrl}]}，groups={groups:[{groupId,name,memberCount}]}
        let results = [];
        if (type === 'worlds') {
          results = (r.worlds || []).map(w => ({
            kind: 'world', id: w.worldId, name: w.name || '?',
            sub: [w.authorName, w.capacity ? w.capacity + ' 人' : ''].filter(Boolean).join(' · '),
            image: w.imageUrl || '',
          }));
        } else if (type === 'groups') {
          results = (r.groups || []).map(g => ({
            kind: 'group', id: g.groupId || g.id, name: g.name || '?',
            sub: [g.memberCount ? g.memberCount + ' 成员' : '', g.description ? String(g.description).slice(0, 40) : ''].filter(Boolean).join(' · '),
            image: g.iconUrl || '',
          }));
        } else {
          results = (r.results || []).map(u => ({
            kind: 'user', id: u.userId, name: u.displayName || '?',
            sub: [u.isFriend ? '好友' : '', (u.bio || '').slice(0, 40)].filter(Boolean).join(' · '),
            image: u.userIcon || u.currentAvatarThumbnailImageUrl || u.profilePicOverride || '',
          }));
        }
        sendJson(res, { results });
      } catch (e) {
        sendJson(res, { results: [], error: String(e.message || e) });
      }
    },
  });

  api.http.registerRoute({
    method: 'GET',
    path: '/api/dashboard/ops-log',
    handler: async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const limit = parseLimit(url.searchParams.get('limit') || 200, 200, 1000);
      const kind = (url.searchParams.get('kind') || '').trim();
      try {
        sendJson(res, await api.tools.call('get_ops_log', { limit, kind }));
      } catch (e) {
        sendJson(res, { items: [], error: String(e.message || e) });
      }
    },
  });

  api.http.registerRoute({
    method: 'GET',
    path: '/api/dashboard/events',
    handler: async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const limit = parseLimit(url.searchParams.get('limit') || 50, 50, 200);
      const offset = Math.max(Number.parseInt(url.searchParams.get('offset') || '0', 10) || 0, 0);
      const dateFrom = url.searchParams.get('dateFrom') || '';
      const dateTo = url.searchParams.get('dateTo') || '';
      const result = await api.consume('dashboard.events', { limit, offset, dateFrom, dateTo });
      if (result && Array.isArray(result.events)) {
        sendJson(res, { events: result.events, total: result.total || 0 });
      } else if (Array.isArray(result)) {
        sendJson(res, { events: result, total: result.length });
      } else {
        sendJson(res, { events: [], total: 0 });
      }
    },
  });

  api.http.registerRoute({
    method: 'GET',
    path: '/api/dashboard/friend-events',
    handler: async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const userId = url.searchParams.get('userId') || '';
      const limit = parseLimit(url.searchParams.get('limit') || 12, 12, 50);
      sendJson(res, { events: await api.consume('dashboard.friendEvents', { userId, limit }) });
    },
  });

  api.http.registerRoute({
    method: 'GET',
    path: '/api/dashboard/world',
    handler: async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const worldId = url.searchParams.get('worldId') || '';
      sendJson(res, await api.consume('dashboard.world', { worldId }));
    },
  });

  api.http.registerRoute({
    method: 'GET',
    path: '/api/dashboard/instance',
    handler: async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const location = url.searchParams.get('location') || '';
      try {
        sendJson(res, await api.consume('dashboard.instance', { location }));
      } catch (e) {
        sendJson(res, { error: String(e.message || e) });
      }
    },
  });

  api.http.registerRoute({
    method: 'GET',
    path: '/api/dashboard/world-instances',
    handler: async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const worldId = url.searchParams.get('worldId') || '';
      try {
        sendJson(res, await api.consume('dashboard.worldInstances', { worldId }));
      } catch (e) {
        sendJson(res, { instances: [], publicOccupants: 0, privateOccupants: 0, occupants: 0, error: String(e.message || e) });
      }
    },
  });

  api.http.registerRoute({
    method: 'GET',
    path: '/api/dashboard/user-profile',
    handler: async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const userId = url.searchParams.get('userId') || '';
      // 聚合多个 VRChat API（限流排队），响应可能较慢：给前端足够超时
      try {
        const data = await api.consume('dashboard.userProfile', { userId });
        sendJson(res, data || { error: 'no data' });
      } catch (e) {
        sendJson(res, { error: String(e.message || e) });
      }
    },
  });

  api.http.registerRoute({
    method: 'GET',
    path: '/api/dashboard/stats',
    handler: async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const days = parseLimit(url.searchParams.get('days') || 7, 7, 90);
      sendJson(res, await api.consume('dashboard.stats', { days }));
    },
  });

  api.http.registerRoute({
    method: 'GET',
    path: '/api/dashboard/stream',
    handler: async (req, res) => {
      const bus = await api.consume('dashboard.bus');
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 5000\n\n');
      res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
      const unsubscribe = bus.subscribe((dto) => {
        try { res.write(`data: ${JSON.stringify({ type: 'event', event: dto })}\n\n`); } catch {}
      });
      const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
      if (heartbeat.unref) heartbeat.unref();
      req.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
        try { res.end(); } catch {}
      });
    },
  });

  registerSearchRoutes(api);
  registerFavoriteRoutes(api, dashboardState);
  registerAvatarRoutes(api, dashboardState);
  registerSocialRoutes(api, dashboardState);
  registerImageProxyRoutes(api);

  api.http.registerRoute({
    method: 'GET',
    path: '/api/dashboard/recent-worlds',
    handler: async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const limit = parseLimit(url.searchParams.get('limit') || 12, 12, 60);
      try {
        sendJson(res, { worlds: await api.consume('dashboard.recentWorlds', { limit }) });
      } catch (e) {
        sendJson(res, { worlds: [], error: String(e.message || e) });
      }
    },
  });

  api.log('Web Dashboard (VRCX Vue 3) 已注册：/dashboard');

  // 慢路由懒加载（issue #118）：不再做启动预热——无条件预热 fetch_community_events 会触发
  // events 插件的群组深度挖掘，持续占满共享 rateLimiter 队列，拖慢所有 API 工具。
  // 社区活动由路由读库（api.consume('events.listStore')，由 events 插件每日离线刷新落库）；
  // 世界推荐由前端按需触发，路由缓存 + in-flight 去重保留。

  return () => {};
}
