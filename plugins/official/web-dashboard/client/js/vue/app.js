// Vue 根应用：挂载整个 VRCX 界面 (Layout + Left Navigation + Main Viewport + RightBar + Modals)
(function () {
  if (typeof Vue === 'undefined') return;
  const { createApp } = Vue;

  const RootApp = {
    components: {
      ...(window.__views || {}),
      ...(window.__dialogs || {}),
      RightBar: window.__RightBar,
    },
    template: `<div id="app">
      <!-- 顶部全局标题栏 -->
      <header class="app-header">
        <div class="brand">
          <span>VRChat Assistant</span>
        </div>

        <div class="header-center">
          <div class="search-pill" @click="store.quickSearchOpen = true">
            <span>⌕ 快速搜索玩家 / 世界 / 模型…</span>
            <kbd>Ctrl+K</kbd>
          </div>
        </div>

        <div class="header-right">
          <div class="sse-badge" :title="'SSE 实时连接状态: ' + store.sseStatus">
            <span class="sse-dot" :class="sseDotClass"></span>
            <span>{{ sseStatusText }}</span>
          </div>
          <button class="btn-secondary-sm" @click="refresh">↻ 刷新</button>
        </div>
      </header>

      <!-- 主工作区 -->
      <div class="app-body">
        <!-- 左侧图标导航栏 -->
        <nav class="nav-rail">
          <button v-for="item in navItems" :key="item.view" class="nav-btn" :class="{ active: store.view === item.view }" @click="navigate(item.view)" :title="item.label">
            <span>{{ item.label }}</span>
            <span v-if="item.view === 'notifications' && unreadNotifs > 0" class="nav-badge">{{ unreadNotifs }}</span>
          </button>
        </nav>

        <!-- 中央主视口 (严格弹性滚动约束) -->
        <main class="main-viewport">
          <FeedView v-if="store.view === 'feed'" />
          <FriendsView v-else-if="store.view === 'friends'" />
          <LogsView v-else-if="store.view === 'logs'" />
          <PlayersView v-else-if="store.view === 'players'" />
          <NotificationsView v-else-if="store.view === 'notifications'" />
          <FavoritesView v-else-if="store.view === 'favorites'" />
          <AvatarsView v-else-if="store.view === 'avatars'" />
          <ModerationView v-else-if="store.view === 'moderation'" />
          <ChartsView v-else-if="store.view === 'charts'" />
          <WorldsView v-else-if="store.view === 'worlds'" />
          <ToolsView v-else-if="store.view === 'tools'" />
          <SearchView v-else-if="store.view === 'search'" />
          <OpenView v-else-if="store.view === 'open'" />
        </main>

        <!-- 右侧好友边栏 -->
        <aside class="rightbar">
          <RightBar />
        </aside>
      </div>

      <!-- 底部状态栏 -->
      <footer class="app-footer">
        <span>AUTH {{store.authStatus}}</span>
        <span>WS {{store.wsStatus}}</span>
        <span>SSE {{store.sseStatus==='connected'?'CONN':(store.sseStatus==='live'?'LIVE':'重连')}}</span>
        <span>DB {{store.dbStatus}}</span>
        <span>VRC {{store.vrcStatus||'—'}}</span>
        <span style="margin-left:auto">24H REMOTE SERVICE</span>
      </footer>

      <!-- 全局弹窗与灯箱 -->
      <UserDialog />
      <WorldDialog />
      <AvatarDialog />
      <GroupDialog />
      <QuickSearchDialog />
      <FullscreenImagePreview />
      <ToastNotification />
    </div>`,
    data() {
      return {
        store: window.__store,
        unreadNotifs: 0,
        navItems: [
          { view: 'feed', ico: '◉', label: '动态' },
          { view: 'friends', ico: '👥', label: '好友' },
          { view: 'favorites', ico: '★', label: '收藏' },
          { view: 'logs', ico: '📜', label: '日志' },
          { view: 'players', ico: '👤', label: '玩家' },
          { view: 'notifications', ico: '✉', label: '通知' },
          { view: 'avatars', ico: '🧍', label: '模型' },
          { view: 'worlds', ico: '🌍', label: '足迹' },
          { view: 'charts', ico: '📊', label: '图表' },
          { view: 'moderation', ico: '🚫', label: '屏蔽' },
          { view: 'tools', ico: '⚙', label: '工具' },
        ],
      };
    },
    mounted() {
      // 监听快捷键 Ctrl+K / Cmd+K 打开快速搜索
      window.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
          e.preventDefault();
          this.store.quickSearchOpen = !this.store.quickSearchOpen;
        }
      });
    },
    methods: {
      navigate(view) {
        this.store.view = view;
      },
      refresh() {
        if (window.__load) window.__load();
        if (window.toast) window.toast('正在同步最新数据…');
      },
    },
  };

  const mountEl = document.querySelector('#app');
  if (mountEl) {
    createApp(RootApp).mount(mountEl);
  }
})();
