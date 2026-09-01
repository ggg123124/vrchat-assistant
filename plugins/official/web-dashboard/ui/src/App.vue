<script setup>
import { computed, ref, onMounted, onUnmounted } from 'vue';
import { useToast } from 'primevue/usetoast';
import { store, setView, load, enableNotifications, disableNotifications } from './store.js';
import { bindToast, toast } from './toast.js';
import FeedView from './views/FeedView.vue';
import FriendsView from './views/FriendsView.vue';
import FavoritesView from './views/FavoritesView.vue';
import LogsView from './views/LogsView.vue';
import NotificationsView from './views/NotificationsView.vue';
import SearchView from './views/SearchView.vue';
import WorldsView from './views/WorldsView.vue';
import TrackedView from './views/TrackedView.vue';
import PlayersView from './views/PlayersView.vue';
import AvatarsView from './views/AvatarsView.vue';
import ChartsView from './views/ChartsView.vue';
import PrintsView from './views/PrintsView.vue';
import BoothView from './views/BoothView.vue';
import AnnouncementsView from './views/AnnouncementsView.vue';
import ModerationView from './views/ModerationView.vue';
import ToolsView from './views/ToolsView.vue';
import OpenView from './views/OpenView.vue';
import WeeklyReportView from './views/WeeklyReportView.vue';
import XWorldsView from './views/XWorldsView.vue';
import RecommendView from './views/RecommendView.vue';
import GroupsView from './views/GroupsView.vue';
import EventsView from './views/EventsView.vue';
import PlaceholderView from './views/PlaceholderView.vue';
import RightBar from './components/RightBar.vue';
import QuickSearch from './components/QuickSearch.vue';
import UserDialog from './components/UserDialog.vue';
import WorldDialog from './components/WorldDialog.vue';
import GroupDialog from './components/GroupDialog.vue';
import InstanceDialog from './components/InstanceDialog.vue';
import AvatarDialog from './components/AvatarDialog.vue';
import LoginView from './components/LoginView.vue';
import { hasToken, clearToken } from './api.js';
import { useConfirm } from 'primevue/useconfirm';
import { bindConfirm } from './confirm.js';

const toastInstance = useToast();
bindToast(toastInstance);
const confirmInstance = useConfirm();
bindConfirm(confirmInstance);

const NAV_GROUPS = [
  { g: '核心', items: [
    { view: 'feed', ico: 'pi pi-bolt', label: '动态' },
    { view: 'friends', ico: 'pi pi-users', label: '好友' },
    { view: 'tracked', ico: 'pi pi-eye', label: '非好友追踪' },
    { view: 'players', ico: 'pi pi-id-card', label: '玩家' },
    { view: 'notifications', ico: 'pi pi-bell', label: '通知' },
    { view: 'search', ico: 'pi pi-search', label: '搜索' },
  ]},
  { g: '内容', items: [
    { view: 'favorites', ico: 'pi pi-star', label: '收藏' },
    { view: 'worlds', ico: 'pi pi-globe', label: '足迹' },
    { view: 'avatars', ico: 'pi pi-user-edit', label: '模型' },
    { view: 'prints', ico: 'pi pi-images', label: '相册' },
    { view: 'booth', ico: 'pi pi-shopping-bag', label: '素材' },
    { view: 'groups', ico: 'pi pi-users', label: '群组' },
    { view: 'announcements', ico: 'pi pi-megaphone', label: '公告' },
  ]},
  { g: '发现', items: [
    { view: 'recommend', ico: 'pi pi-compass', label: '推荐' },
    { view: 'xworlds', ico: 'pi pi-twitter', label: 'X推荐' },
    { view: 'events', ico: 'pi pi-calendar', label: '活动' },
    { view: 'logs', ico: 'pi pi-history', label: '日志' },
  ]},
  { g: '数据', items: [
    { view: 'charts', ico: 'pi pi-chart-bar', label: '图表' },
    { view: 'report', ico: 'pi pi-calendar-clock', label: '周报' },
  ]},
  { g: '管理', items: [
    { view: 'moderation', ico: 'pi pi-ban', label: '屏蔽' },
    { view: 'tools', ico: 'pi pi-wrench', label: '工具' },
    { view: 'open', ico: 'pi pi-external-link', label: '直接打开' },
  ]},
];
const navItems = NAV_GROUPS.flatMap((gr) => gr.items);

