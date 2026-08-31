// Vue 核心数据层与全局动作
(function () {
  if (typeof Vue === 'undefined') return;
  const { reactive } = Vue;

  const token = new URLSearchParams(location.search).get('token') || sessionStorage.getItem('vrc_dashboard_token') || '';
  if (token) sessionStorage.setItem('vrc_dashboard_token', token);

  const api = (p) => (token ? `${p}${p.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : p);
  window.__api = api;

  const get = async (p, timeout = 25000) => {
    const r = await fetch(api(p), { signal: AbortSignal.timeout(timeout) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  };
  window.__get = get;

  const post = async (p, body = {}, timeout = 25000) => {
    const r = await fetch(api(p), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  };
  window.__post = post;

  const store = reactive({
    view: 'feed',
    feedFilter: 'all',
    feedDateFilter: 'all',
    feedSearch: '',
    friendsSearch: '',
    friendsTab: 'all',
    favoritesTab: 'worlds',
    favWorldGroup: 'all',
    chartsDays: 7,
    logsDays: 7,
    friends: [],
    feedEvents: [],
    feedHasMore: false,
    feedLoading: false,
    feedLoadingMore: false,
    overview: null,
    me: null,
    nicknameMap: {},
    favFriendIds: new Set(),
    userModal: null,
    worldModal: null,
    avatarModal: null,
    groupModal: null,
    quickSearchOpen: false,
    previewUrl: null,
    toastMsg: '',
    toastTimer: null,
    vrcStatus: null,
    sseStatus: 'connected',
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
    onlineFriends: [],
    offlineFriends: [],
    favFriends: [],
  });
  window.__store = store;

  const toast = (msg) => {
    if (!msg) return;
    store.toastMsg = String(msg);
    clearTimeout(store.toastTimer);
    store.toastTimer = setTimeout(() => {
      store.toastMsg = '';
    }, 2200);
  };
  window.toast = toast;
  window.__toastMsg = toast;

  const copyText = (t) => {
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
    toast('已复制: ' + String(t).slice(0, 28));
  };
  window.copyText = copyText;

  const openUser = (u) => {
    if (!u) return;
    if (typeof u === 'string') {
      const found = (store.friends || []).find((f) => f.userId === u);
      store.userModal = found || { userId: u, displayName: u, isOnline: false };
    } else {
      store.userModal = u;
    }
  };
  window.openUser = openUser;

  const closeUser = () => { store.userModal = null; };
  window.closeUser = closeUser;

  const openWorld = (wid) => {
    if (!wid) return;
    store.worldModal = typeof wid === 'string' ? { worldId: wid } : wid;
  };
  window.openWorld = openWorld;

  const closeWorld = () => { store.worldModal = null; };
  window.closeWorld = closeWorld;

  const openAvatar = (aid) => {
    if (!aid) return;
    store.avatarModal = typeof aid === 'string' ? { avatarId: aid } : aid;
  };
  window.openAvatar = openAvatar;

  const closeAvatar = () => { store.avatarModal = null; };
  window.closeAvatar = closeAvatar;

  const openGroup = (gid) => {
    if (!gid) return;
    store.groupModal = typeof gid === 'string' ? { groupId: gid } : gid;
  };
  window.openGroup = openGroup;

  const closeGroup = () => { store.groupModal = null; };
  window.closeGroup = closeGroup;

  const openPreview = (url) => { store.previewUrl = url; };
  window.openPreview = openPreview;

  const closePreview = () => { store.previewUrl = null; };
  window.closePreview = closePreview;

  const applyStatus = async (status, desc = '') => {
    try {
      const d = await post('/api/dashboard/status', { status, statusDescription: desc || '' });
      toast(d.ok ? '状态已更新' + (desc ? '：' + desc : '') : (d.error || '更新失败'));
    } catch {
      toast('更新状态失败');
    }
  };
  window.applyStatus = applyStatus;

  function syncRightGroups() {
    const isWeb = typeof window.isWebOnline === 'function' ? window.isWebOnline : (f) => f.platform === 'web';
    store.onlineFriends = store.friends.filter((f) => f.isOnline);
    store.offlineFriends = store.friends.filter((f) => !f.isOnline);
    store.favFriends = store.friends.filter((f) => store.favFriendIds && store.favFriendIds.has(f.userId));
  }

  async function load(quiet = false) {
    if (!quiet) store.feedLoading = true;
    try {
      // 关键路径（本地 DB，秒回）：overview / friends / events —— 动态流与首屏只依赖这些。
      // 冷启动/重启后不让收藏/备注/我（VRChat API，限流排队可能数十秒）阻塞首屏渲染。
      const [o, f, e] = await Promise.all([
        get('/api/dashboard/overview'),
        get('/api/dashboard/friends?limit=100'),
        get('/api/dashboard/events?limit=50'),
      ]);
      store.overview = o;
      // 底部状态栏（AUTH/WS/DB/VRC）
      store.authStatus = o && o.auth && o.auth.authenticated ? 'OK' : 'ACT';
      store.wsStatus = o && o.ws ? (o.ws.status || '—') : '—';
      store.dbStatus = o && o.db ? (o.db.events || 0) : 0;
      if (o) { if (o.vrcStatus) store.vrcStatus = o.vrcStatus; else if (o.status && o.status.indicator) store.vrcStatus = o.status.indicator; }
      store.friends = f.friends || [];
      if (store.feedEvents.length <= 50) {
        store.feedEvents = e.events || [];
      }
      store.feedHasMore = (e.events || []).length >= 50;
      syncRightGroups();
      // 慢路径（VRChat API，冷库可能排队）：收藏好友 / 全部备注 / 我 —— 后台填，不阻塞首屏
      Promise.allSettled([
        get('/api/dashboard/favorites?type=friends'),
        get('/api/dashboard/nicknames-all'),
        get('/api/dashboard/me'),
      ]).then(([fv, nk, me]) => {
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
  window.__load = load;

  async function loadMoreFeed() {
    if (store.feedLoadingMore || !store.feedHasMore) return;
    store.feedLoadingMore = true;
    try {
      const offset = store.feedEvents.length;
      const d = await get(`/api/dashboard/events?limit=50&offset=${offset}`);
      const more = d.events || [];
      if (!more.length) {
        store.feedHasMore = false;
      } else {
        store.feedEvents = [...store.feedEvents, ...more];
        store.feedHasMore = more.length >= 50;
      }
    } catch {
      toast('加载更多动态失败');
    } finally {
      store.feedLoadingMore = false;
    }
  }
  window.loadMoreFeed = loadMoreFeed;

  function syncHash() {
    const q = new URLSearchParams();
    q.set('view', store.view);
    if (store.feedFilter && store.feedFilter !== 'all') q.set('filter', store.feedFilter);
    history.replaceState(null, '', location.pathname + location.search + '#' + q.toString());
    const vmap = {
      feed: '好友动态', friends: '好友位置', logs: '游戏日志', players: '房间玩家列表',
      notifications: '通知', favorites: '收藏', avatars: '我的模型', moderation: '屏蔽管理',
      charts: '图表', worlds: '世界记录', tools: '工具', search: '搜索', open: '直接打开',
    };
    document.title = 'VRChat Assistant · ' + (vmap[store.view] || 'VRCX Web');
  }
  window.syncHash = syncHash;

  function initFromHash() {
    const hp = new URLSearchParams(location.hash.replace(/^#/, ''));
    if (hp.get('view')) store.view = hp.get('view');
    if (hp.get('filter')) store.feedFilter = hp.get('filter');
    syncHash();
  }

  // ── SSE 实时更新 ──
  function startSse() {
    try {
      const es = new EventSource(api('/api/dashboard/stream'));
      es.onopen = () => { store.sseStatus = 'connected'; };
      es.onmessage = (m) => {
        try {
          const d = JSON.parse(m.data);
          if (d.type === 'event' && d.event) {
            const ev = d.event;
            // 实时追加到 feedEvents 开头
            if (!store.feedEvents.some((x) => x.eventId === ev.eventId)) {
              store.feedEvents = [ev, ...store.feedEvents];
            }
          }
        } catch {}
      };
      es.onerror = () => { store.sseStatus = 'reconnecting'; };
    } catch {}
  }

  // ── 快捷键监听（Ctrl+K 与 Escape）──
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      store.quickSearchOpen = !store.quickSearchOpen;
    } else if (e.key === 'Escape') {
      if (store.previewUrl) { store.previewUrl = null; return; }
      if (store.quickSearchOpen) { store.quickSearchOpen = false; return; }
      if (store.userModal) { store.userModal = null; return; }
      if (store.worldModal) { store.worldModal = null; return; }
      if (store.avatarModal) { store.avatarModal = null; return; }
      if (store.groupModal) { store.groupModal = null; return; }
    }
  });

  // ── 启动初始化 ──
  initFromHash();
  load();
  startSse();
  setInterval(() => load(true), 30000);
})();
