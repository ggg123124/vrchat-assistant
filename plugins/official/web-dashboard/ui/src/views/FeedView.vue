<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { store, openUser, openWorld, openPreview, loadMoreFeed, copyText, openGroup, resetFeed } from '../store.js';
import { time, date, locLabel, statusLabels, trustColor, instanceLabel, avatarLabel } from '../utils.js';

const datePop = ref(null);

/* ── B3 行展开详情：点击行展开/收起（桌面+移动端一致）── */
const expanded = ref(null);
function rowId(x) { return x.eventId || (x.type + '|' + x.userId + '|' + x.createdAt); }
function toggleRow(x) {
  // 移动端禁用展开（卡片流里详情意义不大且易误触）
  if (store.isMobile) return;
  const id = rowId(x);
  expanded.value = expanded.value === id ? null : id;
}
function sourceLabel(s) {
  if (s === 'websocket') return 'WebSocket';
  if (s === 'poll') return '轮询';
  if (s === 'api') return 'API';
  return s || '—';
}

/* ── 类型定义（对齐 VRCX Feed filters：GPS/Online/Offline/Status/Avatar/Bio）── */
const filterOptions = [
  { value: 'all', label: '所有' },
  { value: 'location', label: '位置变动' },
  { value: 'online', label: '上线' },
  { value: 'offline', label: '下线' },
  { value: 'status', label: '状态变动' },
  { value: 'avatar', label: '模型变动' },
  { value: 'bio', label: '简介变更' },
];

/* ── 日期范围筛选（VRCX 式日历范围选择：只选首尾，中间某天没数据也可选）── */
const dateRange = ref(null); // Calendar selectionMode="range" 的 [Date, Date]
// 动态数据时间范围（最早/最新日期）→ 日历可选范围（VRCX 对齐）
const evMinDate = computed(() => (store.eventsRange && store.eventsRange.min) ? new Date(store.eventsRange.min) : null);
const dateLabel = computed(() => {
  if (!store.feedDateFrom && !store.feedDateTo) return '全部时间';
  const fmt = (iso) => (iso ? iso.slice(5, 10).replace('-', '/') : '');
  if (store.feedDateFrom && store.feedDateTo) return `${fmt(store.feedDateFrom)} - ${fmt(store.feedDateTo)}`;
  return store.feedDateFrom ? `${fmt(store.feedDateFrom)} 起` : `至 ${fmt(store.feedDateTo)}`;
});
const hasDateFilter = computed(() => !!(store.feedDateFrom || store.feedDateTo));
// 日历范围选满两个端点才可应用
const canApplyRange = computed(() => Array.isArray(dateRange.value) && dateRange.value.length === 2 && !!dateRange.value[0] && !!dateRange.value[1]);

function applyDateRange() {
  const r = dateRange.value;
  if (r && r[0]) {
    const d0 = new Date(r[0]);
    store.feedDateFrom = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate()).toISOString();
  } else {
    store.feedDateFrom = '';
  }
  if (r && r[1]) {
    const d1 = new Date(r[1]);
    // 到所选日期的 23:59:59.999
    const end = new Date(d1.getFullYear(), d1.getMonth(), d1.getDate(), 23, 59, 59, 999);
    store.feedDateTo = end.toISOString();
  } else {
    store.feedDateTo = '';
  }
  datePop.value && datePop.value.hide();
  // 日期范围变化由下方 watch(feedDateFrom/To) → resetFeed 统一处理
}
function clearDateRange() {
  dateRange.value = null;
  store.feedDateFrom = '';
  store.feedDateTo = '';
  datePop.value && datePop.value.hide();
}

/* ── 类型判定 ── */
function typeOf(x) {
  if (x.type === 'friend-location' || x.type === 'user-location') return 'location';
  if (x.type === 'friend-online') return 'online';
  if (x.type === 'friend-offline') return 'offline';
  if (x.type === 'friend-active') return 'status';
  if (x.type === 'friend-update') {
    if (x.updateType === 'avatar') return 'avatar';
    if (x.updateType === 'bio') return 'bio';
    if (x.updateType === 'status') return 'status';
    if (x.updateType === 'user_icon') return 'userIcon';
    if (x.updateType === 'pronouns') return 'pronouns';
    if (x.updateType === 'displayName') return 'displayName';
    return 'other';
  }
  // 自己的资料/状态更新：与 friend-update 一致显示（状态灯/简介/模型）；
  // 旧格式（无 updateType）默认按状态变动——用户视角就是"在线状态更新"
  if (x.type === 'user-update') {
    if (x.updateType === 'avatar') return 'avatar';
    if (x.updateType === 'bio') return 'bio';
    if (x.updateType === 'user_icon') return 'userIcon';
    if (x.updateType === 'pronouns') return 'pronouns';
    if (x.updateType === 'displayName') return 'displayName';
    return 'status';
  }
  if (x.type === 'friend-add') return 'friendAdd';
  if (x.type === 'friend-delete') return 'friendDelete';
  if (x.type === 'unknown') return 'unknown';
  if (x.type === 'content-refresh') return 'contentRefresh';
  if (x.type === 'group-joined') return 'groupJoined';
  if (x.type === 'group-member-updated') return 'groupMemberUpdated';
  if (x.type === 'hide-notification' || x.type === 'see-notification') return 'notificationUpdate';
  if (x.type === 'notification' || x.type === 'notification-v2') {
    const t = x.updateType || x.notificationType || '';
    if (t === 'friendRequest') return 'friendRequest';
    if (t === 'invite' || t === 'requestInvite') return 'invite';
    if (t === 'message') return 'message';
    if (String(t).startsWith('group.')) return 'group';
    return 'notification';
  }
  // 通知状态更新：关联到群组通知的归入"群组通知"，否则"通知更新"
  if (x.type === 'notification-v2-update' || x.type === 'notification-update') {
    return x.notiGroupId ? 'group' : 'notificationUpdate';
  }
  return 'other';
}
const typeLabels = { location: '位置变动', online: '上线', offline: '下线', status: '状态变动', avatar: '模型变动', bio: '简介变更', userIcon: '头像图标', pronouns: '代词变更', displayName: '改名', friendRequest: '好友申请', invite: '邀请', message: '私信', group: '群组通知', notification: '通知', notificationUpdate: '通知更新', friendAdd: '新增好友', friendDelete: '删除好友', unknown: '未知事件', contentRefresh: '内容库', groupJoined: '加入群组', groupMemberUpdated: '群组更新', other: '资料变动' };
const typeIcons = { location: 'pi-map-marker', online: 'pi-sign-in', offline: 'pi-sign-out', status: 'pi-heart', avatar: 'pi-user-edit', bio: 'pi-file-edit', userIcon: 'pi-id-card', pronouns: 'pi-user', displayName: 'pi-pencil', friendRequest: 'pi-user-plus', invite: 'pi-arrow-right-arrow-left', message: 'pi-comment', group: 'pi-users', notification: 'pi-bell', notificationUpdate: 'pi-bell', friendAdd: 'pi-user-plus', friendDelete: 'pi-user-minus', unknown: 'pi-question-circle', contentRefresh: 'pi-refresh', groupJoined: 'pi-users', groupMemberUpdated: 'pi-users', other: 'pi-user' };
const typeSeverities = { location: 'info', online: 'success', offline: 'secondary', status: 'warning', avatar: 'warn', bio: 'contrast', userIcon: 'secondary', pronouns: 'contrast', displayName: 'warn', friendRequest: 'success', invite: 'info', message: 'secondary', group: 'warn', notification: 'secondary', notificationUpdate: 'secondary', friendAdd: 'success', friendDelete: 'danger', unknown: 'secondary', contentRefresh: 'info', groupJoined: 'success', groupMemberUpdated: 'warn', other: 'secondary' };
function isNotiUpdate(x) {
  return x.type === 'notification-v2-update' || x.type === 'notification-update';
}