// 回到顶部：主滚动容器是 .main-viewport，用 document 捕获阶段监听任意容器滚动
const showTop = ref(false);
function onAnyScroll() {
  const el = document.querySelector('.main-viewport');
  showTop.value = !!(el && el.scrollTop > 400);
}
function scrollTopSmooth() {
  const el = document.querySelector('.main-viewport');
  if (el) el.scrollTo({ top: 0, behavior: 'smooth' });
}
onMounted(() => document.addEventListener('scroll', onAnyScroll, true));

// ── 登录页控制 ──
const loginView = ref(!hasToken());
function onAuth401() { loginView.value = true; }
onMounted(() => window.addEventListener('vrc-auth-401', onAuth401));
onUnmounted(() => window.removeEventListener('vrc-auth-401', onAuth401));
function doLogout() { clearToken(); location.reload(); }
onUnmounted(() => document.removeEventListener('scroll', onAnyScroll, true));

const mobileTabs = [
  { view: 'feed', ico: 'pi pi-bolt', label: '动态' },
  { view: 'friends', ico: 'pi pi-users', label: '好友' },
  { view: 'notifications', ico: 'pi pi-bell', label: '通知' },
  { view: 'favorites', ico: 'pi pi-star', label: '收藏' },
];

const sseText = computed(() => store.sseStatus === 'connected' ? 'connected' : 'reconnecting');
const authDot = computed(() => store.authStatus === 'OK' ? 'ok' : 'warn');
const wsDot = computed(() => String(store.wsStatus).toLowerCase().includes('connect') ? 'ok' : 'warn');
const sseDot = computed(() => store.sseStatus === 'connected' ? 'ok' : 'warn');
// 运行时长（服务启动至今，页脚显示）
const uptimeText = computed(() => {
  const s = Number(store.uptime) || 0;
  if (s < 60) return s + ' 秒';
  const m = Math.floor(s / 60);
  if (m < 60) return m + ' 分钟';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' 小时 ' + (m % 60) + ' 分';
  const d = Math.floor(h / 24);
  return d + ' 天 ' + (h % 24) + ' 小时';
});

// 通知提醒开关
async function onToggleNotify() {
  if (store.notifyEnabled) {
    disableNotifications();
    toast('通知提醒已关闭');
  } else {
    const msg = await enableNotifications();
    if (msg) toast(msg, msg.includes('失败') || msg.includes('拒绝') ? 'error' : 'success');
  }
}

// 刷新按钮 loading 态：请求期间转圈 + 禁点，结束自动恢复
const refreshing = ref(false);
async function refresh() {
  if (refreshing.value) return;
  refreshing.value = true;
  try { await load(); } finally { refreshing.value = false; }
}
</script>

