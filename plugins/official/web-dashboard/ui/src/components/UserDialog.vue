<script setup>
import { ref, computed, watch } from 'vue';
import { store, closeUser, openWorld, openGroup, copyText, openPreview, toggleWatch } from '../store.js';
import { get, post } from '../api.js';
import { trustColor, trustName, locLabelFull, statusLabels, fmtMin, time, date, avatarLabel } from '../utils.js';
import { toast } from '../toast.js';
import TrustBadge from './TrustBadge.vue';

const visible = computed({
  get: () => !!store.userModal,
  set: (v) => { if (!v) closeUser(); },
});

const user = computed(() => store.userModal || {});
// 非好友（不在本地好友列表）→ 简化弹窗：隐藏依赖他人 API 的 tab（共同好友/群组/世界/模型可能 403/受限）
// 自己不算"非好友"：自己不在 friends 表（不是自己的好友），但 VRChat 允许查自己的群组/世界/模型 → 自己也按好友展示
const isFriend = computed(() => !!(store.friends || []).find((f) => f.userId === user.value.userId)
  || (store.me && store.me.userId === user.value.userId));
const activeTab = ref('info');
const profile = ref(null);   // /api/dashboard/user-profile 聚合结果
const loading = ref(false);
const error = ref('');
const events = ref(null);
// 该用户收藏世界总数（profile.favoriteWorlds 各分组世界总和；VRChat 公开收藏经 ownerId 查询）
const favTotal = computed(() => (profile.value && Array.isArray(profile.value.favoriteWorlds)
  ? profile.value.favoriteWorlds.reduce((s, g) => s + (g.worlds ? g.worlds.length : 0), 0) : 0));
function favVisColor(v) {
  if (v === 'public') return 'var(--ok)';
  if (v === 'friends') return 'var(--info)';
  return 'var(--warn)';
}
function favVisLabel(v) {
  return v === 'public' ? '公开' : v === 'friends' ? '好友可见' : '私密';
}

const STATUS_COLORS = { active: '#52c41a', 'join me': '#4287f5', 'ask me': '#fa8c16', busy: '#f5222d', offline: '#596778' };

// ── 派生数据 ──
const pUser = computed(() => (profile.value && profile.value.user) || {});
const pStats = computed(() => (profile.value && profile.value.stats) || {});
const pLocal = computed(() => (profile.value && profile.value.localFriend) || {});

const displayName = computed(() => user.value.displayName || pUser.value.displayName || '?');

// 收藏好友（favorite-add/remove type=friend；store.favFriendIds 驱动）
const isFavFriend = computed(() => user.value.userId && store.favFriendIds.has(user.value.userId));
let favBusy = false;
async function onToggleFavFriend() {
  if (favBusy || !user.value.userId || !isFriend.value) return;
  favBusy = true;
  try {
    if (isFavFriend.value) {
      const r = await post('/api/dashboard/favorite-remove', { type: 'friend', id: user.value.userId });
      if (r && r.ok) {
        store.favFriendIds = new Set([...store.favFriendIds].filter((x) => x !== user.value.userId));
        toast('已取消收藏好友', 'success');
      } else toast((r && r.error) || '取消失败', 'error');
    } else {
      const r = await post('/api/dashboard/favorite-add', { type: 'friend', id: user.value.userId });
      if (r && r.ok) {
        store.favFriendIds = new Set([...store.favFriendIds, user.value.userId]);
        toast('已收藏好友', 'success');
      } else toast((r && r.error) || '收藏失败', 'error');
    }
  } catch (e) {
    toast('操作失败：' + (e.message || e), 'error');
  } finally {
    favBusy = false;
  }
}

// 非好友追踪：资料弹窗可直接追踪/取消（非好友时显示；复用 /api/dashboard/tracked）
const isTrackedUser = computed(() => store.trackedIds.has(user.value.userId));
let trackBusy = false;
async function onToggleTracked() {
  if (trackBusy || !user.value.userId || isFriend.value) return;
  trackBusy = true;
  try {
    if (isTrackedUser.value) {
      const r = await post('/api/dashboard/tracked/remove', { userId: user.value.userId });
      if (r && r.error) throw new Error(r.error);
      store.trackedIds = new Set([...store.trackedIds].filter((x) => x !== user.value.userId));
      toast('已移除追踪', 'success');
    } else {
      const r = await post('/api/dashboard/tracked', { userId: user.value.userId, displayName: user.value.displayName || '' });
      if (r && r.error) throw new Error(r.error);
      store.trackedIds = new Set([...store.trackedIds, user.value.userId]);
      toast('已添加追踪，正在拉取资料…', 'success');
    }
  } catch (e) {
    toast('操作失败：' + (e.message || e), 'error');
  } finally {
    trackBusy = false;
  }
}