/* ── 状态灯颜色（VRChat 官方状态色）── */
const STATUS_COLORS = { active: '#52c41a', 'join me': '#4287f5', 'ask me': '#fa8c16', busy: '#f5222d', offline: '#596778' };
function statusColor(s) {
  return STATUS_COLORS[s] || '#596778';
}
function statusText(s) {
  return statusLabels[s] || s || '';
}

/* ── 筛选 ── */
function isFilterActive(v) {
  if (v === 'all') return store.feedFilter.length === 0;
  return store.feedFilter.includes(v);
}
function toggleFilter(v) {
  if (v === 'all') {
    store.feedFilter = [];
    return;
  }
  const cur = store.feedFilter.slice();
  const i = cur.indexOf(v);
  if (i >= 0) cur.splice(i, 1);
  else cur.push(v);
  store.feedFilter = cur; // 空数组 = 显示所有
}
function toggleFav() {
  store.feedOnlyFav = !store.feedOnlyFav;
}
function toggleWatchFilter() {
  store.feedOnlyWatch = !store.feedOnlyWatch;
}
function exportRows() {
  const list = rows.value || [];
  if (!list.length) { toast('当前无事件可导出', 'warn'); return; }
  const blob = new Blob([JSON.stringify(list, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'vrchat-events-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
  URL.revokeObjectURL(url);
  toast('已导出 ' + list.length + ' 条事件', 'success');
}

function toggleTrackedFilter() {
  store.feedOnlyTracked = !store.feedOnlyTracked;
}
function toggleMeFilter() {
  store.feedOnlyMe = !store.feedOnlyMe;
}
// 追踪非好友快捷：非好友且不在追踪列表时显示（复用 /api/dashboard/tracked）
const trackingId = ref('');
function canTrack(x) {
  if (!x.userId) return false;
  if ((store.friends || []).some((f) => f.userId === x.userId)) return false;  // 好友不需要追踪
  return !store.trackedIds.has(x.userId);
}
async function trackUser(x) {
  if (!x.userId || trackingId.value) return;
  trackingId.value = x.userId;
  try {
    const r = await post('/api/dashboard/tracked', { userId: x.userId, displayName: x.displayName || x.senderUsername || '' });
    if (r && r.error) throw new Error(r.error);
    store.trackedIds = new Set([...store.trackedIds, x.userId]);
    toast('已添加追踪「' + (x.displayName || x.userId) + '」，正在拉取资料…', 'success');
  } catch (e) {
    toast('追踪失败：' + (e.message || e), 'error');
  } finally {
    trackingId.value = '';
  }
}

function filterByUser(x) {
  if (!x.userId) return;
  store.feedOnlyUser = x.userId;
  store.feedOnlyMe = false;
  expanded.value = null;
}
function filterByWorld(x) {
  store.feedOnlyWorld = x.worldId || x.previousWorldId || '';
}
function worldNameOf() {
  const wid = store.feedOnlyWorld;
  if (!wid) return '';
  const hit = rows.value.find((x) => x.worldId === wid || x.previousWorldId === wid);
  return (hit && (hit.worldName || hit.previousWorldName)) || '';
}
function clearWorldFilter() {
  store.feedOnlyWorld = '';
}

function clearUserFilter() {
  store.feedOnlyUser = '';
}

function isFav(x) {
  return store.favFriendIds && store.favFriendIds.has(x.userId);
}
function nameFor(x) {
  return store.nicknameMap[x.userId] || x.displayName || '?';
}
/* ── 通知事件：玩家列显示发送者/群组 ── */
function isNoti(x) {
  return x.type === 'notification' || x.type === 'notification-v2'
    || x.type === 'notification-v2-update' || x.type === 'notification-update';
}
function playerIdOf(x) {
  if (isNoti(x)) return x.senderUserId || x.notiGroupId || '';
  return x.userId;
}
function playerNameOf(x) {
  if (!isNoti(x)) return nameFor(x);
  if (x.senderUsername) return x.senderUsername;
  if (typeOf(x) === 'group') return x.notiGroupName || x.notiTitle || '群组通知';
  if (typeOf(x) === 'notificationUpdate') return '系统';
  return x.notiGroupName || '通知';
}
function playerAvatarOf(x) {
  if (!isNoti(x)) return x.avatarUrl || x.userIcon || '';
  if (typeOf(x) === 'group') return x.notiImageUrl || '';
  if (x.senderUserId) {
    const f = store.friends.find((f) => f.userId === x.senderUserId);
    if (f) return f.avatarUrl || f.userIcon || '';
  }
  return x.avatarUrl || x.userIcon || '';
}
function playerOpen(x) {
  if (isNoti(x)) {
    if (typeOf(x) === 'group' && x.notiGroupId) return openGroup(x.notiGroupId);
    if (x.senderUserId) return openUser({ userId: x.senderUserId, displayName: x.senderName || x.displayName || x.senderUserId, avatarUrl: x.avatarUrl || '' });
  }
  // 带事件信息打开资料：非好友（不在好友列表）时也能显示名字/头像，而不是裸 userId
  return openUser({ userId: x.userId, displayName: x.displayName || x.userId, avatarUrl: x.avatarUrl || '' });
}

const rows = computed(() => {
  let list = Array.isArray(store.feedEvents) ? store.feedEvents : [];
  if (store.feedFilter.length) {
    list = list.filter((x) => store.feedFilter.some((t) => t === typeOf(x)));
  }
  if (store.feedDateFrom || store.feedDateTo) {
    const fromT = store.feedDateFrom ? new Date(store.feedDateFrom).getTime() : 0;
    const toT = store.feedDateTo ? new Date(store.feedDateTo).getTime() : Infinity;
    list = list.filter((x) => {
      const t = new Date(x.createdAt).getTime();
      return t >= fromT && t <= toT;
    });
  }
  if (store.feedOnlyFav) list = list.filter((x) => isFav(x));
  if (store.feedOnlyWatch) list = list.filter((x) => store.watchlistIds.has(x.userId));
  if (store.feedOnlyMe) list = list.filter((x) => store.me && x.userId === store.me.userId);
  if (store.feedOnlyUser) list = list.filter((x) => x.userId === store.feedOnlyUser);
  if (store.feedOnlyTracked) list = list.filter((x) => store.trackedIds.has(x.userId));
  if (store.feedOnlyWorld) list = list.filter((x) => x.worldId === store.feedOnlyWorld || x.previousWorldId === store.feedOnlyWorld);
  const q = store.feedSearch.trim().toLowerCase();
  if (q) {
    list = list.filter((x) =>
      (x.displayName || '').toLowerCase().includes(q) ||
      (x.senderUsername || '').toLowerCase().includes(q) ||
      (x.worldName || '').toLowerCase().includes(q) ||
      (x.summary || '').toLowerCase().includes(q) ||
      (x.statusDescription || '').toLowerCase().includes(q) ||
      (x.avatarName || '').toLowerCase().includes(q) ||
      (x.notiMessage || '').toLowerCase().includes(q) ||
      (x.notiGroupName || '').toLowerCase().includes(q)
    );
  }
  return list;
});

// 按天分组（今天/昨天/MM-DD）：feedRows 只给模板用，rows 保持纯列表供计数/加载逻辑
function daySepLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  const yest = new Date(today.getTime() - 86400000);
  const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (same(d, today)) return '今天';
  if (same(d, yest)) return '昨天';
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const feedRows = computed(() => {
  const out = [];
  let lastDay = '';
  for (const x of rows.value) {
    const d = daySepLabel(x.createdAt);
    if (d !== lastDay) { out.push({ __sep: d }); lastDay = d; }
    out.push(x);
  }
  return out;
});

/* ── 自动加载 ── */
const FEED_TARGET = 50;
// 性能保护（无虚拟滚动）：移动端 DOM 行数上限收紧（中端机挂 400 个复杂行滚动掉帧），
// 桌面 400。到上限后停补并隐藏"加载更多"，用户用筛选/日期缩小范围查看更早内容
const isMobileDev = () => (typeof window !== 'undefined' && window.innerWidth < 900);
const feedHardCap = computed(() => (isMobileDev() ? 200 : 400));
function hasFilter() {
  return !!(store.feedFilter.length || store.feedSearch || store.feedDateFrom || store.feedDateTo || store.feedOnlyFav || store.feedOnlyWatch || store.feedOnlyMe || store.feedOnlyUser || store.feedOnlyTracked || store.feedOnlyWorld);
}
function fillFeed() {
  if (store.feedLoading || store.feedLoadingMore || !store.feedHasMore) return;
  if (hasFilter()) {
    // 有筛选：持续加载直到凑够 FEED_TARGET 条匹配（或数据库到底/硬上限）
    if (rows.value.length >= FEED_TARGET) return;
    if (store.feedEvents.length >= feedHardCap.value) return;
    loadMoreFeed({ target: FEED_TARGET, countMatch: () => rows.value.length });
  } else {
    // 无筛选（所有）：普通分页，一次一批
    loadMoreFeed();
  }
}
// 有筛选时列表匹配不足自动补齐（无筛选靠触底/按钮手动加载，避免死循环）
watch(rows, () => { if (hasFilter()) fillFeed(); });
// 筛选条件变化 → 重置列表（只留当前筛选下的最新数据，不堆积为凑数加载的无关事件）再补齐
watch(() => [store.feedFilter, store.feedSearch, store.feedDateFrom, store.feedDateTo, store.feedOnlyFav, store.feedOnlyWatch, store.feedOnlyMe, store.feedOnlyUser, store.feedOnlyTracked, store.feedOnlyWorld], () => {
  if (store.feedLoading) return;
  resetFeed().then(() => fillFeed());
});
let observer = null;
let onScroll = null;
onMounted(() => {
  const el = document.getElementById('feed-sentinel');
  // 关键：页面滚动发生在 .main-viewport（内部滚动容器），不是 window —— root 必须指向它
  const rootEl = document.querySelector('.main-viewport');
  if (el && rootEl && 'IntersectionObserver' in window) {
    observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) fillFeed();
    }, { root: rootEl, rootMargin: '200px' });
    observer.observe(el);
  }
  // 滚动监听兜底：双保险确保触底一定触发（observer 在某些滚动容器下可能失效）
  if (rootEl) {
    onScroll = () => {
      if (rootEl.scrollTop + rootEl.clientHeight >= rootEl.scrollHeight - 240) {
        fillFeed();
      }
    };
    rootEl.addEventListener('scroll', onScroll, { passive: true });
  }
});
onUnmounted(() => {
  if (observer) observer.disconnect();
  const rootEl = document.querySelector('.main-viewport');
  if (rootEl && onScroll) rootEl.removeEventListener('scroll', onScroll);
});
</script>