<template>
  <LoginView v-if="loginView" />
  <div v-else class="app-shell">
    <header class="app-header">
      <Button v-if="store.isMobile" icon="pi pi-bars" text rounded @click="store.navOpen = true" aria-label="打开菜单" />
      <span class="brand">VRChat Assistant</span>
      <div class="header-right">
        <Button v-if="store.isMobile" icon="pi pi-users" text rounded aria-label="好友列表" title="好友列表"
          @click="store.friendsOpen = true" />
        <Button :icon="store.notifyEnabled ? 'pi pi-bell' : 'pi pi-bell-slash'" text rounded
          :aria-label="store.notifyEnabled ? '关闭通知提醒' : '开启通知提醒'" :title="store.notifyEnabled ? '通知提醒已开启' : '开启通知提醒（好友请求/邀请时桌面弹窗）'"
          :class="{ 'notify-on': store.notifyEnabled }" @click="onToggleNotify">
          <span v-if="store.notifCount" class="header-bell-dot" :title="store.notifCount + ' 条未读通知'">{{ store.notifCount > 99 ? '99+' : store.notifCount }}</span>
        </Button>
        <Button icon="pi pi-search" text rounded aria-label="快速搜索" title="快速搜索（Ctrl+K）"
          @click="store.quickSearchOpen = true" />
        <Button icon="pi pi-refresh" text rounded aria-label="刷新" title="刷新"
          :loading="refreshing" @click="refresh" />
        <Button icon="pi pi-sign-out" text rounded aria-label="登出" title="登出（清除令牌）" @click="doLogout" />
      </div>
    </header>

    <div class="app-body">
      <nav class="nav-rail">
        <template v-for="gr in NAV_GROUPS" :key="'r-' + gr.g">
          <div class="rail-group">{{ gr.g }}</div>
          <button v-for="item in gr.items" :key="item.view" class="nav-item" :class="{ active: store.view === item.view }" @click="setView(item.view)">
            <span class="ni-ico"><i :class="item.ico"></i></span>
            <span>{{ item.label }}<span v-if="item.view === 'notifications' && store.notifCount" class="nav-badge">{{ store.notifCount > 99 ? '99+' : store.notifCount }}</span><span v-else-if="item.view === 'announcements' && store.annHasNew" class="nav-badge">新</span></span>
          </button>
        </template>
      </nav>

      <main class="main-viewport">
        <Transition name="view-fade" mode="out-in">
          <FeedView v-if="store.view === 'feed'" key="feed" />
          <FriendsView v-else-if="store.view === 'friends'" key="friends" />
          <FavoritesView v-else-if="store.view === 'favorites'" key="favorites" />
          <LogsView v-else-if="store.view === 'logs'" key="logs" />
          <NotificationsView v-else-if="store.view === 'notifications'" key="notifications" />
          <SearchView v-else-if="store.view === 'search'" key="search" />
          <WorldsView v-else-if="store.view === 'worlds'" key="worlds" />
          <XWorldsView v-else-if="store.view === 'xworlds'" key="xworlds" />
          <RecommendView v-else-if="store.view === 'recommend'" key="recommend" />
          <GroupsView v-else-if="store.view === 'groups'" key="groups" />
          <EventsView v-else-if="store.view === 'events'" key="events" />
          <TrackedView v-else-if="store.view === 'tracked'" key="tracked" />
          <PlayersView v-else-if="store.view === 'players'" key="players" />
          <AvatarsView v-else-if="store.view === 'avatars'" key="avatars" />
          <PrintsView v-else-if="store.view === 'prints'" key="prints" />
          <BoothView v-else-if="store.view === 'booth'" key="booth" />
          <AnnouncementsView v-else-if="store.view === 'announcements'" key="announcements" />
          <ChartsView v-else-if="store.view === 'charts'" key="charts" />
          <WeeklyReportView v-else-if="store.view === 'report'" key="report" />
          <ModerationView v-else-if="store.view === 'moderation'" key="moderation" />
          <ToolsView v-else-if="store.view === 'tools'" key="tools" />
          <OpenView v-else-if="store.view === 'open'" key="open" />
          <PlaceholderView v-else :view="store.view" key="placeholder" />
        </Transition>
      </main>

      <aside v-if="!store.isMobile" class="rightbar">
        <RightBar />
      </aside>
    </div>

    <button v-if="showTop" class="to-top" :title="'回到顶部'" aria-label="回到顶部" @click="scrollTopSmooth"><i class="pi pi-arrow-up"></i></button>

    <footer class="app-footer">
      <span class="footer-item"><i class="f-dot" :class="authDot"></i>AUTH <b>{{ store.authStatus }}</b></span>
      <span class="footer-item"><i class="f-dot" :class="wsDot"></i>WS <b>{{ store.wsStatus }}</b></span>
      <span class="footer-item"><i class="f-dot" :class="sseDot"></i>SSE <b>{{ sseText }}</b></span>
      <span class="footer-item"><i class="f-dot ok"></i>DB <b>{{ store.dbStatus }}</b></span>
      <span class="footer-item" title="服务运行时长"><i class="pi pi-clock f-dot-ico"></i>运行 <b>{{ uptimeText }}</b></span>
      <span v-if="store.safeMode" class="footer-item safe-badge" title="安全模式已启用：破坏性操作（删除/移除/退出等）被拦截"><i class="pi pi-lock"></i>安全模式</span>
      <span class="footer-brand" style="margin-left:auto">24H REMOTE SERVICE</span>
    </footer>

    <!-- 移动端底部导航 -->
    <div v-if="store.isMobile" class="mobile-tabbar">
      <button v-for="m in mobileTabs" :key="m.view" class="mtab" :class="{ active: store.view === m.view }" @click="setView(m.view)">
        <i :class="m.ico"></i>
        <span>{{ m.label }}</span>
      </button>
      <!-- 当前视图不属于前四个 tab 时，"更多"保持高亮（用户知道自己身在何处） -->
      <button class="mtab" :class="{ active: store.navOpen || !mobileTabs.some((m) => m.view === store.view) }" @click="store.navOpen = true">
        <i class="pi pi-th-large"></i>
        <span>更多</span>
      </button>
    </div>

    <!-- 移动端导航抽屉 -->
    <Drawer v-model:visible="store.navOpen" position="left" header="导航">
      <div class="drawer-nav">
        <template v-for="gr in NAV_GROUPS" :key="gr.g">
          <div class="drawer-group">{{ gr.g }}</div>
          <button v-for="item in gr.items" :key="item.view" class="nav-item" :class="{ active: store.view === item.view }" @click="setView(item.view)">
            <span class="ni-ico"><i :class="item.ico"></i></span>
            <span>{{ item.label }}<span v-if="item.view === 'notifications' && store.notifCount" class="nav-badge">{{ store.notifCount > 99 ? '99+' : store.notifCount }}</span><span v-else-if="item.view === 'announcements' && store.annHasNew" class="nav-badge">新</span></span>
          </button>
        </template>
      </div>
    </Drawer>

    <!-- 移动端好友抽屉（A1：桌面右侧栏在手机上由此打开；含好友分组/收藏/状态设置） -->
    <Drawer v-if="store.isMobile" v-model:visible="store.friendsOpen" position="right" header="好友列表"
      class="friends-drawer" :style="{ width: 'min(380px, 94vw)' }">
      <RightBar />
    </Drawer>

    <!-- 全局弹窗 -->
    <QuickSearch />
    <UserDialog />
    <WorldDialog />
    <GroupDialog />
    <InstanceDialog />
    <AvatarDialog />
    <Dialog v-model:visible="store.previewUrl" header="图片预览" :style="{ width: 'min(720px, 96vw)' }" :dismissable-mask="true">
      <img v-if="store.previewUrl" :src="store.previewUrl" style="width:100%; border-radius:8px" alt="预览" />
    </Dialog>
    <Toast position="bottom-center" />
    <ConfirmDialog />
  </div>