// 关注名单（watchlist）：动态页「只看关注」联动
const isWatched = computed(() => store.watchlistIds.has(user.value.userId));
let watchBusy = false;
async function onToggleWatch() {
  if (watchBusy || !user.value.userId) return;
  watchBusy = true;
  try {
    const msg = await toggleWatch(user.value.userId, displayName.value || user.value.userId);
    if (msg) toast(msg, msg.includes('失败') ? 'error' : 'success');
  } finally {
    watchBusy = false;
  }
}
const avatarUrl = computed(() => user.value.avatarUrl || user.value.userIcon || pUser.value.currentAvatarThumbnailImageUrl || pUser.value.currentAvatarImageUrl || '');
const trustLevel = computed(() => {
  // 原始等级（本地记录优先，其次从 API tags 推断——对齐 VRCX computeTrustLevel 的 tag→名映射）
  const lt = pLocal.value.trustLevel;
  if (lt) return lt;
  const t = (pUser.value.tags || []).find((x) => String(x).startsWith('system_trust_'));
  if (!t) return '';
  return String(t);
});
// VRCX 风格英文名（Trusted User / Known User / User / New User / Visitor）
const trustNameText = computed(() => trustName(trustLevel.value));
const statusValue = computed(() => pUser.value.status || pLocal.value.status || '');
const statusText = computed(() => {
  if (pUser.value.statusDescription) return pUser.value.statusDescription;
  if (statusValue.value) return statusLabels[statusValue.value] || statusValue.value;
  return '离线';
});
const isOnline = computed(() => !!pLocal.value.isOnline || pUser.value.state === 'online');
const location = computed(() => pLocal.value.location || pUser.value.location || '');
const instanceName = computed(() => (isOnline.value && location.value && location.value.includes(':')) ? locLabelFull(location.value) : '');
const bio = computed(() => pUser.value.bio || pLocal.value.bio || '');
const onlineFriends = computed(() => pStats.value.onlineFriends || 0);