<template>
  <div class="feed-view">
    <!-- 日历弹层（唯一实例，append 到 body；桌面/移动的日期按钮共用） -->
    <Popover ref="datePop">
      <div class="date-cal">
        <Calendar v-model="dateRange" selectionMode="range" :numberOfMonths="store.isMobile ? 1 : 2" :minDate="evMinDate" :maxDate="new Date()" inline showIcon />
        <div class="dc-actions">
          <Button v-if="hasDateFilter" label="清除" text size="small" @click="clearDateRange" />
          <Button label="应用" size="small" :disabled="!canApplyRange" @click="applyDateRange" />
        </div>
      </div>
    </Popover>

    <div class="view-title">
      动态
      <Tag v-if="store.feedLoading" value="同步中…" severity="secondary" rounded />
      <!-- 日期+星标在标题行（双端统一）；弹层锚定到点击的按钮 -->
      <span class="vt-actions">
        <button class="chip date-btn" :class="{ active: hasDateFilter }" @click="datePop.toggle($event)" :aria-label="'日期筛选：' + dateLabel" :title="'日期筛选'">
          <i :class="hasDateFilter ? 'pi pi-calendar-times' : 'pi pi-calendar'"></i>
          {{ dateLabel }}
        </button>
        <button class="chip star-btn" :class="{ 'star-on': store.feedOnlyFav }" @click="toggleFav" :title="'仅显示星标好友'" aria-label="仅显示星标好友">
          <i :class="store.feedOnlyFav ? 'pi pi-star-fill' : 'pi pi-star'"></i><span v-if="store.favFriendIds && store.favFriendIds.size"> ({{ store.favFriendIds.size }})</span>
        </button>
        <button class="chip star-btn" :class="{ 'star-on': store.feedOnlyWatch }" @click="toggleWatchFilter" :title="'仅显示关注名单'" aria-label="仅显示关注名单">
          <i :class="store.feedOnlyWatch ? 'pi pi-eye' : 'pi pi-eye-slash'"></i>
        </button>
        <button class="chip star-btn" :class="{ 'star-on': store.feedOnlyMe }" @click="toggleMeFilter" :title="'仅显示我的事件'" aria-label="仅显示我的事件">
          <i :class="store.feedOnlyMe ? 'pi pi-user-check' : 'pi pi-user'"></i>
        </button>
        <button class="chip star-btn" title="导出当前筛选结果（JSON）" aria-label="导出当前筛选结果" @click="exportRows"><i class="pi pi-download"></i></button>
        <button v-if="store.feedOnlyWorld" class="chip star-btn star-on" @click="clearWorldFilter" :title="'清除「只看此世界」筛选'" aria-label="清除只看此世界筛选">
          <i class="pi pi-globe"></i> 只看此世界{{ worldNameOf() ? '：' + worldNameOf().slice(0, 16) : '' }}
        </button>
        <button v-if="store.feedOnlyUser" class="chip star-btn star-on" @click="clearUserFilter" :title="'清除「只看此人」筛选'" aria-label="清除只看此人筛选">
          <i class="pi pi-filter"></i> 此人 {{ store.feedOnlyUser.slice(0, 8) }}…
        </button>
        <button class="chip star-btn" :class="{ 'star-on': store.feedOnlyTracked }" @click="toggleTrackedFilter" :title="'仅显示追踪非好友的事件'" aria-label="仅显示追踪非好友的事件">
          <i class="pi pi-binoculars"></i><span v-if="store.trackedIds.size"> ({{ store.trackedIds.size }})</span>
        </button>
      </span>
      <span class="feed-count" :title="'当前筛选 ' + rows.length + ' / 已加载 ' + store.feedEvents.length + ' / 数据库共 ' + store.feedTotal + ' 条'">{{ rows.length }} / {{ store.feedEvents.length }} / {{ store.feedTotal }}</span>
    </div>

    <!-- 类型筛选横条 + 搜索（所有元素弹性收缩换行） -->
    <div class="feed-toolbar">
      <div class="ft-row">
        <div class="ft-chips">
          <button v-for="o in filterOptions" :key="o.value" class="chip" :class="{ active: isFilterActive(o.value) }" @click="toggleFilter(o.value)">{{ o.label }}</button>
        </div>
        <div class="ft-search">
          <i class="pi pi-search"></i>
          <input v-model="store.feedSearch" placeholder="搜索玩家 / 世界 / 摘要…" class="search-input" aria-label="搜索动态" />
          <i v-if="store.feedSearch" class="pi pi-times search-clear" title="清空" @click="store.feedSearch = ''"></i>
        </div>
      </div>
    </div>

    <!-- 加载态 -->
    <div v-if="store.feedLoading && !store.feedEvents.length" class="feed-loading">
      <ProgressSpinner style="width: 34px; height: 34px" strokeWidth="3" />
      <div class="text-dim">正在加载动态…</div>
    </div>
    <div v-else-if="!rows.length" class="empty">
      <i class="pi pi-bolt empty-icon" aria-hidden="true"></i>
      <template v-if="store.feedOnlyWatch">暂无动态——关注名单为空或没有新动态，去资料弹窗点「关注」添加</template>
      <template v-else-if="store.feedOnlyMe">暂无我的事件（位置/资料变化会出现在这里）</template>
      <template v-else-if="store.feedOnlyUser">该用户暂无匹配事件，或调整筛选条件</template>
      <template v-else-if="store.feedOnlyTracked">暂无追踪用户事件——去「非好友追踪」页添加追踪，或调整筛选</template>
      <template v-else>暂无动态<small>调整筛选条件，或等待好友活动（上线、位置、状态、模型变化）</small></template>
    </div>

    <!-- 表格 -->
    <div v-else class="feed-table">
      <div class="ft-head">
        <span>时间</span><span>类型</span><span>玩家</span><span>详细信息</span>
      </div>

      <template v-for="x in feedRows" :key="x.__sep ? 'sep-' + x.__sep : rowId(x)">
      <div v-if="x.__sep" class="ev-daysep"><span>{{ x.__sep }}</span></div>
      <div v-else class="ev-row" :class="{ open: expanded === rowId(x) }" role="button" tabindex="0" @click="toggleRow(x)" @keydown.enter="toggleRow(x)">
        <div v-if="!store.isMobile" class="c-time mono">{{ time(x.createdAt) }}<small>{{ date(x.createdAt) }}</small></div>
        <div v-else class="c-time mono">{{ date(x.createdAt) }}</div>
        <div class="c-type"><Tag :value="typeLabels[typeOf(x)]" :severity="typeSeverities[typeOf(x)]" rounded><i class="pi ctype-ico" :class="typeIcons[typeOf(x)] || 'pi-circle'"></i></Tag></div>
        <div class="c-player" @click.stop="playerOpen(x)" role="button" tabindex="0" @keydown.enter="playerOpen(x)">
          <Avatar :image="playerAvatarOf(x)" shape="circle" size="small" :label="avatarLabel(playerAvatarOf(x), playerNameOf(x))" />
          <span class="pl-name" :style="{ color: trustColor(x.trustLevel) }">{{ playerNameOf(x) }}</span>
          <i v-if="isFav(x)" class="pi pi-star-fill pl-star" title="收藏好友"></i>
          <i v-if="store.watchlistIds.has(x.userId)" class="pi pi-eye pl-watch" title="关注名单"></i>
        </div>
        <div class="c-detail" @click.stop>
          <!-- 位置变动 -->
          <template v-if="typeOf(x) === 'location'">
            <!-- 离线/传送等特殊位置：offline:offline 是 VRChat 网页端在线的表示（真离线推 friend-offline），对齐 VRCX 显示"网页端在线" -->
            <template v-if="x.location === 'offline' || x.location === 'offline:offline'">
              <span class="dim">网页端在线</span>
            </template>
            <template v-else-if="x.location === 'traveling'">
              <span class="dim">传送中</span>
            </template>
            <template v-else>
            <template v-if="x.previousWorldName && x.previousWorldName !== x.worldName">
              <img v-if="x.previousWorldImageUrl" class="wthumb" :src="x.previousWorldImageUrl" alt="" loading="lazy" />
              <span v-if="x.previousWorldId" class="world-link" @click="openWorld(x.previousWorldId)" role="button" tabindex="0" @keydown.enter="openWorld(x.previousWorldId)">{{ x.previousWorldName }}</span>
              <span v-else class="dim">{{ x.previousWorldName }}</span>
              <span class="arr">→</span>
            </template>
            <img v-if="x.worldImageUrl" class="wthumb" :src="x.worldImageUrl" alt="" loading="lazy" />
            <span v-if="x.worldName" class="world-link" @click="openWorld(x.worldId)" role="button" tabindex="0" @keydown.enter="openWorld(x.worldId)">{{ x.worldName }}</span>
            <span v-else-if="x.location" class="dim">{{ locLabel(x.location) || x.location }}</span>
            <span v-if="x.instanceType || x.region || x.instanceId" class="inst mono">{{ instanceLabel(x.instanceType) }}{{ x.region ? ' · ' + x.region.toUpperCase() : '' }}{{ x.instanceId ? ' · ' + x.instanceId : '' }}</span>
            <span v-if="x.travelingToLocation" class="dim">传送中</span>
            </template>
          </template>

          <!-- 状态变动：旧状态灯 → 新状态灯 / [灯] 当前签名 -->
          <template v-else-if="typeOf(x) === 'status'">
            <span v-if="x.previousStatus && x.previousStatus !== x.status" class="slamp" :style="{ background: statusColor(x.previousStatus) }" :title="statusText(x.previousStatus)"></span>
            <span v-if="x.previousStatus && x.previousStatus !== x.status" class="arr">→</span>
            <span class="slamp" :style="{ background: statusColor(x.status) }" :title="statusText(x.status)"></span>
            <span v-if="x.statusDescription" class="sdesc" :title="x.statusDescription">{{ x.statusDescription }}</span>
            <span v-else-if="x.status" class="sdesc dim">{{ statusText(x.status) }}</span>
          </template>

          <!-- 模型变动：旧模型名 → 新模型名，缩略图+名字成组不可拆（av-pair），箭头独立；avtr ID（若 API 提供） -->
          <template v-else-if="typeOf(x) === 'avatar'">
            <!-- 变动前：旧图+旧名一组，禁止挤压换行 -->
            <span class="av-pair">
              <img v-if="x.previousAvatarImageUrl" class="av-thumb" :src="x.previousAvatarImageUrl" alt="旧模型" loading="lazy" @click="openPreview(x.previousAvatarImageUrl)" />
              <span v-if="x.previousAvatarName" class="av-name av-old" :title="'旧模型：' + x.previousAvatarName">{{ x.previousAvatarName }}</span>
            </span>
            <!-- 箭头 -->
            <span v-if="x.previousAvatarImageUrl || x.previousAvatarName" class="av-arrow" aria-hidden="true">→</span>
            <!-- 变动后：新图+新名一组，禁止挤压换行 -->
            <span class="av-pair">
              <img v-if="x.avatarThumbnailUrl" class="av-thumb" :src="x.avatarThumbnailUrl" alt="新模型" loading="lazy" @click="openPreview(x.avatarThumbnailUrl)" />
              <span class="av-name" :title="'模型：' + (x.avatarName || '未知模型')">{{ x.avatarName || '未知模型' }}</span>
            </span>
            <span v-for="t in (x.avatarTags || []).slice(0, 3)" :key="t" class="av-tag">{{ t }}</span>
            <template v-if="x.avatarId">
              <span class="av-id mono">{{ x.avatarId }}</span>
              <Button icon="pi pi-copy" text size="small" rounded :aria-label="'复制模型 ID'" @click="copyText(x.avatarId)" />
            </template>
          </template>

          <!-- 简介变更 -->
          <template v-else-if="typeOf(x) === 'bio'">
            <span class="bio-text">{{ x.bio || '(已清空)' }}</span>
          </template>

          <!-- 上线 -->
          <template v-else-if="typeOf(x) === 'online'">
            <span class="dim">进入</span>
            <img v-if="x.worldImageUrl" class="wthumb" :src="x.worldImageUrl" alt="" loading="lazy" />
            <span v-if="x.worldName" class="world-link" @click="openWorld(x.worldId)" role="button" tabindex="0" @keydown.enter="openWorld(x.worldId)">{{ x.worldName }}</span>
            <span v-else class="dim">VRChat</span>
          </template>

          <!-- 好友申请 -->
          <template v-else-if="typeOf(x) === 'friendRequest'">
            <span class="dim">{{ x.senderUsername || '有人' }} 请求加你为好友</span>
          </template>

          <!-- 邀请 / 私信 -->
          <template v-else-if="typeOf(x) === 'invite' || typeOf(x) === 'message'">
            <span class="dim">{{ x.notiMessage || x.notiTitle || x.summary || (x.senderUsername + ' 发来一条' + typeLabels[typeOf(x)]) }}</span>
          </template>

          <!-- 群组通知：显示群组名+内容；更新类显示"通知已读：内容"，点击打开群组 -->
          <template v-else-if="typeOf(x) === 'group'">
            <template v-if="isNotiUpdate(x)">
              <span class="noti-read-wrap" :class="{ 'noti-msg-link': x.notiGroupId }" @click.stop="openGroup(x.notiGroupId)" role="button" tabindex="0" @keydown.enter="openGroup(x.notiGroupId)" :title="x.notiGroupId ? '点击打开群组' : ''">
                <span class="dim">通知已读：</span>
                <span class="noti-msg-inline">{{ x.notiMessage || x.notiTitle || '群组通知' }}</span>
              </span>
            </template>
            <span v-else class="noti-msg" :class="{ 'noti-msg-link': x.notiGroupId }" @click.stop="openGroup(x.notiGroupId)" role="button" tabindex="0" @keydown.enter="openGroup(x.notiGroupId)" :title="x.notiGroupId ? '点击打开群组' : ''">{{ x.notiMessage || x.notiTitle }}</span>
          </template>

          <!-- 其他通知 -->
          <template v-else-if="typeOf(x) === 'notification'">
            <span class="dim">{{ x.notiMessage || x.notiTitle || x.summary || '通知' }}</span>
          </template>

          <!-- 通知状态更新（已读/过期等） -->
          <template v-else-if="typeOf(x) === 'notificationUpdate'">
            <span class="dim">{{ x.summary || '通知状态更新' }}</span>
          </template>

          <!-- 头像图标变更：旧图 → 新图 -->
          <template v-else-if="typeOf(x) === 'userIcon'">
            <span class="dim">更新了头像图标</span>
            <img v-if="x.previousUserIcon" class="uicon" :src="x.previousUserIcon" alt="" loading="lazy" />
            <span v-if="x.previousUserIcon && x.userIcon" class="av-arrow" aria-hidden="true">→</span>
            <img v-if="x.userIcon" class="uicon" :src="x.userIcon" alt="" loading="lazy" @click="openPreview(x.userIcon)" />
            <span v-if="!x.previousUserIcon && !x.userIcon" class="dim">（图片未取到）</span>
          </template>

          <!-- 代词变更 -->
          <template v-else-if="typeOf(x) === 'pronouns'">
            <span class="dim">代词：</span><span>{{ x.previousPronouns || '(空)' }} → {{ x.pronouns || '(空)' }}</span>
          </template>

          <!-- 改名 -->
          <template v-else-if="typeOf(x) === 'displayName'">
            <span class="dim">改名：</span><span>{{ x.previousDisplayName || '?' }}</span>
            <span class="av-arrow" aria-hidden="true">→</span>
            <span>{{ x.displayName }}</span>
          </template>

          <!-- 新增 / 删除好友 -->
          <template v-else-if="typeOf(x) === 'friendAdd'">
            <span class="dim">与 {{ x.displayName }} 成为好友</span>
          </template>
          <template v-else-if="typeOf(x) === 'friendDelete'">
            <span class="dim">已与 {{ x.displayName }} 解除好友</span>
          </template>

          <!-- 内容库（VRC+ inventory）增删：解析出物品名+缩略图（后台限流补全，已移除的可能只有 ID） -->
          <template v-else-if="typeOf(x) === 'contentRefresh'">
            <img v-if="x.contentItemImageUrl" class="wthumb" :src="x.contentItemImageUrl" alt="" loading="lazy" @click="openPreview(x.contentItemImageUrl)" />
            <span class="dim">{{ (x.contentActionType === 'add' ? '获得' : x.contentActionType === 'delete' ? '移除' : x.contentActionType || '更新') }}{{ x.contentItemTypeLabel }}</span>
            <span v-if="x.contentItemName">{{ x.contentItemName }}</span>
            <span v-if="!x.contentItemName && x.contentItemId" class="mono" :title="x.contentItemId">{{ x.contentItemId }}</span>
            <Button v-if="x.contentItemId" icon="pi pi-copy" text size="small" rounded :aria-label="'复制物品 ID'" :title="x.contentItemName ? '物品 ID：' + x.contentItemId : '复制物品 ID'" @click="copyText(x.contentItemId)" />
          </template>

          <!-- 加入群组：groupId 可点击打开群组 -->
          <template v-else-if="typeOf(x) === 'groupJoined'">
            <span class="dim">加入了</span>
            <span v-if="x.notiGroupName" class="world-link" @click="openGroup(x.groupId || x.notiGroupId)" role="button" tabindex="0" @keydown.enter="openGroup(x.groupId || x.notiGroupId)">{{ x.notiGroupName }}</span>
            <span v-if="x.groupId && !x.notiGroupName" class="mono" :title="x.groupId">{{ x.groupId }}</span>
            <Button v-if="x.groupId" icon="pi pi-copy" text size="small" rounded :aria-label="'复制群组 ID'" :title="x.notiGroupName ? '复制群组 ID：' + x.groupId : '复制群组 ID'" @click="copyText(x.groupId)" />
          </template>

          <!-- 群组成员信息更新 -->
          <template v-else-if="typeOf(x) === 'groupMemberUpdated'">
            <span class="dim">群组成员信息更新<span v-if="x.notiGroupName">：{{ x.notiGroupName }}</span></span>
          </template>

          <!-- 未知事件 -->
          <template v-else-if="typeOf(x) === 'unknown'">
            <span class="dim">未识别的 VRChat 事件（无可解析内容）</span>
          </template>

          <!-- 下线：对账补记的显示掉线窗口（非 WS 实时推送） -->
          <template v-else-if="typeOf(x) === 'offline' && x.reconcile">
            <span v-if="x.offlineWindowStart" class="dim">API 掉线期间离线（{{ time(x.offlineWindowStart) }} ~ {{ time(x.reconcileDetectedAt) }}）</span>
            <span v-else class="dim">对账确认离线（{{ time(x.reconcileDetectedAt) }}）</span>
          </template>

          <!-- 下线 / 其他 -->
          <template v-else>
            <span class="dim">{{ x.summary || '—' }}</span>
          </template>
        </div>

        <!-- 移动端折叠指示（桌面端隐藏） -->
        <i class="pi ev-chev" :class="expanded === rowId(x) ? 'pi-chevron-up' : 'pi-chevron-down'" aria-hidden="true"></i>

        <!-- B3 展开详情：点击行展开（含完整时间/来源/世界/实例/模型/状态前后，均可复制） -->
        <div v-if="expanded === rowId(x)" class="ev-detail" @click.stop>
          <div class="ed-cell"><span>事件 ID</span><b class="mono ed-id">{{ x.eventId }}</b>
            <Button icon="pi pi-copy" text rounded :aria-label="'复制事件 ID'" @click="copyText(String(x.eventId))" /></div>
          <div class="ed-cell"><span>完整时间</span><b>{{ date(x.createdAt) }} {{ time(x.createdAt) }}</b></div>
          <div class="ed-cell"><span>来源</span><b>{{ sourceLabel(x.source) }}</b></div>
          <div v-if="x.worldId" class="ed-cell"><span>世界</span>
            <b class="ed-link" @click.stop="openWorld(x.worldId)">{{ x.worldName || x.worldId }}</b>
            <Button size="small" text icon="pi pi-filter" label="只看此世界" @click.stop="filterByWorld(x)" />
            <Button icon="pi pi-copy" text rounded :aria-label="'复制世界 ID'" @click="copyText(x.worldId)" /></div>
          <div v-if="x.location && !['offline', 'offline:offline', 'traveling'].includes(x.location)" class="ed-cell"><span>实例</span>
            <b class="mono ed-id">{{ locLabel(x.location) || x.location }}</b>
            <Button icon="pi pi-copy" text rounded :aria-label="'复制实例位置'" @click="copyText(x.location)" /></div>
          <div v-if="x.avatarName || x.avatarId" class="ed-cell"><span>模型</span>
            <b class="ed-ellip">{{ x.avatarName || '未知模型' }}</b>
            <b v-if="x.avatarId" class="mono ed-id">{{ x.avatarId }}</b>
            <Button v-if="x.avatarId" icon="pi pi-copy" text rounded :aria-label="'复制模型 ID'" @click="copyText(x.avatarId)" /></div>
          <div v-if="x.reconcile" class="ed-cell"><span>下线判定</span>
            <b class="ed-ellip">断线窗口对账（非实时推送）<template v-if="x.offlineWindowStart">：{{ time(x.offlineWindowStart) }} ~ {{ time(x.reconcileDetectedAt) }}</template></b></div>
          <div v-if="x.reconcile && x.lastSeenAt" class="ed-cell"><span>最后在线</span>
            <b>{{ time(x.lastSeenAt) }}</b></div>
          <div v-if="x.type === 'unknown' && x.unknownContent" class="ed-cell"><span>事件内容</span>
            <b class="mono ed-id">{{ x.unknownContent }}</b>
            <Button icon="pi pi-copy" text rounded :aria-label="'复制事件内容'" @click="copyText(x.unknownContent)" /></div>
          <div v-if="x.updateType === 'displayName'" class="ed-cell"><span>改名</span>
            <b class="ed-ellip">{{ x.previousDisplayName || '?' }} → {{ x.displayName }}</b></div>
          <div v-if="x.updateType === 'pronouns'" class="ed-cell"><span>代词</span>
            <b class="ed-ellip">{{ x.previousPronouns || '(空)' }} → {{ x.pronouns || '(空)' }}</b></div>
          <div v-if="x.updateType === 'user_icon'" class="ed-cell"><span>头像图标</span>
            <b class="ed-ellip">{{ x.previousUserIcon ? '已更换' : '已设置' }}</b>
            <img v-if="x.userIcon" class="uicon" :src="x.userIcon" alt="" loading="lazy" @click="openPreview(x.userIcon)" /></div>
          <div v-if="x.previousStatus && x.previousStatus !== x.status" class="ed-cell"><span>状态</span>
            <span class="slamp" :style="{ background: statusColor(x.previousStatus) }" :title="statusText(x.previousStatus)"></span>
            <span class="arr">→</span>
            <span class="slamp" :style="{ background: statusColor(x.status) }" :title="statusText(x.status)"></span>
            <b class="ed-ellip">{{ x.previousStatusDescription || statusText(x.previousStatus) }} → {{ x.statusDescription || statusText(x.status) }}</b></div>
          <div v-else-if="x.status" class="ed-cell"><span>状态</span>
            <span class="slamp" :style="{ background: statusColor(x.status) }" :title="statusText(x.status)"></span>
            <b class="ed-ellip">{{ x.statusDescription || statusText(x.status) }}</b></div>
          <div v-if="isNoti(x) && x.senderUsername" class="ed-cell"><span>发送者</span><b class="ed-ellip">{{ x.senderUsername }}</b></div>
          <div v-if="x.summary && !['location', 'status'].includes(typeOf(x))" class="ed-cell"><span>摘要</span><b class="ed-ellip">{{ x.summary }}</b></div>
          <div class="ed-cell ed-actions">
            <Button size="small" text icon="pi pi-copy" label="复制JSON" :title="'复制完整事件 JSON（排查/分享）'" @click="copyText(JSON.stringify(x, null, 2))" />
            <Button size="small" text icon="pi pi-filter" label="只看此人" :title="'筛选出 ' + (x.displayName || '') + ' 的全部事件'" @click="filterByUser(x)" />
            <Button v-if="store.feedOnlyUser === x.userId" size="small" text icon="pi pi-times" label="清除此人筛选" @click="clearUserFilter" />
            <Button v-if="canTrack(x)" size="small" text icon="pi pi-user-plus" label="追踪此人" :title="'添加到非好友追踪（每小时刷新资料）'" :loading="trackingId === x.userId" @click="trackUser(x)" />
          </div>
        </div>
      </div>
      </template>

      <div class="feed-more">
        <Button v-if="store.feedHasMore && store.feedEvents.length < feedHardCap" :label="store.feedLoadingMore ? '加载中…' : '加载更多'" text size="small" icon="pi pi-angle-down" @click="loadMoreFeed()" />
        <!-- 哨兵始终渲染（条件渲染会导致 onMounted 拿不到元素、observer 失效） -->
        <div id="feed-sentinel" class="feed-sentinel"></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.feed-toolbar { margin-bottom: 12px; }
