// 响应式数据层（移植旧 core.js 模式：快/慢路径拆分 + 30s 轮询 + SSE + hash 视图同步）
import { reactive } from 'vue';
import { get, post, openSse } from './api.js';

// 兼容 events 接口的几种历史形状，避免包一层对象后前端当数组用 → 动态整页空
function parseEvents(d) {
  if (!d) return { events: [], total: 0 };
  if (Array.isArray(d)) return { events: d, total: d.length };
  let list = d.events;
  let total = Number(d.total) || 0;
  if (list && !Array.isArray(list) && Array.isArray(list.events)) {
    total = Number(list.total) || total;
    list = list.events;
  }
  if (!Array.isArray(list)) list = [];
  return { events: list, total: total || list.length };
}

export const store = reactive({
  view: 'feed',
  isMobile: false,
  navOpen: false,
  friendsOpen: false,   // 移动端右侧好友抽屉（A1：桌面右侧栏在手机上改由抽屉打开）
  quickSearchOpen: false, // 快速搜索弹窗（Ctrl+K / Cmd+K）
  previewUrl: null,

  feedFilter: [],          // 多选类型数组（空 = 所有）
  feedDateFrom: '',     // 日期范围筛选（VRCX 式日历，ISO 字符串，空=不限）
  feedDateTo: '',       // 
  feedOnlyFav: false,      // 仅显示星标好友
  feedOnlyWatch: false,    // 仅显示关注名单（watchlist）
  feedOnlyMe: false,       // 仅显示自己的事件（user-location/user-update）
  feedOnlyUser: '',        // 仅显示某用户的事件（事件详情「只看此人」）
  feedSearch: '',
  feedEvents: [],
  feedHasMore: true,
  feedTotal: 0,  // 数据库事件总数（右上角"已加载/总数"）
  eventsRange: { min: null, max: null },  // 动态数据时间范围（日历筛选可选范围）
  feedLoading: false,
  feedLoadingMore: false,

  friends: [],
  friendsSearch: '',
  friendsTab: 'all',
  overview: null,
  me: null,
  nicknameMap: {},
  favFriendIds: new Set(),
  watchlistIds: new Set(),   // 关注名单（get_watchlist）
  trackedIds: new Set(),     // 非好友追踪名单（/api/dashboard/tracked）
  feedOnlyTracked: false,   // 动态页仅显示追踪非好友事件
  feedOnlyWorld: '',        // 动态页仅显示某世界的全部事件（世界 ID）
  notifCount: 0,            // 未读通知数（导航徽标）
  annHasNew: false,          // 有新公告（导航徽标，对比 localStorage 基线）
  coPlay: [],
  onlineFriends: [],
  offlineFriends: [],
  favFriends: [],

  userModal: null,
  worldModal: null,
  avatarModal: null,
  groupModal: null,
  instanceModal: null,

  vrcStatus: null,
  notifyEnabled: false,    // 浏览器通知提醒（好友请求/邀请等，localStorage 记忆）
  safeMode: false,       // 安全模式（VRC_MONITOR_SAFE_MODE）——页脚 🔒 徽标
  uptime: 0,             // 服务运行时长（秒，overview.uptime）——页脚显示
  sseStatus: 'connecting',
  authStatus: '—',
  wsStatus: '—',
  dbStatus: '—',

  statusPresets: [
    { v: 'active', l: '在线' },
    { v: 'join me', l: '加入我' },
    { v: 'ask me', l: '问我' },
    { v: 'busy', l: '忙碌' },
  ],
  statusDesc: '',
});

const viewMap = {
  feed: '动态', friends: '好友', tracked: '非好友追踪', favorites: '收藏', logs: '日志', players: '玩家',
  notifications: '通知', avatars: '模型', worlds: '足迹', xworlds: 'X推荐', recommend: '推荐', groups: '群组',
  events: '活动',
  charts: '图表', report: '周报',
  moderation: '屏蔽', tools: '工具', search: '搜索', open: '直接打开',
};