function fmtDur(ms) {
  if (!ms || ms <= 0) return '-';
  const m = Math.floor(ms / 60000);
  if (m < 1) return '不足 1 分钟';
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  return `${h} 小时 ${m % 60} 分钟`;
}
function ago(iso) {
  if (!iso) return '-';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时`;
  return `${Math.floor(diff / 86400000)} 天`;
}
function openAvatarImage(a) {
  if (a && (a.imageUrl || a.thumbnailImageUrl)) store.previewUrl = a.imageUrl || a.thumbnailImageUrl;
}

// ── 数据加载 ──
async function loadProfile() {
  if (!user.value.userId) return;
  loading.value = true;
  error.value = '';
  profile.value = null;
  try {
    const d = await get(`/api/dashboard/user-profile?userId=${encodeURIComponent(user.value.userId)}`, 60000);
    if (d && d.error) { error.value = String(d.error); }
    else profile.value = d || {};
  } catch (e) {
    error.value = '加载失败：' + (e.message || e);
  } finally {
    loading.value = false;
  }
}
async function loadEvents() {
  if (events.value || !user.value.userId) return;
  try {
    const d = await get(`/api/dashboard/friend-events?userId=${encodeURIComponent(user.value.userId)}&limit=20`);
    events.value = d.events || [];
  } catch { events.value = []; }
}
async function openJoin() {
  try {
    const d = await post('/api/dashboard/invite-request', { userId: user.value.userId });
    toast(d.ok ? '已发送加入请求' : (d.error || '发送失败'), d.ok ? 'success' : 'error');
  } catch {
    toast('发送请求失败', 'error');
  }
}

watch(activeTab, (t) => { if (t === 'activity') loadEvents(); });
watch(() => store.userModal, (v) => {
  if (v) {
    activeTab.value = 'info';
    events.value = null;
    loadProfile();
  }
});

function nameOf(u) { return store.nicknameMap[u.userId] || u.displayName || '?'; }
function eventTypeLabel(t) {
  const m = { 'friend-online': '上线', 'friend-offline': '离线', 'friend-location': '位置', 'friend-active': '状态', 'friend-update': '资料' };
  return m[t] || t;
}
const rawJson = computed(() => {
  if (!profile.value) return '';
  return JSON.stringify({ user: pUser.value, localFriend: pLocal.value, stats: pStats.value }, null, 2);
});
</script>

<template>
  <Dialog v-model:visible="visible" :style="{ width: 'min(720px, 95vw)' }" :dismissable-mask="true" :modal="true" :maximizable="!store.isMobile" :closeOnEscape="true">
    <template #header>
      <!-- 加载中：头部只转圈（单个），资料加载完一次性显示 -->
      <div v-if="loading" class="ud-head ud-head-loading">
        <ProgressSpinner style="width:28px;height:28px" strokeWidth="4" />
      </div>
      <div v-else class="ud-head">
        <Avatar :image="avatarUrl" shape="circle" size="xlarge" :label="avatarLabel(avatarUrl, displayName)" />
        <div class="ud-main">
          <div class="ud-name">
            <b :style="{ color: trustColor(trustLevel) }">{{ displayName }}</b>
            <TrustBadge v-if="trustNameText" :level="trustNameText" />
            <span v-if="onlineFriends" class="ud-online" :title="'在线好友数'"><i class="pi pi-users"></i>{{ onlineFriends }}</span>
          </div>
          <div class="ud-status">
            <span class="ud-dot" :style="{ background: STATUS_COLORS[statusValue] || '#596778' }"></span>
            <span>{{ statusText }}</span>
            <span v-if="instanceName" class="text-dim"> · {{ instanceName }}</span>
            <span v-else-if="!isOnline" class="text-dim"> · 离线</span>
          </div>
          <div v-if="profile && profile.representedGroup" class="ud-repgroup link" @click="openGroup(profile.representedGroup.id)" :title="'查看群组'">
            <i class="pi pi-shield"></i>展示群组：{{ profile.representedGroup.name }} ({{ profile.representedGroup.memberCount }})
          </div>
        </div>
      </div>
    </template>

    <div v-if="error" class="empty" style="padding:20px">{{ error }}</div>

    <Tabs v-else-if="profile" v-model:value="activeTab" :scrollable="true">
      <TabList>
        <Tab value="info">信息</Tab>
        <Tab v-if="isFriend" value="mutual">共同好友<span v-if="profile.mutualFriendCount"> ({{ profile.mutualFriendCount }})</span></Tab>
        <Tab v-if="isFriend" value="groups">群组<span v-if="profile.groups.length"> ({{ profile.groups.length }})</span></Tab>
        <Tab v-if="isFriend" value="worlds">创建的世界<span v-if="profile.worlds.length"> ({{ profile.worlds.length }})</span></Tab>
        <Tab value="favworlds">收藏的世界<span v-if="favTotal"> ({{ favTotal }})</span></Tab>
        <Tab v-if="isFriend" value="avatars">创建的模型<span v-if="profile.avatars.length"> ({{ profile.avatars.length }})</span></Tab>
        <Tab value="activity">活动记录</Tab>
        <Tab value="json">原始 JSON</Tab>
      </TabList>
      <TabPanels>
        <!-- 信息 -->
        <TabPanel value="info">
          <div v-if="!isFriend" class="ud-note"><i class="pi pi-info-circle"></i> 非好友 · 共同好友 / 群组 / 世界 / 模型信息不可见</div>
          <div v-if="isOnline && instanceName" class="ud-loc">
            <i class="pi pi-map-marker"></i>
            <span class="link" @click="openWorld(user.worldId || '')">{{ instanceName }}</span>
            <span v-if="pStats.currentOnlineMs" class="text-dim"> · 本次在线 {{ fmtDur(pStats.currentOnlineMs) }}</span>
          </div>
          <div v-if="bio" class="bio">{{ bio }}</div>
          <div class="facts">
            <div class="fact"><span>正在使用的模型</span><span v-if="profile.avatarName" class="link" :title="'点击放大查看：' + profile.avatarName" @click="openPreview(pUser.currentAvatarImageUrl || pUser.currentAvatarThumbnailImageUrl || '')">{{ profile.avatarName }}</span><span v-else>—</span></div>
            <div class="fact"><span>最后见面时间</span><span>{{ pStats.lastMeet ? date(pStats.lastMeet) + ' ' + time(pStats.lastMeet) : '-' }}</span></div>
            <div class="fact"><span>见面的次数</span><span>{{ pStats.meetCount }}</span></div>
            <div class="fact"><span>一起游玩的时长</span><span>{{ fmtDur(pStats.timeSpentMs) }}</span></div>
            <div class="fact"><span>本次在线时长</span><span>{{ fmtDur(pStats.currentOnlineMs) }}</span></div>
            <div class="fact"><span>最后活动时间</span><span>{{ ago(pStats.lastActivity) }}</span></div>
            <div class="fact"><span>上线次数</span><span>{{ pStats.joinCount }}</span></div>
            <div class="fact"><span>账号创建日期</span><span>{{ pStats.dateJoined || '-' }}</span></div>
            <div class="fact"><span>添加为好友的时间</span><span>{{ pStats.dateFriended ? date(pStats.dateFriended) : '-' }}</span></div>
            <div class="fact"><span>是否允许克隆模型</span><span>{{ pStats.allowAvatarCopying ? '允许' : '不允许' }}</span></div>
            <div class="fact"><span>玩家 ID</span><span class="mono">{{ user.userId }}</span></div>
          </div>
          <div class="ud-actions">
            <Button v-if="isOnline" label="请求加入" icon="pi pi-send" size="small" @click="openJoin" />
            <Button label="复制 ID" icon="pi pi-copy" size="small" text @click="copyText(user.userId)" />
            <Button :label="isWatched ? '取消关注' : '关注'" :icon="isWatched ? 'pi pi-eye-slash' : 'pi pi-eye'"
              size="small" :text="!isWatched" :severity="isWatched ? 'danger' : undefined" @click="onToggleWatch" />
            <Button v-if="!isFriend" :label="isTrackedUser ? '取消追踪' : '追踪'" :icon="isTrackedUser ? 'pi pi-user-minus' : 'pi pi-user-plus'"
              size="small" :text="!isTrackedUser" :severity="isTrackedUser ? 'danger' : undefined" @click="onToggleTracked" />
            <Button v-if="isFriend" :label="isFavFriend ? '取消收藏' : '收藏好友'" :icon="isFavFriend ? 'pi pi-star-fill' : 'pi pi-star'"
              size="small" :text="!isFavFriend" :severity="isFavFriend ? 'warn' : undefined" @click="onToggleFavFriend" />
          </div>
        </TabPanel>

        <!-- 共同好友 -->
        <TabPanel value="mutual" v-if="isFriend">
          <div v-if="!profile.mutualFriends.length" class="empty" style="padding:16px">暂无共同好友</div>
          <div v-else class="mini-list">
            <div v-for="f in profile.mutualFriends" :key="f.id" class="mini-row" role="button" tabindex="0" @click="store.userModal = { userId: f.id, displayName: f.displayName, avatarUrl: f.avatarUrl }" @keydown.enter="store.userModal = { userId: f.id, displayName: f.displayName, avatarUrl: f.avatarUrl }">
              <Avatar :image="f.avatarUrl" shape="circle" size="small" :label="avatarLabel(f.avatarUrl, f.displayName)" />
              <span>{{ nameOf(f) }}</span>
            </div>
          </div>
        </TabPanel>

        <!-- 群组 -->
        <TabPanel value="groups" v-if="isFriend">
          <div v-if="!profile.groups.length" class="empty" style="padding:16px">暂未加入群组</div>
          <div v-else class="mini-list">
            <div v-for="g in profile.groups" :key="g.id" class="mini-row" role="button" tabindex="0" @click="openGroup(g.id)" @keydown.enter="openGroup(g.id)">
              <img v-if="g.iconUrl" :src="g.iconUrl" class="mini-thumb" alt="" loading="lazy" />
              <i v-else class="pi pi-users"></i>
              <span>{{ g.name }} <small class="text-dim">({{ g.memberCount }}人)</small></span>
              <Tag v-if="g.isRepresenting" value="展示" rounded severity="warn" />
            </div>
          </div>
        </TabPanel>

        <!-- 创建的世界 -->
        <TabPanel value="worlds" v-if="isFriend">
          <div v-if="!profile.worlds.length" class="empty" style="padding:16px">暂无创建的世界</div>
          <div v-else class="world-grid">
            <div v-for="w in profile.worlds" :key="w.id" class="world-card" role="button" tabindex="0" @click="openWorld(w.id)" @keydown.enter="openWorld(w.id)">
              <img v-if="w.imageUrl" :src="w.imageUrl" class="world-img" alt="" loading="lazy" />
              <div v-else class="world-img world-img-empty"><i class="pi pi-globe"></i></div>
              <div class="world-info">
                <b class="ellipsis" :title="w.name">{{ w.name }}</b>
                <div class="text-dim world-sub">
                  <span><i class="pi pi-heart"></i>{{ w.favorites }}</span>
                  <span><i class="pi pi-eye"></i>{{ w.visits }}</span>
                </div>
              </div>
            </div>
          </div>
        </TabPanel>

        <!-- 收藏的世界：该用户公开收藏（VRChat ownerId 查询，VRCX 同款） -->
        <TabPanel value="favworlds">
          <div v-if="!profile.favoriteWorlds || !profile.favoriteWorlds.length" class="empty" style="padding:16px">
            <i class="pi pi-lock"></i> 未公开收藏（VRChat 只返回公开/好友可见的收藏夹）
          </div>
          <div v-else>
            <div v-for="g in profile.favoriteWorlds" :key="g.name" class="fav-group">
              <div class="fav-group-head">
                <i class="pi pi-bookmark"></i>{{ g.name }}
                <span class="fav-vis" :style="{ color: favVisColor(g.visibility) }">
                  <i class="pi" :class="g.visibility === 'public' ? 'pi-globe' : g.visibility === 'friends' ? 'pi-users' : 'pi-lock'"></i>{{ favVisLabel(g.visibility) }}
                </span>
                <span class="fav-group-count">{{ g.worlds ? g.worlds.length : 0 }}</span>
              </div>
              <div class="world-grid">
                <div v-for="w in g.worlds" :key="w.worldId || w.name" class="world-card" role="button" tabindex="0" @click="openWorld(w.worldId)" @keydown.enter="openWorld(w.worldId)">
                  <img v-if="w.imageUrl" :src="w.imageUrl" class="world-img" alt="" loading="lazy" />
                  <div v-else class="world-img world-img-empty"><i class="pi pi-globe"></i></div>
                  <div class="world-info">
                    <b class="ellipsis" :title="w.name">{{ w.name }}</b>
                    <div class="text-dim world-sub">{{ w.authorName || '' }}</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </TabPanel>

        <!-- 创建的模型 -->
        <TabPanel value="avatars" v-if="isFriend">
          <div v-if="!profile.avatars.length" class="empty" style="padding:16px">暂无创建的模型（VRChat 对他人的模型列表有限制）</div>
          <div v-else class="world-grid">
            <div v-for="a in profile.avatars" :key="a.id" class="world-card" role="button" tabindex="0" @click="openAvatarImage(a)" @keydown.enter="openAvatarImage(a)">
              <img v-if="a.thumbnailImageUrl" :src="a.thumbnailImageUrl" class="world-img" alt="" loading="lazy" />
              <div v-else class="world-img world-img-empty"><i class="pi pi-user-edit"></i></div>
              <div class="world-info">
                <b class="ellipsis" :title="a.name">{{ a.name }}</b>
                <div class="text-dim world-sub">{{ a.releaseStatus || 'public' }}</div>
              </div>
            </div>
          </div>
        </TabPanel>

        <!-- 活动记录 -->
        <TabPanel value="activity">
          <div v-if="!events" class="loading-mini"><ProgressSpinner style="width:24px;height:24px" strokeWidth="4" /></div>
          <div v-else-if="!events.length" class="empty" style="padding:16px">暂无活动记录</div>
          <div v-else class="ev-list">
            <div v-for="e in events" :key="e.eventId" class="ev-item">
              <span class="mono ev-time">{{ date(e.createdAt) }} {{ time(e.createdAt) }}</span>
              <Tag :value="eventTypeLabel(e.type)" rounded severity="secondary" />
              <span class="ev-sum">{{ e.summary || '' }}<span v-if="e.worldName"> · {{ e.worldName }}</span></span>
            </div>
          </div>
        </TabPanel>

        <!-- 原始 JSON -->
        <TabPanel value="json">
          <div class="json-box">
            <Button icon="pi pi-copy" text size="small" rounded :aria-label="'复制 JSON'" @click="copyText(rawJson)" style="position:absolute;top:6px;right:6px" />
            <pre>{{ rawJson }}</pre>
          </div>
        </TabPanel>
      </TabPanels>
    </Tabs>
  </Dialog>
</template>

<style scoped>
.ud-head { display: flex; align-items: center; gap: 12px; width: 100%; min-width: 0; }
.ud-head-loading { gap: 10px; }
.ud-repgroup { display: inline-flex; align-items: center; gap: 5px; max-width: 100%; margin-top: 3px; font-size: 11px; color: var(--text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ud-repgroup .pi { font-size: 10px; flex: none; }
.ud-main { min-width: 0; flex: 1; }
.ud-name { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.ud-name b { font-size: 15px; }
.ud-online { display: inline-flex; align-items: center; gap: 3px; font-size: 11px; color: var(--text-dim); background: var(--surface-3); padding: 0 7px; border-radius: 10px; }
.ud-status { display: flex; align-items: center; gap: 5px; font-size: 12px; color: var(--text); margin-top: 2px; }
.ud-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; transform: translateY(0.5px); }
.link { color: var(--accent-2); cursor: pointer; }
.link:hover { text-decoration: underline; }
.ud-loc { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--text); margin-bottom: 10px; padding: 6px 10px; background: var(--surface-2); border-radius: 8px; }
.ud-note { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--warn); background: color-mix(in srgb, var(--warn) 10%, transparent); border: 1px solid color-mix(in srgb, var(--warn) 30%, transparent); border-radius: 8px; padding: 6px 10px; margin-bottom: 10px; }
.bio { font-size: 12.5px; color: var(--text-dim); background: var(--surface-2); border-radius: 8px; padding: 10px; white-space: pre-wrap; margin-bottom: 10px; }
.facts { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 18px; }
.fact { display: flex; justify-content: space-between; gap: 12px; font-size: 12.5px; padding: 4px 0; border-bottom: 1px dashed var(--border-soft); }
.fact span:first-child { color: var(--text-dim); flex: none; }
.fact span:last-child { text-align: right; word-break: break-all; }
.ud-actions { display: flex; gap: 8px; margin-top: 12px; }

.mini-list { display: flex; flex-direction: column; gap: 4px; }
.mini-row { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 6px; cursor: pointer; font-size: 12.5px; }
.mini-row:hover { background: var(--surface-2); }
.mini-thumb { width: 26px; height: 26px; object-fit: cover; border-radius: 6px; flex: none; }
.world-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
.fav-group { margin-bottom: 12px; }
.fav-group-head { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 700; color: var(--text-dim); margin-bottom: 6px; }
.fav-vis { display: inline-flex; align-items: center; gap: 3px; font-size: 10.5px; font-weight: 600; }
.fav-group-count { font-size: 10.5px; color: var(--text-dim); background: var(--surface-3); border-radius: 8px; padding: 0 7px; line-height: 15px; }
.world-card { background: var(--surface); border: 1px solid var(--border-soft); border-radius: 8px; overflow: hidden; cursor: pointer; transition: border-color 0.12s; }
.world-card:hover { border-color: var(--accent); }
.world-img { width: 100%; height: 84px; object-fit: cover; display: block; background: var(--surface-3); }
.world-img-empty { display: flex; align-items: center; justify-content: center; color: var(--text-dim); font-size: 20px; }
.world-info { padding: 6px 8px; }
.world-info b { display: block; font-size: 12px; }
.ellipsis { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.world-sub { display: flex; gap: 8px; font-size: 10.5px; margin-top: 2px; }
.world-sub span { display: inline-flex; align-items: center; gap: 3px; }
.ev-list { display: flex; flex-direction: column; gap: 6px; }
.ev-item { display: flex; align-items: center; gap: 8px; font-size: 12px; padding: 5px 0; border-bottom: 1px dashed var(--border-soft); }
.ev-time { color: var(--text-dim); font-size: 11px; flex: none; }
.ev-sum { flex: 1; min-width: 0; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.json-box { position: relative; }
.json-box pre { background: var(--surface-2); border-radius: 8px; padding: 12px; font-size: 11px; max-height: 420px; overflow: auto; white-space: pre-wrap; word-break: break-all; }
@media (max-width: 560px) {
  /* 移动端：信息项单列 + 行高加大，标签列对齐如两列观感 */
  .facts { grid-template-columns: 1fr; gap: 0; }
  .fact { padding: 8px 0; font-size: 13px; align-items: baseline; }
  .fact span:first-child { min-width: 92px; color: var(--text-dim); }
  .fact span:last-child { flex: 1; overflow-wrap: anywhere; }
  .ud-status { flex-wrap: wrap; }
  .ud-actions { flex-wrap: wrap; }
  .ev-item { flex-wrap: wrap; row-gap: 2px; }
}
</style>