.ft-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ft-chips { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; flex: 1 1 320px; min-width: 0; }
.ft-search {
  flex: none;
  max-width: 210px;
  width: 100%;
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0 12px;
  height: 28px;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.ft-search:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 22%, transparent);
}
.ft-search > .pi-search { font-size: 11px; color: var(--text-dim); flex: none; }
.search-clear { font-size: 10px; color: var(--text-dim); cursor: pointer; padding: 2px; flex: none; }
.search-clear:hover { color: var(--text); }
.feed-count { margin-left: auto; color: var(--text-dim); font-size: 11px; font-variant-numeric: tabular-nums; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* C4 窄窗口：计数保持行内、贴最右（不换行独占） */
@media (min-width: 900px) and (max-width: 1280px) {
  .feed-count { flex-basis: auto; margin-left: auto; text-align: right; max-width: 40%; }
}

/* C4 桌面窄窗口：标题行与工具栏所有元素一起弹性收缩换行，不再只有 chips 独自动 */
@media (min-width: 900px) and (max-width: 1280px) {
  .view-title { flex-wrap: wrap; row-gap: 4px; }
  .vt-actions .chip { padding: 4px 8px; }
  .ft-row { row-gap: 6px; }
  .ft-chips { flex-basis: auto; }
  .ft-search { max-width: none; min-width: 140px; flex: 1 1 150px; }
}

/* 筛选 chip（多选 + 日期/星标统一为同一视觉语言） */
.chip {
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--text-dim);
  border-radius: 999px;
  padding: 4px 13px;
  font-size: 12px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  transition: all 0.12s;
  white-space: nowrap;
  font-family: inherit;
  line-height: 1;
}

