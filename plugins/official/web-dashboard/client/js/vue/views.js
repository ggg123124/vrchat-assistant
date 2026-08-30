// Vue 视图组件库：完全对齐官方 VRCX 12 大核心视图
(function () {
  if (typeof Vue === 'undefined') return;

  // ── 1. FeedView (好友动态，参考 VRCX Feed.vue) ──
  const FeedView = {
    template: `<div class="feed-view">
      <div class="toolbar-sub">
        <div class="filters">
          <button v-for="f in filters" :key="f.v" class="filter" :class="{ active: store.feedFilter === f.v, star: f.v === 'fav' }" @click="setFilter(f.v)">{{ f.l }}</button>
          <span class="filters-sep"></span>
          <button v-for="d in dateFilters" :key="d.v" class="filter" :class="{ active: store.feedDateFilter === d.v }" @click="store.feedDateFilter = d.v">{{ d.l }}</button>
        </div>
        <input class="feed-search" v-model="store.feedSearch" placeholder="搜索动态玩家/世界…" aria-label="搜索动态">
      </div>

      <div class="tablewrap">
        <div class="tablehead">
          <span class="th-exp"></span>
          <span class="th-time">时间</span>
          <span class="th-type">类型</span>
          <span class="th-player">玩家</span>
          <span class="th-detail">详细信息</span>
          <span class="th-world">世界 / 位置</span>
        </div>

        <div v-for="x in rows" :key="x.eventId" class="event" :class="{ open: expandedId === x.eventId }" @click="toggleExpand(x.eventId)">
          <span class="expander-icon">{{ expandedId === x.eventId ? '▾' : '▸' }}</span>
          <time class="time">
            <b>{{ fmtTime(x.createdAt) }}</b>
            <small>{{ fmtDate(x.createdAt) }}</small>
          </time>
          <span class="type-badge" :class="typeClass(x.type)">
            <i class="type-dot"></i>{{ typeLabel(x.type) }}
          </span>
          <div class="player" @click.stop="openUser(x.userId)">
            <img class="avatar-sm" :src="avatarUrl(x)" @error="handleError" :title="x.displayName" alt="" loading="lazy">
            <b class="player-name" :style="{ color: trustColorOf(x) }">{{ playerName(x) }}</b>
          </div>
          <div class="detail-cell">
            <strong>{{ x.summary || '已记录' }}</strong>
            <span v-if="detailExtra(x)" class="detail-extra"> · {{ detailExtra(x) }}</span>
          </div>
          <div class="world-cell">
            <template v-if="x.worldId && x.worldId.startsWith('wrld_')">
              <span class="world-link" @click.stop="openWorld(x.worldId)" title="点击查看世界资料">
                <img v-if="x.worldImageUrl" class="wthumb" :src="x.worldImageUrl" @error="handleError" alt="" loading="lazy">
                <span class="wname">{{ worldNameOf(x) }}</span>
                <i v-if="x.groupName" class="grp-chip">{{ x.groupName }}</i>
                <i v-if="locTag(x.location)" class="instance-chip">{{ locTag(x.location) }}</i>
              </span>
            </template>
            <template v-else>
              <span class="wname-dim">{{ worldNameOf(x) }}</span>
            </template>
          </div>

          <!-- 展开抽屉 -->
          <div v-if="expandedId === x.eventId" class="event-drawer" @click.stop>
            <div class="drawer-grid">
              <div class="drawer-col">
                <label>玩家</label>
                <p><b>{{ playerName(x) }}</b> ({{ x.userId }})</p>
                <label>信任等级</label>
                <p><span class="trust-badge" :style="{ color: trustColorOf(x) }">{{ x.trustLevel || 'User' }}</span></p>
              </div>
              <div class="drawer-col">
                <label>事件类型</label>
                <p>{{ x.type }}</p>
                <label>记录时间</label>
                <p>{{ fmtFullTime(x.createdAt) }}</p>
              </div>
              <div class="drawer-col" v-if="x.worldId">
                <label>所在世界</label>
                <p>{{ x.worldName || x.worldId }}</p>
                <label>实例编号</label>
                <p>{{ x.instanceId || '—' }}</p>
              </div>
            </div>
            <div class="drawer-actions">
              <button class="btn-xs" @click="openUser(x.userId)">查看资料</button>
              <button class="btn-xs" v-if="x.worldId" @click="openWorld(x.worldId)">查看世界</button>
              <button class="btn-xs" @click="copy(x.userId)">复制 User ID</button>
            </div>
          </div>
        </div>
        <div v-if="!rows.length" class="empty">暂无符合条件的动态记录</div>
      </div>
    </div>`,
    data() {
      return {
        store: window.__store,
        expandedId: null,
        filters: [
          { v: 'all', l: '全部' },
          { v: 'location', l: '位置' },
          { v: 'status', l: '状态' },
          { v: 'avatar', l: '模型' },
          { v: 'fav', l: '★ 收藏好友' },
        ],
        dateFilters: [
          { v: 'all', l: '全部时间' },
          { v: 'today', l: '今天' },
          { v: 'week', l: '近 7 天' },
        ],
      };
    },
    computed: {
      rows() {
        let list = this.store.feedEvents || [];
        const f = this.store.feedFilter;
        if (f === 'location') list = list.filter((e) => e.type === 'friend-location');
        else if (f === 'status') list = list.filter((e) => e.type === 'friend-online' || e.type === 'friend-offline' || (e.type === 'friend-update' && e.updateType === 'status'));
        else if (f === 'avatar') list = list.filter((e) => e.type === 'friend-update' && e.updateType === 'avatar');
        else if (f === 'fav') list = list.filter((e) => this.store.favFriendIds && this.store.favFriendIds.has(e.userId));

        const df = this.store.feedDateFilter;
        const now = Date.now();
        if (df === 'today') {
          const startOfToday = new Date().setHours(0, 0, 0, 0);
          list = list.filter((e) => new Date(e.createdAt).getTime() >= startOfToday);
        } else if (df === 'week') {
          list = list.filter((e) => now - new Date(e.createdAt).getTime() <= 7 * 86400000);
        }

        const q = (this.store.feedSearch || '').trim().toLowerCase();
        if (q) {
          list = list.filter((e) =>
            (e.displayName || '').toLowerCase().includes(q) ||
            (e.worldName || '').toLowerCase().includes(q) ||
            (e.summary || '').toLowerCase().includes(q) ||
            (e.userId || '').toLowerCase().includes(q)
          );
        }
        return list;
      },
    },
    methods: {
      avatarUrl(item) { return typeof window.avatarUrlFor === 'function' ? window.avatarUrlFor(item, this.store.friends) : (item.avatarUrl || item.userIcon || ''); },
      handleError: (e) => (typeof window.handleImgError === 'function' ? window.handleImgError(e) : null),
      setFilter(v) { this.store.feedFilter = v; },
      toggleExpand(id) { this.expandedId = this.expandedId === id ? null : id; },
      fmtTime: (s) => (s ? new Date(s).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : ''),
      fmtDate: (s) => (s ? new Date(s).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) : ''),
      fmtFullTime: (s) => (s ? new Date(s).toLocaleString('zh-CN') : ''),
      typeClass(t) {
        const m = { 'friend-online': 't-online', 'friend-offline': 't-offline', 'friend-location': 't-loc', 'friend-update': 't-update' };
        return m[t] || 't-update';
      },
      typeLabel(t) {
        const m = { 'friend-online': '上线', 'friend-offline': '下线', 'friend-location': '位置', 'friend-update': '更新' };
        return m[t] || t || '动态';
      },
      playerName(x) { return x.displayName || x.userId || '?'; },
      trustColorOf: (x) => (typeof window.trustColor === 'function' ? window.trustColor(x.trustLevel) : '#8a94a0'),
      statusOf(x) { return x.status || (x.type === 'friend-online' ? 'active' : 'offline'); },
      detailExtra(x) {
        if (x.previousLocation && x.location && x.previousLocation !== x.location) return `从 ${x.previousLocation}`;
        if (x.previousStatusDescription) return `原状态: ${x.previousStatusDescription}`;
        return '';
      },
      worldNameOf(x) {
        if (typeof window.worldLabel === 'function') return window.worldLabel(x, x.worldName);
        return x.worldName || (x.worldId ? x.worldId.slice(0, 14) : '—');
      },
      locTag: (loc) => (typeof window.locLabel === 'function' ? window.locLabel(loc) : ''),
      openUser(uid) { if (window.openUser) window.openUser(uid); },
      openWorld(wid) { if (window.openWorld) window.openWorld(wid); },
      copy(t) { if (window.copyText) window.copyText(t); },
    },
  };

  // ── 2. FriendsView (好友管理，参考 VRCX FriendList.vue) ──
  const FriendsView = {
    template: `<div class="friends-view">
      <div class="toolbar-sub">
        <div class="filters">
          <button v-for="t in tabs" :key="t.v" class="filter" :class="{ active: tab === t.v }" @click="tab = t.v">{{ t.l }} ({{ countOf(t.v) }})</button>
        </div>
        <input class="feed-search" v-model="q" placeholder="搜索好友名称/ID…" aria-label="搜索好友">
      </div>

      <div class="tablewrap">
        <div class="fl-grid">
          <div v-for="f in list" :key="f.userId" class="friend-card" @click="openUser(f.userId)">
            <img class="avatar-md" :src="avatarUrl(f)" @error="handleError" alt="" loading="lazy">
            <div class="fc-info">
              <div class="fc-name-row">
                <b :style="{ color: trustColor(f.trustLevel) }">{{ f.displayName }}</b>
                <span class="status-dot-inline" :class="'sd-' + statusOf(f)"></span>
              </div>
              <div class="fc-sub">
                <span class="fs-desc">{{ statusDesc(f) }}</span>
                <span v-if="f.worldName" class="fs-world"> · 📍 {{ f.worldName }}</span>
              </div>
            </div>
          </div>
        </div>
        <div v-if="!list.length" class="empty">无匹配好友</div>
      </div>
    </div>`,
    data() {
      return {
        store: window.__store,
        tab: 'all',
        q: '',
        tabs: [
          { v: 'all', l: '全部好友' },
          { v: 'online', l: '在线' },
          { v: 'fav', l: '☆ 收藏' },
          { v: 'offline', l: '离线' },
        ],
      };
    },
    computed: {
      all() { return this.store.friends || []; },
      list() {
        let arr = this.all;
        if (this.tab === 'online') arr = arr.filter((f) => f.isOnline);
        else if (this.tab === 'offline') arr = arr.filter((f) => !f.isOnline);
        else if (this.tab === 'fav') arr = arr.filter((f) => this.store.favFriendIds && this.store.favFriendIds.has(f.userId));

        const query = this.q.trim().toLowerCase();
        if (query) {
          arr = arr.filter((f) =>
            (f.displayName || '').toLowerCase().includes(query) ||
            (f.userId || '').includes(query)
          );
        }
        return arr;
      },
    },
    methods: {
      avatarUrl(item) { return typeof window.avatarUrlFor === 'function' ? window.avatarUrlFor(item, this.store.friends) : (item.avatarUrl || item.userIcon || ''); },
      handleError: (e) => (typeof window.handleImgError === 'function' ? window.handleImgError(e) : null),
      trustColor: (t) => (typeof window.trustColor === 'function' ? window.trustColor(t) : '#8a94a0'),
      openUser(uid) { if (window.openUser) window.openUser(uid); },
      statusOf(f) {
        if (typeof window.isWebOnline === 'function' && window.isWebOnline(f)) return 'web';
        return f.isOnline ? (f.status || 'active') : 'offline';
      },
      statusDesc(f) {
        if (typeof window.isWebOnline === 'function' && window.isWebOnline(f)) return '网页在线';
        return f.isOnline ? (f.statusDescription || '在线') : '离线';
      },
      countOf(t) {
        if (t === 'online') return this.all.filter((f) => f.isOnline).length;
        if (t === 'offline') return this.all.filter((f) => !f.isOnline).length;
        if (t === 'fav') return this.all.filter((f) => this.store.favFriendIds && this.store.favFriendIds.has(f.userId)).length;
        return this.all.length;
      },
    },
  };

  // ── 3. LogsView (游戏与网络日志，参考 VRCX GameLog.vue) ──
  const LogsView = {
    template: `<div class="logs-view">
      <div class="toolbar-sub">
        <div class="filters">
          <button v-for="t in types" :key="t.v" class="filter" :class="{ active: curType === t.v }" @click="curType = t.v">{{ t.l }}</button>
        </div>
        <input class="feed-search" v-model="q" placeholder="过滤日志文本…" aria-label="搜索日志">
      </div>
      <div class="tablewrap">
        <div class="log-lines">
          <div v-for="(l, i) in filtered" :key="i" class="log-row" :class="logClass(l)">
            <span class="log-time">{{ l.time || '—' }}</span>
            <span class="log-tag">{{ l.tag || 'INFO' }}</span>
            <span class="log-msg">{{ l.msg || l.text || l }}</span>
          </div>
        </div>
        <div v-if="!filtered.length" class="empty">暂无日志内容</div>
      </div>
    </div>`,
    data() {
      return {
        store: window.__store,
        curType: 'all',
        q: '',
        logs: [],
        types: [
          { v: 'all', l: '全部日志' },
          { v: 'join', l: '进房记录' },
          { v: 'warn', l: '警告/错误' },
        ],
      };
    },
    computed: {
      filtered() {
        let arr = this.logs;
        if (this.curType === 'join') arr = arr.filter((l) => (l.msg || '').includes('join') || (l.tag || '').includes('JOIN'));
        else if (this.curType === 'warn') arr = arr.filter((l) => (l.tag || '').includes('WARN') || (l.tag || '').includes('ERR'));
        const query = this.q.trim().toLowerCase();
        if (query) arr = arr.filter((l) => String(l.msg || l.text || l).toLowerCase().includes(query));
        return arr;
      },
    },
    mounted() { this.load(); },
    methods: {
      async load() {
        try {
          const d = await window.__get('/api/dashboard/game-sessions?days=7');
          this.logs = (d.sessions || []).map((s) => ({
            time: s.start ? new Date(s.start).toLocaleString('zh-CN') : '',
            tag: 'WORLD',
            msg: `进入世界: ${s.worldName || s.worldId} (游玩约 ${s.durationMinutes || 0} 分钟)`,
          }));
        } catch { this.logs = []; }
      },
      logClass(l) {
        if ((l.tag || '').includes('ERR')) return 'lr-err';
        if ((l.tag || '').includes('WARN')) return 'lr-warn';
        return 'lr-info';
      },
    },
  };

  // ── 4. PlayersView (同屏玩家 / 曾见过的玩家) ──
  const PlayersView = {
    template: `<div class="players-view">
      <div class="toolbar-sub">
        <div class="filters">
          <button class="filter active">最近遇见的玩家 ({{ players.length }})</button>
        </div>
        <input class="feed-search" v-model="q" placeholder="搜索玩家…" aria-label="搜索玩家">
      </div>
      <div class="tablewrap">
        <div class="fl-grid">
          <div v-for="p in filtered" :key="p.userId" class="friend-card" @click="openUser(p.userId)">
            <img class="avatar-md" :src="avatarUrl(p)" @error="handleError" alt="" loading="lazy">
            <div class="fc-info">
              <b class="fc-name">{{ p.displayName || p.userId }}</b>
              <small class="fc-sub">最后偶遇: {{ fmtTime(p.lastSeen) }}</small>
            </div>
          </div>
        </div>
        <div v-if="!filtered.length" class="empty">暂无同屏记录</div>
      </div>
    </div>`,
    data() {
      return {
        store: window.__store,
        q: '',
        players: [],
      };
    },
    computed: {
      filtered() {
        const query = this.q.trim().toLowerCase();
        if (!query) return this.players;
        return this.players.filter((p) =>
          (p.displayName || '').toLowerCase().includes(query) || (p.userId || '').includes(query)
        );
      },
    },
    mounted() { this.load(); },
    methods: {
      avatarUrl(item) { return typeof window.avatarUrlFor === 'function' ? window.avatarUrlFor(item, this.store.friends) : (item.avatarUrl || item.userIcon || ''); },
      handleError: (e) => (typeof window.handleImgError === 'function' ? window.handleImgError(e) : null),
      async load() {
        try {
          const d = await window.__get('/api/dashboard/stats?days=7');
          this.players = (d.topFriends || []).map((x) => ({
            userId: x.userId,
            displayName: x.displayName,
            lastSeen: new Date().toISOString(),
          }));
        } catch { this.players = []; }
      },
      openUser(uid) { if (window.openUser) window.openUser(uid); },
      fmtTime: (s) => (s ? new Date(s).toLocaleDateString('zh-CN') : '近期'),
    },
  };

  // ── 5. NotificationsView (系统与邀请通知) ──
  const NotificationsView = {
    template: `<div class="notif-view">
      <div class="toolbar-sub">
        <div class="filters">
          <button v-for="t in types" :key="t.v" class="filter" :class="{ active: curType === t.v }" @click="curType = t.v">{{ t.l }} ({{ countOf(t.v) }})</button>
        </div>
        <button class="btn-secondary-sm" @click="markAllSeen">全部已读</button>
      </div>

      <div class="tablewrap">
        <div v-for="n in filteredList" :key="n.id || n.eventId" class="notif-card" :class="'nc-' + notifCategory(n)">
          <img class="notif-avatar" :src="avatarUrl(n)" @error="handleError" alt="" loading="lazy">
          <div class="notif-body">
            <div class="notif-head">
              <span class="notif-badge">{{ notifLabel(n.type) }}</span>
              <b class="notif-sender" @click="openUser(n.senderUserId)">{{ n.senderUsername || n.senderUserId || '系统通知' }}</b>
              <time class="notif-time">{{ fmtTime(n.created_at || n.createdAt) }}</time>
            </div>
            <p class="notif-msg">{{ n.message || n.details?.worldName || '发送了一条通知' }}</p>
          </div>
          <div class="notif-actions">
            <template v-if="n.type === 'friendRequest'">
              <button class="btn-primary-sm" @click="respondFriend(n, 'accept')">接受</button>
              <button class="btn-secondary-sm" @click="respondFriend(n, 'decline')">拒绝</button>
            </template>
            <template v-else-if="n.type === 'invite' || n.type === 'requestInvite'">
              <button class="btn-primary-sm" @click="respondInvite(n, true)">接受</button>
              <button class="btn-secondary-sm" @click="respondInvite(n, false)">拒绝</button>
            </template>
            <template v-else>
              <button class="btn-secondary-sm" @click="see(n)">已读</button>
            </template>
          </div>
        </div>
        <div v-if="!filteredList.length" class="empty">暂无通知</div>
      </div>
    </div>`,
    data() {
      return {
        store: window.__store,
        curType: 'all',
        list: [],
        types: [
          { v: 'all', l: '全部通知' },
          { v: 'friend', l: '好友请求' },
          { v: 'invite', l: '房间邀请' },
          { v: 'group', l: '群组邀请' },
        ],
      };
    },
    computed: {
      filteredList() {
        if (this.curType === 'all') return this.list;
        if (this.curType === 'friend') return this.list.filter((n) => n.type === 'friendRequest');
        if (this.curType === 'invite') return this.list.filter((n) => n.type === 'invite' || n.type === 'requestInvite');
        if (this.curType === 'group') return this.list.filter((n) => String(n.type).startsWith('group.'));
        return this.list;
      },
    },
    mounted() { this.load(); },
    methods: {
      avatarUrl(item) { return typeof window.avatarUrlFor === 'function' ? window.avatarUrlFor(item, this.store.friends) : (item.avatarUrl || item.userIcon || ''); },
      handleError: (e) => (typeof window.handleImgError === 'function' ? window.handleImgError(e) : null),
      countOf(t) {
        if (t === 'friend') return this.list.filter((n) => n.type === 'friendRequest').length;
        if (t === 'invite') return this.list.filter((n) => n.type === 'invite' || n.type === 'requestInvite').length;
        if (t === 'group') return this.list.filter((n) => String(n.type).startsWith('group.')).length;
        return this.list.length;
      },
      async load() {
        try {
          const d = await window.__get('/api/dashboard/notifications');
          this.list = d.notifications || [];
        } catch { this.list = []; }
      },
      openUser(uid) { if (uid && window.openUser) window.openUser(uid); },
      fmtTime: (s) => (s ? new Date(s).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''),
      notifCategory(n) {
        if (n.type === 'friendRequest') return 'friend';
        if (n.type === 'invite' || n.type === 'requestInvite') return 'invite';
        if (String(n.type).startsWith('group.')) return 'group';
        return 'other';
      },
      notifLabel(t) {
        const m = { friendRequest: '好友请求', invite: '邀请进入', requestInvite: '请求邀请', 'group.invite': '群组邀请' };
        return m[t] || t || '通知';
      },
      async respondFriend(n, action) {
        try {
          const d = await window.__post('/api/dashboard/notifications/respond', { notificationId: n.id, action, confirmed: true });
          if (d.ok) {
            this.list = this.list.filter((x) => x.id !== n.id);
            if (window.toast) window.toast(action === 'accept' ? '已接受好友请求' : '已拒绝');
          }
        } catch { if (window.toast) window.toast('操作失败'); }
      },
      async respondInvite(n, accept) {
        try {
          const d = await window.__post('/api/dashboard/notifications/invite-response', { notificationId: n.id, accept });
          if (d.ok) {
            this.list = this.list.filter((x) => x.id !== n.id);
            if (window.toast) window.toast(accept ? '已接受邀请' : '已拒绝');
          }
        } catch { if (window.toast) window.toast('操作失败'); }
      },
      async see(n) {
        try {
          await window.__post('/api/dashboard/notifications/see', { notificationId: n.id });
          this.list = this.list.filter((x) => x.id !== n.id);
        } catch {}
      },
      async markAllSeen() {
        try {
          const d = await window.__post('/api/dashboard/notifications/see-all', {});
          if (d.ok) {
            if (window.toast) window.toast(`已标记 ${d.seen || 0} 条通知为已读`);
            this.load();
          }
        } catch { if (window.toast) window.toast('批量已读失败'); }
      },
    },
  };

  // ── 6. FavoritesView (收藏中心，支持世界/好友/模型/群组 4 大分类 + 分组筛选与即时搜索) ──
  const FavoritesView = {
    template: `<div class="fav-view">
      <div class="toolbar-sub">
        <div class="filters">
          <button class="filter" :class="{ active: tab === 'worlds' }" @click="switchTab('worlds')">收藏世界 ({{ worlds.length }})</button>
          <button class="filter" :class="{ active: tab === 'friends' }" @click="switchTab('friends')">☆ 收藏好友 ({{ friends.length }})</button>
          <button class="filter" :class="{ active: tab === 'avatars' }" @click="switchTab('avatars')">收藏模型 ({{ avatars.length }})</button>
          <button class="filter" :class="{ active: tab === 'groups' }" @click="switchTab('groups')">收藏群组 ({{ groups.length }})</button>
        </div>
        <div class="flex items-center gap-2">
          <select v-if="tab === 'worlds' && worldGroups.length > 0" v-model="curGroup" class="side-search" style="max-width: 170px; margin: 0">
            <option value="all">全部分组 ({{ worlds.length }})</option>
            <option v-for="grp in worldGroups" :key="grp" :value="grp">{{ groupDisplayName(grp) }} ({{ groupCount(grp) }})</option>
          </select>
          <input class="feed-search" v-model="q" placeholder="搜索收藏…" aria-label="搜索收藏">
        </div>
      </div>

      <div class="tablewrap">
        <div v-if="loading" class="empty">正在加载收藏列表…</div>

        <!-- 1. 收藏世界 -->
        <div v-else-if="tab === 'worlds'">
          <div v-if="filteredWorlds.length" class="fav-grid">
            <div v-for="w in filteredWorlds" :key="w.worldId || w.id" class="fav-card" @click="openWorld(w.worldId || w.id)">
              <img class="fav-cover" :src="w.imageUrl || w.thumbnailImageUrl" @error="handleError" alt="" loading="lazy">
              <div class="fc-body">
                <b>{{ w.worldName || w.name || w.worldId }}</b>
                <small>{{ w.authorName ? '作者: ' + w.authorName : '' }} · {{ w.capacity ? w.capacity + '人' : '' }}</small>
                <small v-if="w.favoriteGroup" class="grp-chip" style="margin-top: 4px; display: inline-block">{{ groupDisplayName(w.favoriteGroup) }}</small>
              </div>
            </div>
          </div>
          <div v-else class="empty">{{ q.trim() || curGroup !== 'all' ? '无匹配收藏世界' : '暂无收藏世界' }}</div>
        </div>

        <!-- 2. 收藏好友 -->
        <div v-else-if="tab === 'friends'">
          <div v-if="filteredFriends.length" class="fav-friends-list">
            <div v-for="f in filteredFriends" :key="f.userId" class="fl-row" @click="openUser(f.userId)">
              <span class="fl-name">
                <img class="avatar-sm" :src="avatarUrl(f)" @error="handleError" alt="" loading="lazy">
                <b :style="{ color: trustColor(f.trustLevel) }">{{ f.displayName }}</b>
              </span>
              <span class="fl-status">{{ f.isOnline ? (f.statusDescription || '在线') : '离线' }}</span>
              <span class="fl-loc">{{ f.worldName || '—' }}</span>
            </div>
          </div>
          <div v-else class="empty">暂无收藏好友</div>
        </div>

        <!-- 3. 收藏模型 -->
        <div v-else-if="tab === 'avatars'">
          <div v-if="filteredAvatars.length" class="fav-grid">
            <div v-for="a in filteredAvatars" :key="a.id || a.avatarId" class="fav-card" @click="openAvatar(a.id || a.avatarId)">
              <img class="fav-cover" :src="a.imageUrl" @error="handleError" alt="" loading="lazy">
              <div class="fc-body">
                <b>{{ a.name || a.avatarName || a.id }}</b>
                <small>{{ a.authorName ? '作者: ' + a.authorName : '' }}</small>
              </div>
            </div>
          </div>
          <div v-else class="empty">暂无收藏模型</div>
        </div>

        <!-- 4. 收藏群组 -->
        <div v-else-if="tab === 'groups'">
          <div v-if="filteredGroups.length" class="fav-grid">
            <div v-for="g in filteredGroups" :key="g.id || g.groupId" class="fav-card" @click="openGroup(g.id || g.groupId)">
              <img class="fav-cover" :src="g.bannerUrl || g.iconUrl" @error="handleError" alt="" loading="lazy">
              <div class="fc-body">
                <b>{{ g.name || g.groupId }}</b>
                <small>{{ g.memberCount ? g.memberCount + ' 成员' : '' }} {{ g.shortCode ? ' · #' + g.shortCode : '' }}</small>
              </div>
            </div>
          </div>
          <div v-else class="empty">暂无收藏群组</div>
        </div>
      </div>
    </div>`,
    data() {
      return {
        store: window.__store,
        tab: 'worlds',
        curGroup: 'all',
        q: '',
        loading: false,
        worlds: [],
        friends: [],
        avatars: [],
        groups: [],
      };
    },
    computed: {
      worldGroups() {
        const s = new Set();
        for (const w of this.worlds) {
          if (w.favoriteGroup) s.add(w.favoriteGroup);
        }
        return Array.from(s);
      },
      filteredWorlds() {
        let list = this.worlds;
        if (this.curGroup !== 'all') list = list.filter((w) => w.favoriteGroup === this.curGroup);
        const query = this.q.trim().toLowerCase();
        if (!query) return list;
        return list.filter((w) =>
          (w.worldName || w.name || '').toLowerCase().includes(query) ||
          (w.authorName || '').toLowerCase().includes(query) ||
          (w.worldId || '').includes(query)
        );
      },
      filteredFriends() {
        const query = this.q.trim().toLowerCase();
        if (!query) return this.friends;
        return this.friends.filter((f) =>
          (f.displayName || '').toLowerCase().includes(query) || (f.userId || '').includes(query)
        );
      },
      filteredAvatars() {
        const query = this.q.trim().toLowerCase();
        if (!query) return this.avatars;
        return this.avatars.filter((a) =>
          (a.name || a.avatarName || '').toLowerCase().includes(query) || (a.id || a.avatarId || '').includes(query)
        );
      },
      filteredGroups() {
        const query = this.q.trim().toLowerCase();
        if (!query) return this.groups;
        return this.groups.filter((g) =>
          (g.name || '').toLowerCase().includes(query) || (g.id || g.groupId || '').includes(query)
        );
      },
    },
    watch: {
      tab: {
        immediate: true,
        handler() { this.load(); },
      },
    },
    methods: {
      switchTab(t) {
        this.tab = t;
        this.q = '';
        this.curGroup = 'all';
      },
      groupCount(grp) {
        return this.worlds.filter((w) => w.favoriteGroup === grp).length;
      },
      groupDisplayName(grp) {
        if (!grp) return '未分组';
        const m = grp.match(/worlds?(\d+)/i);
        if (m) return `世界分组 ${m[1]}`;
        const f = grp.match(/friends?(\d+)/i);
        if (f) return `好友分组 ${f[1]}`;
        return grp;
      },
      avatarUrl(item) { return typeof window.avatarUrlFor === 'function' ? window.avatarUrlFor(item, this.store.friends) : (item.avatarUrl || item.userIcon || ''); },
      handleError: (e) => (typeof window.handleImgError === 'function' ? window.handleImgError(e) : null),
      trustColor: (t) => (typeof window.trustColor === 'function' ? window.trustColor(t) : '#8a94a0'),
      openWorld(wid) { if (window.openWorld) window.openWorld(wid); },
      openUser(uid) { if (window.openUser) window.openUser(uid); },
      openAvatar(aid) { if (window.openAvatar) window.openAvatar(aid); },
      openGroup(gid) { if (window.openGroup) window.openGroup(gid); },
      async load() {
        const t = this.tab;
        if (t === 'worlds') {
          if (this.worlds.length) return;
          this.loading = true;
          try {
            const w = await window.__get('/api/dashboard/favorites?type=worlds');
            this.worlds = (w && (w.worlds || w.favorites)) || [];
          } catch { this.worlds = []; }
          finally { this.loading = false; }
        } else if (t === 'friends') {
          if (this.friends.length) return;
          this.loading = true;
          try {
            const f = await window.__get('/api/dashboard/favorites?type=friends');
            const storeFriends = (window.__store && window.__store.friends) || [];
            this.friends = (f && (f.favorites || f.friends || [])).map((x) => storeFriends.find((fr) => fr.userId === x.userId) || x);
          } catch { this.friends = []; }
          finally { this.loading = false; }
        } else if (t === 'avatars') {
          if (this.avatars.length) return;
          this.loading = true;
          try {
            const a = await window.__get('/api/dashboard/favorites?type=avatars');
            this.avatars = (a && (a.avatars || a.favorites)) || [];
          } catch { this.avatars = []; }
          finally { this.loading = false; }
        } else if (t === 'groups') {
          if (this.groups.length) return;
          this.loading = true;
          try {
            const g = await window.__get('/api/dashboard/favorites?type=groups');
            this.groups = (g && (g.groups || g.favorites)) || [];
          } catch { this.groups = []; }
          finally { this.loading = false; }
        }
      },
    },
  };

  // ── 7. AvatarsView (我的模型与收藏模型) ──
  const AvatarsView = {
    template: `<div class="avatars-view">
      <div class="toolbar-sub">
        <div class="filters">
          <button class="filter" :class="{ active: tab === 'my' }" @click="tab = 'my'">我的模型 ({{ myAvatars.length }})</button>
          <button class="filter" :class="{ active: tab === 'fav' }" @click="tab = 'fav'">收藏模型 ({{ favAvatars.length }})</button>
        </div>
        <input class="feed-search" v-model="q" placeholder="搜索模型…" aria-label="搜索模型">
      </div>
      <div class="tablewrap">
        <div class="fav-grid">
          <div v-for="a in filteredList" :key="a.id || a.avatarId" class="fav-card" @click="openAvatar(a.id || a.avatarId)">
            <img class="fav-cover" :src="a.imageUrl" @error="handleError" alt="" loading="lazy">
            <div class="fc-body">
              <b>{{ a.name || a.avatarName || a.id }}</b>
              <small>{{ a.authorName ? '作者: ' + a.authorName : '' }} · {{ a.releaseStatus === 'public' ? '公开' : '私有' }}</small>
            </div>
          </div>
        </div>
        <div v-if="!filteredList.length" class="empty">暂无模型数据</div>
      </div>
    </div>`,
    data() {
      return {
        store: window.__store,
        tab: 'my',
        q: '',
        myAvatars: [],
        favAvatars: [],
      };
    },
    computed: {
      filteredList() {
        const list = this.tab === 'my' ? this.myAvatars : this.favAvatars;
        const query = this.q.trim().toLowerCase();
        if (!query) return list;
        return list.filter((a) => (a.name || '').toLowerCase().includes(query) || (a.id || '').includes(query));
      },
    },
    mounted() { this.load(); },
    methods: {
      handleError: (e) => (typeof window.handleImgError === 'function' ? window.handleImgError(e) : null),
      openAvatar(aid) { if (window.openAvatar) window.openAvatar(aid); },
      async load() {
        try {
          const d = await window.__get('/api/dashboard/avatars');
          this.myAvatars = d.avatars || [];
          this.favAvatars = d.favoriteAvatars || [];
        } catch { this.myAvatars = []; this.favAvatars = []; }
      },
    },
  };

  // ── 8. ModerationView (黑名单与屏蔽管理) ──
  const ModerationView = {
    template: `<div class="mod-view">
      <div class="toolbar-sub">
        <div class="filters">
          <button class="filter" :class="{ active: tab === 'blocked' }" @click="tab = 'blocked'">黑名单 ({{ blocked.length }})</button>
          <button class="filter" :class="{ active: tab === 'muted' }" @click="tab = 'muted'">静音列表 ({{ muted.length }})</button>
        </div>
      </div>
      <div class="tablewrap">
        <div class="fl-grid">
          <div v-for="m in list" :key="m.id || m.targetUserId" class="friend-card">
            <div class="fc-info">
              <b>{{ m.targetDisplayName || m.targetUserId }}</b>
              <small class="fc-sub">{{ m.type }} · {{ fmtDate(m.created) }}</small>
            </div>
            <button class="btn-xs" @click="unblock(m)">解除</button>
          </div>
        </div>
        <div v-if="!list.length" class="empty">无屏蔽玩家记录</div>
      </div>
    </div>`,
    data() {
      return {
        store: window.__store,
        tab: 'blocked',
        blocked: [],
        muted: [],
      };
    },
    computed: {
      list() { return this.tab === 'blocked' ? this.blocked : this.muted; },
    },
    mounted() { this.load(); },
    methods: {
      fmtDate: (s) => (s ? new Date(s).toLocaleDateString('zh-CN') : '—'),
      async load() {
        try {
          const d = await window.__get('/api/dashboard/moderation');
          this.blocked = d.blocked || [];
          this.muted = d.muted || [];
        } catch { this.blocked = []; this.muted = []; }
      },
      async unblock(m) {
        try {
          const d = await window.__post('/api/dashboard/moderation/delete', { moderationId: m.id });
          if (d.ok) {
            if (window.toast) window.toast('已解除');
            this.load();
          }
        } catch {}
      },
    },
  };

  // ── 9. ChartsView (统计图表，参考 VRCX Charts.vue) ──
  const ChartsView = {
    template: `<div class="charts-view">
      <div class="toolbar-sub">
        <div class="filters">
          <button v-for="d in [7, 14, 30]" :key="d" class="filter" :class="{ active: days === d }" @click="setDays(d)">近 {{ d }} 天</button>
        </div>
      </div>
      <div class="tablewrap">
        <div class="stats-cards">
          <div class="stat-box"><span class="sb-label">当前在线好友</span><b class="sb-val">{{ stats.onlineNow || 0 }}</b></div>
          <div class="stat-box"><span class="sb-label">总动态事件数</span><b class="sb-val">{{ stats.totalEvents || 0 }}</b></div>
          <div class="stat-box"><span class="sb-label">游玩总时长</span><b class="sb-val">{{ fmtHour(gameStats.totalMinutes) }}</b></div>
        </div>

        <div class="chart-section mt-4">
          <h3 class="section-title">活跃时段分布 (小时)</h3>
          <div class="bar-chart">
            <div v-for="h in (stats.byHour || [])" :key="h.label" class="bar-col">
              <div class="bar-fill" :style="{ height: Math.min(100, h.value * 12) + '%' }" :title="h.label + ': ' + h.value + ' 次'"></div>
              <span class="bar-lbl">{{ h.label.slice(0, 2) }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>`,
    data() {
      return {
        store: window.__store,
        days: 7,
        stats: {},
        gameStats: {},
      };
    },
    mounted() { this.load(); },
    methods: {
      setDays(d) { this.days = d; this.load(); },
      fmtHour(m) { return m ? (m / 60).toFixed(1) + ' 小时' : '0 小时'; },
      async load() {
        try {
          const [s, g] = await Promise.all([
            window.__get(`/api/dashboard/stats?days=${this.days}`),
            window.__get(`/api/dashboard/game-sessions?days=${this.days}`),
          ]);
          this.stats = s || {};
          this.gameStats = g || {};
        } catch {}
      },
    },
  };

  // ── 10. WorldsView (世界探索与历史足迹) ──
  const WorldsView = {
    template: `<div class="worlds-view">
      <div class="toolbar-sub">
        <div class="filters">
          <button class="filter active">最近访问的世界 ({{ worlds.length }})</button>
        </div>
        <input class="feed-search" v-model="q" placeholder="搜索世界名称…" aria-label="搜索世界">
      </div>
      <div class="tablewrap">
        <div class="fav-grid">
          <div v-for="w in filtered" :key="w.worldId" class="fav-card" @click="openWorld(w.worldId)">
            <img class="fav-cover" :src="w.imageUrl" @error="handleError" alt="" loading="lazy">
            <div class="fc-body">
              <b>{{ w.worldName || w.worldId }}</b>
              <small>最后到访: {{ fmtTime(w.lastSeen) }} · {{ w.visits || 1 }} 次</small>
            </div>
          </div>
        </div>
        <div v-if="!filtered.length" class="empty">暂无足迹记录</div>
      </div>
    </div>`,
    data() {
      return {
        store: window.__store,
        q: '',
        worlds: [],
      };
    },
    computed: {
      filtered() {
        const query = this.q.trim().toLowerCase();
        if (!query) return this.worlds;
        return this.worlds.filter((w) => (w.worldName || '').toLowerCase().includes(query));
      },
    },
    mounted() { this.load(); },
    methods: {
      handleError: (e) => (typeof window.handleImgError === 'function' ? window.handleImgError(e) : null),
      openWorld(wid) { if (window.openWorld) window.openWorld(wid); },
      fmtTime: (s) => (s ? new Date(s).toLocaleDateString('zh-CN') : '近期'),
      async load() {
        try {
          const d = await window.__get('/api/dashboard/recent-worlds?limit=30');
          this.worlds = d.worlds || [];
        } catch { this.worlds = []; }
      },
    },
  };

  // ── 11. ToolsView (小工具箱) ──
  const ToolsView = {
    template: `<div class="tools-view">
      <div class="tablewrap">
        <div class="tools-grid">
          <div class="tool-card">
            <h3>快捷搜索</h3>
            <p>使用 Ctrl+K 或 Cmd+K 唤出全局浮动搜索框，快速查找玩家、世界、模型与群组。</p>
            <button class="btn-primary-sm" @click="openQuickSearch">打开搜索 (Ctrl+K)</button>
          </div>
          <div class="tool-card">
            <h3>数据刷新</h3>
            <p>手动向路由器后端请求全量好友状态同步与最新动态事件。</p>
            <button class="btn-secondary-sm" @click="refreshAll">立即全量同步</button>
          </div>
        </div>
      </div>
    </div>`,
    data() {
      return { store: window.__store };
    },
    methods: {
      openQuickSearch() { this.store.quickSearchOpen = true; },
      async refreshAll() {
        if (window.toast) window.toast('正在同步…');
        try {
          const f = await window.__get('/api/dashboard/friends');
          if (f && f.friends) this.store.friends = f.friends;
          if (window.toast) window.toast('同步完成');
        } catch { if (window.toast) window.toast('同步失败'); }
      },
    },
  };

  // ── 12. SearchView (全局搜索) ──
  const SearchView = {
    template: `<div class="search-view">
      <div class="toolbar-sub">
        <input class="feed-search" v-model="q" placeholder="搜索 VRChat 用户 / 世界 / 模型 / 群组…" @keydown.enter="run" aria-label="全局搜索">
        <button class="btn-primary-sm" @click="run">搜索</button>
      </div>
      <div class="tablewrap">
        <div v-if="loading" class="empty">正在搜索中…</div>
        <div v-else-if="results.length" class="fav-grid">
          <div v-for="r in results" :key="r.id" class="fav-card" @click="selectItem(r)">
            <img v-if="r.imageUrl || r.currentAvatarThumbnailImageUrl || r.userIcon" class="fav-cover" :src="r.imageUrl || r.currentAvatarThumbnailImageUrl || r.userIcon" @error="handleError" alt="" loading="lazy">
            <div class="fc-body">
              <b>{{ r.displayName || r.name || r.id }}</b>
              <small>{{ r.authorName || r.type || '' }}</small>
            </div>
          </div>
        </div>
        <div v-else class="empty">{{ q ? '无匹配搜索结果' : '输入关键词并按回车搜索' }}</div>
      </div>
    </div>`,
    data() {
      return {
        store: window.__store,
        q: '',
        loading: false,
        results: [],
      };
    },
    methods: {
      handleError: (e) => (typeof window.handleImgError === 'function' ? window.handleImgError(e) : null),
      async run() {
        const text = this.q.trim();
        if (!text) return;
        this.loading = true;
        try {
          const d = await window.__get(`/api/dashboard/search?q=${encodeURIComponent(text)}&type=all`);
          this.results = d.results || d.users || d.worlds || [];
        } catch { this.results = []; }
        finally { this.loading = false; }
      },
      selectItem(r) {
        if (r.id && r.id.startsWith('usr_') && window.openUser) window.openUser(r.id);
        else if (r.id && r.id.startsWith('wrld_') && window.openWorld) window.openWorld(r.id);
        else if (r.id && r.id.startsWith('avtr_') && window.openAvatar) window.openAvatar(r.id);
        else if (r.id && r.id.startsWith('grp_') && window.openGroup) window.openGroup(r.id);
      },
    },
  };

  // ── 13. OpenView (快速打开 ID) ──
  const OpenView = {
    template: `<div class="open-view">
      <div class="tablewrap">
        <div class="open-box">
          <h2>打开 VRChat ID 链接</h2>
          <p class="dim">支持 usr_xxx、wrld_xxx、avtr_xxx、grp_xxx 格式或 vrchat.com 网页链接</p>
          <input v-model="targetId" placeholder="粘贴 ID 或链接…" @keydown.enter="open">
          <button class="btn-primary" @click="open">直接打开</button>
        </div>
      </div>
    </div>`,
    data() {
      return {
        store: window.__store,
        targetId: '',
      };
    },
    methods: {
      open() {
        let t = this.targetId.trim();
        if (!t) return;
        const m = t.match(/(usr|wrld|avtr|grp)_[a-f0-9-]+/i);
        if (m) t = m[0];
        if (t.startsWith('usr_') && window.openUser) window.openUser(t);
        else if (t.startsWith('wrld_') && window.openWorld) window.openWorld(t);
        else if (t.startsWith('avtr_') && window.openAvatar) window.openAvatar(t);
        else if (t.startsWith('grp_') && window.openGroup) window.openGroup(t);
        else if (window.toast) window.toast('未能识别有效的 VRChat ID');
      },
    },
  };

  window.__views = {
    FeedView,
    FriendsView,
    LogsView,
    PlayersView,
    NotificationsView,
    FavoritesView,
    AvatarsView,
    ModerationView,
    ChartsView,
    WorldsView,
    ToolsView,
    SearchView,
    OpenView,
  };
})();