export function setView(view) {
  store.view = view;
  store.navOpen = false;
  const q = new URLSearchParams();
  q.set('view', view);
  if (store.feedFilter && store.feedFilter.length) q.set('filter', store.feedFilter.join(','));
  if (store.feedOnlyFav) q.set('fav', '1');
  history.replaceState(null, '', location.pathname + location.search + '#' + q.toString());
  document.title = 'VRChat Assistant · ' + (viewMap[view] || 'VRChat Assistant');
}

// 移动端开任何弹窗前收起好友抽屉（Drawer 是模态 portal，不收起会挡住后续弹窗）
function closeMobileDrawers() {
  if (store.isMobile && store.friendsOpen) store.friendsOpen = false;
}

export function openUser(u) {
  if (!u) return;
  closeMobileDrawers();
  if (typeof u === 'string') {
    const found = store.friends.find((f) => f.userId === u);
    // 自己不在 friends 表（不是自己的好友）→ 回退到 store.me，保留头像/状态等字段
    const self = (store.me && store.me.userId === u) ? store.me : null;
    store.userModal = found || self || { userId: u, displayName: u, isOnline: false };
  } else {
    store.userModal = u;
  }
}
export const closeUser = () => { store.userModal = null; };

export function openWorld(wid) {
  if (!wid) return;
  closeMobileDrawers();
  store.worldModal = typeof wid === 'string' ? { worldId: wid } : wid;
}
export const closeWorld = () => { store.worldModal = null; };

export function openAvatar(aid) {
  if (!aid) return;
  closeMobileDrawers();
  store.avatarModal = typeof aid === 'string' ? { avatarId: aid } : aid;
}
export const closeAvatar = () => { store.avatarModal = null; };

export function openGroup(g) {
  if (!g) return;
  closeMobileDrawers();
  store.groupModal = typeof g === 'string' ? { groupId: g } : g;
}
export const closeGroup = () => { store.groupModal = null; };

export function openInstance(loc) {
  if (!loc) return;
  closeMobileDrawers();
  store.instanceModal = { location: loc };
}
export const closeInstance = () => { store.instanceModal = null; };

export const openPreview = (url) => { if (url) { closeMobileDrawers(); store.previewUrl = url; } };

export function copyText(t) {
  if (!t) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(t).catch(() => {});
  } else {
    const ta = document.createElement('textarea');
    ta.value = t;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch {}
    ta.remove();
  }
}

export async function applyStatus(status, desc = '') {
  try {
    const d = await post('/api/dashboard/status', { status, statusDescription: desc || '' });
    return d.ok ? '状态已更新' + (desc ? '：' + desc : '') : (d.error || '更新失败');
  } catch {
    return '更新状态失败';
  }
}

// 浏览器通知：请求权限 + 启停（localStorage 记忆）
export async function enableNotifications() {
  try {
    if (!('Notification' in window)) return '当前浏览器不支持通知';
    if (Notification.permission === 'granted') {
      store.notifyEnabled = true;
      localStorage.setItem('vrc_notify', '1');
      return '已开启通知提醒';
    }
    const p = await Notification.requestPermission();
    if (p === 'granted') {
      store.notifyEnabled = true;
      localStorage.setItem('vrc_notify', '1');
      return '已开启通知提醒';
    }
    return '通知权限被拒绝';
  } catch (e) {
    return '开启通知失败：' + (e.message || e);
  }
}
export function disableNotifications() {
  store.notifyEnabled = false;
  try { localStorage.removeItem('vrc_notify'); } catch { /* 忽略 */ }
}
function fireBrowserNotify(title, body) {
  try {
    if (!store.notifyEnabled || !('Notification' in window) || Notification.permission !== 'granted') return;
    const n = new Notification(title, { body, tag: 'vrc-dash', icon: undefined });
    setTimeout(() => n.close(), 10000);
  } catch { /* 通知失败静默 */ }
}