.chip.active {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.date-btn i { font-size: 11px; }
.date-btn.active { background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); }
.star-btn { width: 30px; padding: 0; justify-content: center; }
.star-btn i { font-size: 12px; }
.star-btn.star-on { color: #ffca28; border-color: color-mix(in srgb, #ffca28 40%, var(--border)); }
.date-opts { display: flex; flex-direction: column; gap: 2px; padding: 4px; }
.date-opts .chip { text-align: left; border-radius: 6px; }
.date-cal { padding: 6px; }
.dc-actions { display: flex; justify-content: flex-end; align-items: center; gap: 8px; padding: 8px 6px 2px 0; }
.star-on { color: #ffca28 !important; }
.star-on .pi { color: #ffca28 !important; }

.feed-loading { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 60px 0; }

/* 表格：百分比列宽 —— 列边界相对屏幕保持固定比例（如玩家列结束在 1/3 处），任意分辨率下位置不变 */
.feed-table { display: flex; flex-direction: column; width: 100%; }
.ev-daysep { display: flex; align-items: center; gap: 8px; margin: 10px 0 4px; font-size: 11px; font-weight: 700; color: var(--text-dim); }
.ev-daysep::after { content: ''; flex: 1; height: 1px; background: var(--border-soft); }
.ev-daysep span { flex: none; }
.ft-head {
  display: grid;
  grid-template-columns: minmax(56px, 7%) minmax(72px, 8%) minmax(130px, 18%) minmax(0, 67%);
  gap: 10px;
  padding: 6px 12px;
  font-size: 11px;
  font-weight: 700;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  background: var(--bg);
  z-index: 5;
}
.ev-row {
  display: grid;
  grid-template-columns: minmax(56px, 7%) minmax(72px, 8%) minmax(130px, 18%) minmax(0, 67%);
  gap: 10px;
  align-items: center;
  padding: 7px 12px;
  border-bottom: 1px solid var(--border-soft);
  cursor: pointer;
  transition: background 0.1s;
  position: relative;
}
.ev-row:hover { background: var(--surface); }
.ev-row.open { background: var(--surface); box-shadow: inset 2px 0 0 var(--accent); }

.c-time { font-size: 12px; color: var(--text-dim); line-height: 1.25; }
.c-time small { display: block; font-size: 10px; opacity: 0.7; }
.c-type { display: flex; align-items: center; }
.c-type :deep(.p-tag) { font-size: 10.5px; }
.c-player {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 6px;
}
.c-player:hover { background: var(--surface-3); }
.pl-name { font-weight: 600; font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pl-star { font-size: 9px; color: #ffca28; flex: none; }
.pl-watch { font-size: 9px; color: var(--text-dim); flex: none; margin-left: 3px; }

/* 详细信息列：桌面禁止换行（单行省略）；移动端卡片流仍允许换行 */
.c-detail { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 12px; flex-wrap: nowrap; overflow: hidden; }
.c-detail > * { min-width: 0; flex: none; }
.c-detail > *:last-child, .c-detail > .bio-text, .c-detail > .noti-msg, .c-detail > .noti-read-wrap { flex: 0 1 auto; }
@media (max-width: 899px) {
  .c-detail { flex-wrap: wrap; overflow: visible; }
  .c-detail > * { flex: 0 1 auto; }
}
.dim { color: var(--text-dim); white-space: nowrap; }
.arr { color: var(--text-dim); opacity: 0.6; font-size: 11px; }
.world-link {
.uicon { width: 26px; height: 26px; border-radius: 50%; object-fit: cover; flex: none; cursor: pointer; }
  color: var(--accent-2);
  cursor: pointer;
  padding: 1px 5px;
  border-radius: 5px;
  background: color-mix(in srgb, var(--accent-2) 10%, transparent);
  white-space: nowrap;
}
.world-link:hover { background: color-mix(in srgb, var(--accent-2) 22%, transparent); }
.inst { color: var(--text-dim); font-size: 10.5px; background: var(--surface-3); padding: 1px 6px; border-radius: 5px; flex: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }

/* 状态灯 */
.slamp {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  display: inline-block;
  flex: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, currentColor 12%, transparent);
  border: 1.5px solid rgba(0,0,0,0.35);
}
.sdesc { color: var(--text); font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* 模型缩略图+名字成组：图与名永不拆行、不挤压（名过长省略） */
.av-pair {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
  flex: none;
  min-width: 0;
  max-width: 100%;
}
.av-pair .av-thumb { flex: none; }
.av-pair .av-name { overflow: hidden; text-overflow: ellipsis; }

/* 模型缩略图（与世界的图同尺寸，用户要求一样大） */
.av-thumb {
  width: 26px;
  height: 26px;
  object-fit: cover;
  border-radius: 5px;
  cursor: zoom-in;
  border: 1px solid var(--border);
  flex: none;
}
.av-name { font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.av-old { color: var(--text-dim); font-weight: 500; }
.av-arrow { color: var(--text-dim); flex: none; font-size: 13px; }
.av-id { color: var(--text-dim); font-size: 10.5px; }
.av-tag {
  font-size: 10px;
  color: var(--text-dim);
  background: var(--surface-3);
  border: 1px solid var(--border);
  padding: 0 6px;
  border-radius: 999px;
  white-space: nowrap;
}

/* 世界头图 */
.wthumb {
  width: 26px;
  height: 26px;
  object-fit: cover;
  border-radius: 5px;
  border: 1px solid var(--border);
  flex: none;
  vertical-align: middle;
}

.bio-text {
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}

/* 通知：消息内容（可点击打开群组） */
.noti-msg {
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}
.noti-msg-link {
  color: var(--accent-2);
  cursor: pointer;
  padding: 1px 6px;
  border-radius: 5px;
  background: color-mix(in srgb, var(--accent-2) 8%, transparent);
}
.noti-msg-link:hover { background: color-mix(in srgb, var(--accent-2) 20%, transparent); }

/* "通知已读：内容" 同一行整体 */
.noti-read-wrap {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  max-width: 100%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
  padding: 1px 6px;
  border-radius: 5px;
}
.noti-read-wrap .dim { flex: none; }
.noti-msg-inline {
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.noti-read-wrap.noti-msg-link { color: var(--accent-2); background: color-mix(in srgb, var(--accent-2) 8%, transparent); }
.noti-read-wrap.noti-msg-link:hover { background: color-mix(in srgb, var(--accent-2) 20%, transparent); }
.noti-read-wrap.noti-msg-link .noti-msg-inline { color: var(--accent-2); }

.feed-more { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 12px 0; }
.feed-cap-hint { font-size: 11px; }

/* B3 展开详情 */
.ev-chev { display: none; }
.ev-detail {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 5px 20px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 9px 12px;
  margin: 4px 0 2px;
  font-size: 11.5px;
}
.ed-cell { display: flex; align-items: center; gap: 5px; min-width: 0; }
.ed-cell > span { color: var(--text-dim); font-size: 10.5px; flex: none; }
.ed-cell > b { font-weight: 600; min-width: 0; }
.ed-ellip { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ed-id { font-size: 10.5px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ed-link { color: var(--accent-2); cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ev-detail :deep(.p-button) { width: 20px; height: 20px; flex: none; }

/* 移动端：卡片化 */
@media (max-width: 899px) {
  .ft-head { display: none; }
  .ft-row { gap: 8px; }
  /* 筛选 chips 与标题行日期/星标按钮同大小（用户要求统一） */
  .chip { height: 26px; padding: 4px 10px; font-size: 11px; }
  .search-input { font-size: 12.5px; }
  /* 右上角计数三段在手机上收窄（完整值在 title 提示） */
  .feed-count { font-size: 10px; max-width: 56%; }
  /* B1：类型筛选 chips 单行横向滚动，不再全宽换行占半屏 */
  .ft-chips {
    order: 3;
    flex-basis: 100%;
    flex-wrap: nowrap;
    overflow-x: auto;
    padding-bottom: 3px;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
  }
  .ft-chips::-webkit-scrollbar { display: none; }
  .ft-search { max-width: none; width: 100%; }
  .ev-row {
    grid-template-columns: 1fr auto auto;
    grid-template-areas:
      'player time type'
      'detail detail detail';
    gap: 5px 8px;
    padding: 9px 10px;
    border: 1px solid var(--border-soft);
    border-radius: var(--radius);
    margin-bottom: 7px;
    background: var(--surface);
  }
  /* 第一行：玩家(左) ｜ 日期单行(中) ｜ 类型(右) */
  .c-time { grid-area: time; align-self: center; white-space: nowrap; font-size: 12px; }
  .c-type { grid-area: type; justify-self: end; align-self: center; }
  .c-player { grid-area: player; align-self: center; min-width: 0; }
  /* 第二行：详情全宽 */
  .c-detail { grid-area: detail; padding-top: 3px; border-top: 1px dashed var(--border-soft); }
  /* 移动端禁用展开：隐藏 chevron、去掉手型与展开高亮 */
  .ev-chev { display: none !important; }
  .ev-row { cursor: default; }
  .ev-row.open { background: var(--surface); box-shadow: none; }
}
</style>