</template>

<style scoped>
.header-bell-dot { position: absolute; top: 2px; right: 2px; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px; background: var(--danger); color: #fff; font-size: 9px; font-weight: 700; line-height: 16px; text-align: center; box-sizing: border-box; }
.to-top { position: fixed; right: 18px; bottom: 76px; z-index: 50; width: 38px; height: 38px; border-radius: 50%; border: 1px solid var(--border); background: var(--surface-3); color: var(--text); cursor: pointer; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 14px rgba(0,0,0,0.35); transition: transform 0.12s, border-color 0.12s; }
.to-top:hover { border-color: var(--accent); transform: translateY(-1px); }
@media (max-width: 899px) { .to-top { bottom: 70px; right: 12px; width: 34px; height: 34px; } }
.nav-badge { background: var(--danger); color: #fff; font-size: 9px; border-radius: 8px; padding: 0 4px; margin-left: 4px; line-height: 14px; display: inline-block; vertical-align: 1px; }
.drawer-nav { display: flex; flex-direction: column; gap: 2px; }
.drawer-group { font-size: 10px; color: var(--text-dim); margin: 10px 8px 3px; text-transform: uppercase; letter-spacing: 0.06em; }
.rail-group { font-size: 9px; color: var(--text-dim); margin: 10px 8px 3px; text-transform: uppercase; letter-spacing: 0.06em; opacity: 0.7; }
.drawer-group:first-child { margin-top: 0; }
/* 移动端好友抽屉：RightBar 撑满并内部滚动（rb-inner 自带 height:100% + overflow-y:auto） */
:deep(.friends-drawer .p-drawer-content) { padding: 0; overflow: hidden; }
</style>