// 关注名单（watchlist）：动态页「只看关注」筛选 + 资料弹窗关注按钮
export async function loadAnnNewFlag() {
  try {
    const r = await get('/api/dashboard/group-announcements-all?limit=1');
    const latest = (r && r.announcements && r.announcements[0] && r.announcements[0].createdAt) || '';
    const base = localStorage.getItem('ga_last_seen') || '';
    store.annHasNew = !!latest && !!base && latest > base;
  } catch {
    store.annHasNew = false;
  }
}

export async function loadNotifCount() {
  try {
    const r = await get('/api/dashboard/notifications/count');
    store.notifCount = (r && r.count) || 0;
  } catch {
    /* 计数加载失败静默（保留旧值） */
  }
}

export async function loadTracked() {
  try {
    const r = await get('/api/dashboard/tracked?limit=500');
    store.trackedIds = new Set(((r && r.tracked) || []).map((x) => x.userId).filter(Boolean));
  } catch {
    /* 追踪名单加载失败静默 */
  }
}

export async function loadWatchlist() {
  try {
    const r = await get('/api/dashboard/watchlist');
    store.watchlistIds = new Set(((r && r.watchlist) || []).map((w) => w.user_id || w.userId).filter(Boolean));
  } catch {
    /* 关注名单加载失败静默（筛选退化为空） */
  }
}

export async function toggleWatch(userId, displayName = '') {
  if (!userId) return '无效用户';
  const on = store.watchlistIds.has(userId);
  try {
    if (on) {
      const r = await post('/api/dashboard/watchlist/remove', { userId });
      if (r && r.success !== false) {
        store.watchlistIds = new Set([...store.watchlistIds].filter((x) => x !== userId));
        return '已取消关注';
      }
      return (r && r.error) || '取消失败';
    }
    const r = await post('/api/dashboard/watchlist', { userId, displayName });
    if (r && r.success !== false) {
      store.watchlistIds = new Set([...store.watchlistIds, userId]);
      return '已关注';
    }
    return (r && r.error) || '关注失败';
  } catch (e) {
    return '关注操作失败：' + (e.message || e);
  }
}

function syncRightGroups() {
  store.onlineFriends = store.friends.filter((f) => f.isOnline);
  store.offlineFriends = store.friends.filter((f) => !f.isOnline);
  store.favFriends = store.friends.filter((f) => store.favFriendIds && store.favFriendIds.has(f.userId));
}

// 关键路径（本地 DB，秒回）+ 慢路径（VRChat API，后台填）
// 已有数据时静默刷新：不再置 feedLoading（避免标题行"同步中…"Tag 闪烁），保持旧列表原地更新
export async function load(quiet = false) {
  const silent = quiet || store.feedEvents.length > 0;
  if (!silent) store.feedLoading = true;
  try {
    const settled = await Promise.allSettled([
      get('/api/dashboard/overview'),
      get('/api/dashboard/friends?limit=100'),
      get(`/api/dashboard/events?limit=50&dateFrom=${encodeURIComponent(store.feedDateFrom || '')}&dateTo=${encodeURIComponent(store.feedDateTo || '')}`),
      get('/api/dashboard/events-range'),
    ]);
    const val = (i) => (settled[i].status === 'fulfilled' ? settled[i].value : null);
    const o = val(0);
    const f = val(1);
    const parsed = parseEvents(val(2));
    const rng = val(3);
    if (rng && rng.min) store.eventsRange = { min: rng.min, max: rng.max || null };
    if (o) {
      store.overview = o;
      store.authStatus = o.auth && o.auth.authenticated ? 'OK' : 'ACT';
      store.wsStatus = o.ws ? (o.ws.status || '—') : '—';
      store.safeMode = !!o.safeMode;
      store.uptime = o.uptime || 0;
      store.dbStatus = o.db ? (o.db.events || 0) : 0;
      if (o.vrcStatus) store.vrcStatus = o.vrcStatus;
      else if (o.status && o.status.indicator) store.vrcStatus = o.status.indicator;
    }
    store.friends = (f && f.friends) || (Array.isArray(f) ? f : store.friends);
    if (!Array.isArray(store.feedEvents) || store.feedEvents.length <= 50) {
      store.feedEvents = parsed.events;
      store.feedTotal = parsed.total || store.feedTotal;
    }
    store.feedHasMore = parsed.events.length >= 50;
    syncRightGroups();

    Promise.allSettled([
      get('/api/dashboard/favorites?type=friends'),
      get('/api/dashboard/nicknames-all'),
      get('/api/dashboard/me'),
    ]).then(([fv, nk, me]) => {
      loadCoPlay();
      store.favFriendIds = new Set(((fv && fv.value && fv.value.favorites) || []).map((x) => x.userId));
      store.nicknameMap = {};
      for (const n of ((nk && nk.value && nk.value.nicknames) || [])) {
        store.nicknameMap[n.user_id || n.userId] = n.nickname || n.displayName || '';
      }
      store.me = (me && me.value && !me.value.error) ? me.value : null;
      syncRightGroups();
    });
  } catch (err) {
    console.warn('Dashboard load error:', err);
  } finally {
    store.feedLoading = false;
  }
}

// 最近一起玩：10 分钟节流（get_recent_cooplay 纯 DB 聚合但 7 天窗口逐日查询不轻）
let coPlayAt = 0;
async function loadCoPlay() {
  if (Date.now() - coPlayAt < 10 * 60_000) return;
  coPlayAt = Date.now();
  try {
    const r = await get('/api/dashboard/co-play?days=7&limit=30');
    store.coPlay = (r && r.companions) || [];
  } catch { /* 右侧栏附属数据，失败静默保留旧值 */ }
}

// 切换筛选时重置列表：只保留当前筛选下的最新数据，避免"为凑数加载"的无关事件堆积
// （否则切回"所有"会一次性渲染几百条 → 卡顿）
export async function resetFeed() {
  store.feedEvents = [];
  store.feedHasMore = true;
  store.feedLoading = true;  // 筛选切换期间显示加载态，不再闪"暂无动态"
  try {
    const parsed = parseEvents(await get(`/api/dashboard/events?limit=50&dateFrom=${encodeURIComponent(store.feedDateFrom || '')}&dateTo=${encodeURIComponent(store.feedDateTo || '')}`));
    store.feedEvents = parsed.events;
    store.feedTotal = parsed.total || store.feedTotal;
    store.feedHasMore = parsed.events.length >= 50;
  } catch {
    store.feedHasMore = false;
  } finally {
    store.feedLoading = false;
  }
}

// 持续加载：在筛选条件下凑够 target 条匹配才停（除非数据库已到底）。
// countMatch(list) 由调用方提供（返回当前筛选下的匹配条数）；不提供则一次加载一批。
export async function loadMoreFeed({ target = 50, countMatch = null } = {}) {
  if (store.feedLoadingMore) return;
  store.feedLoadingMore = true;
  try {
    while (store.feedHasMore) {
      const offset = store.feedEvents.length;
      const d = parseEvents(await get(`/api/dashboard/events?limit=50&offset=${offset}&dateFrom=${encodeURIComponent(store.feedDateFrom || '')}&dateTo=${encodeURIComponent(store.feedDateTo || '')}`));
      store.feedTotal = d.total || store.feedTotal;
      const more = d.events;
      if (!more.length) {
        store.feedHasMore = false;
        break;
      }
      store.feedEvents = [...store.feedEvents, ...more];
      store.feedHasMore = more.length >= 50;
      // 匹配数达标（或没有匹配判定=普通分页一次一批）→ 停；否则继续向前加载
      if (!countMatch) break;
      if (countMatch() >= target) break;
      if (!store.feedHasMore) break;
    }
  } catch {
    store.feedHasMore = false;
  } finally {
    store.feedLoadingMore = false;
  }
}

function applyHash(hp) {
  if (hp.get('view')) store.view = hp.get('view');
  if (hp.has('filter')) store.feedFilter = hp.get('filter') ? hp.get('filter').split(',').filter(Boolean) : [];
  if (hp.has('fav')) store.feedOnlyFav = hp.get('fav') === '1';
}

function initFromHash() {
  const hp = new URLSearchParams(location.hash.replace(/^#/, ''));
  applyHash(hp);
  setView(store.view);
}

// 同页 hash 变化（手动改 URL / 浏览器前进后退）同步视图——SPA 标准行为，无需整页重载
function bindHashChange() {
  window.addEventListener('hashchange', () => {
    const hp = new URLSearchParams(location.hash.replace(/^#/, ''));
    const prev = store.view;
    applyHash(hp);
    if (store.view !== prev) setView(store.view);
  });
}

// SSE 推的是极简 DTO（无 eventId/头像/富化详情），新事件先即时显示，随后用富化列表合并补齐。
// 合并式更新：不整表替换（避免事件风暴时页面不断重渲染、点击被吞）
function mergeFeedEvents(latest) {
  if (!Array.isArray(latest)) return;
  const key = (x) => x.eventId || (x.type + '|' + x.userId + '|' + x.createdAt);
  const seen = new Set();
  const merged = [];
  for (const ev of latest) {
    const k = key(ev);
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(ev);
  }
  // 本地已有的尾部（加载更多追加的）追加回来
  for (const ev of store.feedEvents) {
    const k = key(ev);
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(ev);
  }
  store.feedEvents = merged;
  // 清理裸 DTO 重复：富化版（带 eventId）已存在时，移除同 userId+type+时间窗（±2s）的无 id 副本
  const bare = store.feedEvents.filter((x) => !x.eventId);
  if (!bare.length) return;
  store.feedEvents = store.feedEvents.filter((x) => {
    if (x.eventId) return true;
    const t = new Date(x.createdAt).getTime();
    return !store.feedEvents.some((y) =>
      y.eventId && y.userId === x.userId && y.type === x.type &&
      Number.isFinite(t) && Math.abs(new Date(y.createdAt).getTime() - t) < 2000);
  });
}

let feedRefreshTimer = null;
function refreshFeed() {
  clearTimeout(feedRefreshTimer);
  feedRefreshTimer = setTimeout(async () => {
    try {
      const want = Math.min(Math.max(store.feedEvents.length, 50), 200);
      const e = parseEvents(await get(`/api/dashboard/events?limit=${want}`));
      if (e.events.length) {
        store.feedTotal = e.total || store.feedTotal;
        mergeFeedEvents(e.events);
        store.feedHasMore = e.events.length >= want;
      }
    } catch { /* 保留当前列表，30s 轮询兜底 */ }
  }, 300);
}

// 好友位置/状态变化：刷新好友列表（右侧栏房间分组、房间号自动更新，无需手动刷新）。
// 合并式更新 + 1.2s 节流：事件风暴时不会高频整表替换
let friendsRefreshTimer = null;
let friendsLastRefresh = 0;
function refreshFriends() {
  clearTimeout(friendsRefreshTimer);
  const run = async () => {
    try {
      const f = await get('/api/dashboard/friends?limit=100');
      if (f && Array.isArray(f.friends)) {
        // 按 userId 合并，保留现有顺序，更新已存在的、追加新的
        const m = new Map(store.friends.map((x) => [x.userId, x]));
        for (const nf of f.friends) m.set(nf.userId, nf);
        const merged = f.friends.map((x) => m.get(x.userId));
        for (const x of store.friends) {
          if (!m.has(x.userId)) merged.push(x);
        }
        store.friends = merged;
        syncRightGroups();
        friendsLastRefresh = Date.now();
      }
    } catch { /* 30s 轮询兜底 */ }
  };
  const wait = Math.max(0, friendsLastRefresh + 1200 - Date.now());
  friendsRefreshTimer = setTimeout(run, wait);
}

// 拉取最新"我"（dashboard.me 会用本地 events 表覆盖 status，即时反映别的客户端改状态）。
// fresh=true：绕过 loadMe 缓存，实时拉 VRChat 权威状态（用于 SSE 收到位置/状态变化时立即同步右侧栏）
async function refreshMe(fresh = false) {
  try {
    const me = await get(`/api/dashboard/me${fresh ? '?fresh=1' : ''}`);
    if (me && me.userId) {
      store.me = me;
      syncRightGroups();
    }
  } catch { /* 30s 轮询兜底 */ }
}

// fresh 拉取节流：SSE 位置/状态事件高频触发时，5s 内最多一次实时拉 VRChat 权威状态（避免限流）
let lastFreshMe = 0;
function refreshMeFresh() {
  const now = Date.now();
  if (now - lastFreshMe < 5000) return;
  lastFreshMe = now;
  refreshMe(true);
}

function startSse() {
  const es = openSse(
    (ev) => {
      // DTO 无 eventId：userId+type+时间窗（±2s）去重——裸 DTO 与富化版 createdAt 可能有精度差异，严格相等会漏判
      const evT = new Date(ev.createdAt).getTime();
      const dup = store.feedEvents.some((x) =>
        x.userId === ev.userId && x.type === ev.type &&
        Number.isFinite(evT) && Math.abs(new Date(x.createdAt).getTime() - evT) < 2000);
      if (!dup) {
        store.feedEvents = [ev, ...store.feedEvents];
        refreshFeed(); // 拉富化数据补齐头像/详情
      }
      // 好友位置/在线状态变化 → 直接原地更新该好友（服务端已富化，无需全量拉 /friends）
      if (ev.type === 'friend-location' || ev.type === 'friend-online' || ev.type === 'friend-offline'
        || ev.type === 'friend-update' || ev.type === 'friend-active') {
        updateFriendFromEvent(ev);
      }
      // 导航徽标：任何通知事件未读+1
      if (ev.type === 'notification' || ev.type === 'notification-v2') {
        store.notifCount += 1;
      }
      // 浏览器通知：好友请求/邀请/群组邀请等重要通知
      if (ev.type === 'notification' || ev.type === 'notification-v2') {
        const nt = ev.notificationType || ev.updateType || ev.type;
        const isImportant = ['friendRequest', 'invite', 'requestInvite', 'groupInvite', 'groupJoinRequest'].includes(nt);
        if (isImportant) {
          const who = ev.senderUsername || ev.displayName || '';
          fireBrowserNotify('VRChat 通知', `${who ? who + '：' : ''}${ev.message || ev.title || nt}`);
        }
      }
      // 自己在别的客户端改状态/位置 → 同步"我"的状态（右侧栏顶部，即时更新）
      if (ev.type === 'user-update' && store.me && ev.status) {
        store.me.status = ev.status;
        store.me.statusDescription = ev.statusDescription || '';
        syncRightGroups();
      }
      if (ev.type === 'user-location' && store.me && ev.location) {
        store.me.location = ev.location;
        syncRightGroups();
      }
      // 兜底：改状态/位置事件到达时，实时拉一次 VRChat 权威状态（绕过 loadMe 缓存），
      // 避免右侧栏状态依赖慢速的 WS user-update 而滞后于动态页
      if (ev.type === 'user-update' || ev.type === 'user-location') {
        refreshMeFresh();
      }
    },
    (st) => {
      store.sseStatus = st;
      // SSE 重连成功后重算未读徽标（断开期间可能漏计数/多计数）；补一次全量校准，防丢帧
      if (st === 'open') { loadNotifCount(); load(true); }
    }
  );
  if (es && es.addEventListener) es.addEventListener('error', () => { store.sseStatus = 'reconnecting'; });
}

// SSE 事件驱动的"好友原地增量更新"——服务端已富化（昵称/头像/状态/位置/平台/信任等级），
// 前端收到直接替换 state.friends 里该好友，无需全量拉 /friends（2026-09-01 SSE 增量改造）。
function updateFriendFromEvent(ev) {
  const i = store.friends.findIndex((f) => f.userId === ev.userId);
  if (i < 0) return; // 非好友（如 tracked）用 load() 校准兜底
  const old = store.friends[i];
  const nf = { ...old };
  // 只覆盖 SSE 富化字段已有的；空值不覆盖（保留原值）
  const map = {
    displayName: ev.displayName, nickname: ev.nickname, avatarUrl: ev.avatarUrl,
    userIcon: ev.userIcon, status: ev.status, statusDescription: ev.statusDescription,
    platform: ev.platform, trustLevel: ev.trustLevel, isOnline: ev.isOnline,
    bio: ev.bio, pronouns: ev.pronouns,
  };
  for (const k of Object.keys(map)) if (map[k] != null && map[k] !== '') nf[k] = map[k];
  // friend-location → 更新位置字段
  if (ev.type === 'friend-location') {
    if (ev.worldId) nf.worldId = ev.worldId;
    if (ev.worldName) nf.worldName = ev.worldName;
  }
  if (ev.type === 'friend-online') nf.isOnline = true;
  if (ev.type === 'friend-offline') nf.isOnline = false;
  store.friends[i] = nf;
  syncRightGroups();
}

function trackViewport() {
  const update = () => { store.isMobile = window.innerWidth < 900; };
  update();
  window.addEventListener('resize', update);
}

// 视图快捷键映射：Alt+数字 或 Ctrl+数字 快速切换（数字 = 导航顺序，避开输入框聚焦态）
const VIEW_HOTKEYS = ['feed', 'friends', 'tracked', 'players', 'notifications', 'search', 'favorites', 'worlds', 'avatars'];
const isTyping = (t) => {
  const tag = (t && t.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || (t && t.isContentEditable);
};

function initKeyboard() {
  // Esc 关闭弹窗；Ctrl/Cmd+K 打开快速搜索
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      store.quickSearchOpen = !store.quickSearchOpen;
      return;
    }
    // Alt/Ctrl + 数字 切换视图（输入框中不响应）
    if (e.altKey && /^[1-9]$/.test(e.key) && !isTyping(e.target)) {
      e.preventDefault();
      const v = VIEW_HOTKEYS[Number(e.key) - 1];
      if (v && store.view !== v) setView(v);
      return;
    }
    // 动态页 "/" 聚焦搜索（输入框中不响应；按两次 Esc 依次关弹窗→取消聚焦）
    if (e.key === '/' && !isTyping(e.target) && !(e.ctrlKey || e.metaKey || e.altKey)) {
      const input = document.querySelector('.search-input, .ft-search input');
      if (input) {
        e.preventDefault();
        input.focus();
        input.select();
      }
      return;
    }
    if (e.key === 'Escape') {
      if (store.quickSearchOpen) { store.quickSearchOpen = false; return; }
      if (store.userModal) { store.userModal = null; return; }
      if (store.worldModal) { store.worldModal = null; return; }
      if (store.avatarModal) { store.avatarModal = null; return; }
      if (store.groupModal) { store.groupModal = null; return; }
      if (store.instanceModal) { store.instanceModal = null; return; }
    }
  });
}

export function startDashboard() {
  initFromHash();
  load();
  loadWatchlist();
  loadTracked();
  loadNotifCount();
  loadAnnNewFlag();
  try { store.notifyEnabled = localStorage.getItem('vrc_notify') === '1'; } catch { /* 隐私模式 */ }
  startSse();
  trackViewport();
  initKeyboard();
  bindHashChange();
  setInterval(() => load(true), 120000);  // 全量校准：120s 一次（SSE 增量主导，全量只防丢帧/断线自愈）
  // 右侧栏"我自己"状态/位置：由 SSE user-update/user-location 事件直接更新 me + refreshMeFresh() 节流拉取，
  // 不再需要 10s 定时全量拉 /me（已移除，2026-09-01 SSE 增量改造）
}
