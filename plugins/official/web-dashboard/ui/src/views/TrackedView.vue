<script setup>
import { ref, onMounted, computed, onUnmounted } from 'vue';
import { get, post } from '../api.js';
import { time, date, dateTime, avatarLabel , reltime, statusLabels, trustColor, platformIcon, platformLabel } from '../utils.js';
import { statusColor } from '../composables/useFriendGroups.js';
import { openUser } from '../store.js';
import { toast } from '../toast.js';

// 非好友追踪（VRCX-Luo 对齐）：历史非好友 + 手动添加追踪的用户，
// 服务端每小时拉取资料/头像并记录 bio/status 变化（events 表 friend-update + source=poll）。
// 列表卡片 + 展开变化时间线（前后值对比）+ 添加/移除管理。
const items = ref(null);
const q = ref('');
const loading = ref(false);
const expanded = ref('');
const changesMap = ref({});
const loadingChanges = ref('');
const refreshing = ref(false);

// ── 添加追踪 ──
const addOpen = ref(false);
const addQuery = ref('');
const addResults = ref(null);
const addBusy = ref(false);
let addSeq = 0;
let addTimer = null;
let refreshTimer = null;   // 触发刷新后的延迟重载句柄：卸载必须清
async function searchUsers() {
  const query = addQuery.value.trim();
  const mySeq = ++addSeq;
  if (!query) { addResults.value = null; return; }
  addBusy.value = true;
  try {
    const r = await get('/api/dashboard/search?type=users&q=' + encodeURIComponent(query) + '&limit=8');
    if (mySeq !== addSeq) return;
    addResults.value = (r && r.results) || [];
  } catch (e) {
    if (mySeq === addSeq) { addResults.value = null; toast('搜索失败：' + (e.message || e), 'error'); }
  } finally {
    if (mySeq === addSeq) addBusy.value = false;
  }
}
function onAddInput() {
  clearTimeout(addTimer);
  addTimer = setTimeout(searchUsers, 500);
}
function isTracked(userId) {
  return (items.value || []).some((x) => x.userId === userId);
}
async function addTracked(user) {
  // 搜索接口统一返回 id 字段（dashboard/search 各类型同形），兼容旧 userId 字段
  const uid = user.id || user.userId;
  if (addBusy.value || !uid) return;
  addBusy.value = true;
  try {
    const r = await post('/api/dashboard/tracked', { userId: uid, displayName: user.name });
    if (r && r.error) throw new Error(r.error);
    toast(r.added ? `已添加追踪「${user.name}」，正在拉取资料…` : `「${user.name}」已在追踪列表中`, r.added ? 'success' : 'info');
    addOpen.value = false;
    addQuery.value = '';
    addResults.value = null;
    await load();
  } catch (e) {
    toast('添加失败：' + (e.message || e), 'error');
  } finally {
    addBusy.value = false;
  }
}

// 直接粘贴 userId 添加（搜索结果里找不到时用）
const directId = ref('');
const directBusy = ref(false);
async function addDirectId() {
  const id = directId.value.trim();
  if (!id || !id.startsWith('usr_')) { toast('请输入 usr_ 开头的用户 ID', 'warn'); return; }
  if (directBusy.value) return;
  directBusy.value = true;
  try {
    const r = await post('/api/dashboard/tracked', { userId: id });
    if (r && r.error) throw new Error(r.error);
    toast(r.added ? '已添加追踪（正在拉取资料…）' : '该用户已在追踪列表中', r.added ? 'success' : 'info');
    directId.value = '';
    addOpen.value = false;
    await load();
  } catch (e) {
    toast('添加失败：' + (e.message || e), 'error');
  } finally {
    directBusy.value = false;
  }
}


onUnmounted(() => { clearTimeout(addTimer); clearTimeout(refreshTimer); });

// ── 刷新 ──
async function refreshNow() {
  if (refreshing.value) return;
  refreshing.value = true;
  try {
    const r = await post('/api/dashboard/tracked/refresh');
    if (r && r.ok) {
      toast('已触发资料刷新（限流队列中，稍后自动更新列表）', 'info');
      refreshTimer = setTimeout(async () => { await load(); refreshing.value = false; }, 6000);
    } else {
      toast((r && r.error) || '刷新失败', 'error');
      refreshing.value = false;
    }
  } catch (e) {
    toast('刷新失败：' + (e.message || e), 'error');
    refreshing.value = false;
  }
}

async function load() {
  if (loading.value) return;
  loading.value = true;
  try {
    const r = await get('/api/dashboard/tracked?limit=500');
    items.value = (r && r.tracked) || [];
  } catch (e) {
    items.value = items.value || [];
    toast('加载非好友追踪失败：' + (e.message || e), 'error');
  } finally {
    loading.value = false;
  }
}

// 排序：在线优先（按 location 判定在游戏中），其次有变化的，最后按最近刷新倒序
function sortTracked(list) {
  const rank = (x) => {
    const online = isOnline(x.location);
    return (online ? 0 : 1) * 100 + (x.lastRefreshAt ? 0 : 1) * 10;
  };
  return [...list].sort((a, b) => rank(a) - rank(b) || String(b.lastRefreshAt || '').localeCompare(String(a.lastRefreshAt || '')));
}

const filtered = computed(() => {
  const query = q.value.trim().toLowerCase();
  const list = (items.value || []);
  const matched = query
    ? list.filter((x) => (x.displayName || '').toLowerCase().includes(query) || (x.userId || '').includes(query))
    : list;
  return sortTracked(matched);
});

const trackedCount = computed(() => (items.value || []).length);

const memoOf = (x) => String(x && x.memo || '').trim();

// 变化时间线类型筛选（全部/头像/简介/状态）
const changeFilter = ref('all');
const CHANGE_TYPES = [
  { v: 'all', l: '全部' },
  { v: 'avatar', l: '头像' },
  { v: 'bio', l: '简介' },
  { v: 'status', l: '状态' },
  { v: 'location', l: '位置' },
];
const filteredChanges = (userId) => {
  const cs = changesMap.value[userId] || [];
  if (changeFilter.value === 'all') return cs;
  return cs.filter((c) => c.type === changeFilter.value);
};

function fmtRefresh(s) {
  if (!s) return '从未刷新';
  return time(s) + ' ' + date(s);
}

// 最近一次真实资料变更时间（非检测/刷新时间）：展开时用已加载的变化时间线最新一条；
// 折叠时用后端 trackedNonFriends 返回的 lastChangeAt（events 表 friend-update/source=poll 的 MAX）。
// 不回退到 lastRefreshAt——那是"上次检测"时间，语义不同（用户 2026-09-01 修正）。
const lastChangeAt = (x) => {
  const cs = changesMap.value[x.userId];
  if (cs && cs.length && cs[0].createdAt) return cs[0].createdAt;
  return x.lastChangeAt || '';
};

const CHANGE_LABEL = { bio: '简介变更', status: '状态变更', avatar: '头像更新', user_icon: '头像图标更新', pronouns: '代词更新', trust_level: '等级变更', displayName: '改名', location: '位置/上下线' };
// 位置可读化：offline=离线 / offline:offline=网页在线 / traveling=传送中 / wrld_xxx=世界（世界名在 c.worldName 里附加）
const locLabel = (l) => { const v = String(l || ''); if (!v || v === 'offline') return '离线'; if (v === 'offline:offline') return '网页在线'; if (v === 'traveling') return '传送中'; return v; };
const statusText = (s) => statusLabels[s] || s || '—';
// 状态圆点颜色（对齐好友页视觉）：在线系绿色，离线灰色
function statusDotStyle(loc) {
  // 2026-09-22 用户报「状态那行被缩进、圆点看不见」✗：原来用的 var(--border-strong) **项目里没有这个令牌** ✗
  // ⇒ 背景无效 ⇒ 圆点透明但照样占 8px+间隙 ⇒ 文字看着被缩进 ✓。改用项目真实令牌（与好友页同色系 ✓）。
  return { background: isOnline(loc) ? 'var(--ok)' : 'var(--text-dim)' };
}
// 真实在线判定：只看 location（status 是用户偏好，离线保留）。offline=真离线、offline:offline=网页在线不在世界、traveling=转场，均不算在游戏中。
const isOnline = (loc) => {
  const v = String(loc || '').trim().toLowerCase();
  return v !== '' && !['offline', 'offline:offline', 'traveling'].includes(v);
};

function toggle(userId) {
  if (expanded.value === userId) {
    expanded.value = '';
    return;
  }
  expanded.value = userId;
  if (!changesMap.value[userId]) loadChanges(userId);
}

async function loadChanges(userId) {
  if (loadingChanges.value) return;
  loadingChanges.value = userId;
  try {
    const r = await get(`/api/dashboard/tracked-changes?userId=${encodeURIComponent(userId)}&limit=30`);
    changesMap.value = { ...changesMap.value, [userId]: (r && r.changes) || [] };
  } catch (e) {
    changesMap.value = { ...changesMap.value, [userId]: [] };
    toast('加载变化历史失败：' + (e.message || e), 'error');
  } finally {
    loadingChanges.value = '';
  }
}

onMounted(load);
</script>

<template>
  <div class="tk">
    <div class="tk-head">
      <div class="tk-title">
        <h2><i class="pi pi-eye"></i> 非好友追踪</h2>
        <span class="tk-count">{{ trackedCount }} 人 · 每小时自动刷新资料，记录 bio/状态/头像变化</span>
      </div>
      <div class="tk-tools">
        <InputText v-model="q" placeholder="搜索昵称 / ID…" class="tk-search" aria-label="搜索追踪用户" />
        <Button size="small" :icon="addOpen ? 'pi pi-times' : 'pi pi-user-plus'" :label="addOpen ? '收起' : '添加追踪'" :severity="addOpen ? 'secondary' : undefined" @click="addOpen = !addOpen" />
        <Button size="small" icon="pi pi-sync" :loading="refreshing" label="立即刷新" title="手动触发全部追踪用户资料刷新（限流队列执行）" @click="refreshNow" />
        <Button size="small" text icon="pi pi-refresh" title="刷新列表" @click="load" aria-label="刷新列表" />
      </div>
    </div>

    <!-- 添加追踪面板 -->
    <div v-if="addOpen" class="tk-add">
      <div class="tk-addbox">
        <div class="ta-inputrow">
          <i class="pi pi-search"></i>
          <input v-model="addQuery" class="ta-input" placeholder="搜索用户名 / ID，选择要追踪的用户…" aria-label="搜索要追踪的用户"
            @input="onAddInput" @keydown.enter="searchUsers" />
          <i v-if="addBusy" class="pi pi-spin pi-spinner"></i>
        </div>
        <div v-if="addResults === null" class="ta-hint">输入至少一个字符搜索 VRChat 用户；搜索结果点击「追踪」即加入（加入后立即拉取资料快照）。</div>
        <div v-else-if="!addResults.length" class="ta-hint">无匹配用户，试试其他关键词。</div>
        <div v-else class="ta-results">
          <div v-for="u in addResults" :key="u.id" class="ta-row">
            <Avatar :image="u.image || ''" :label="avatarLabel(u.image, u.name)" shape="circle" size="large" />
            <div class="ta-info">
              <b class="ta-name">{{ u.name }}</b>
              <small class="ta-sub">{{ u.id }}{{ u.sub ? ' · ' + u.sub : '' }}</small>
            </div>
            <Button v-if="isTracked(u.id)" size="small" text disabled label="已追踪" />
            <Button v-else size="small" label="追踪" icon="pi pi-plus" @click="addTracked(u)" />
          </div>
        </div>
        <div class="ta-direct">
          <span class="ta-dlabel">或直接粘贴 ID</span>
          <input v-model="directId" class="ta-input" placeholder="usr_xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" aria-label="直接粘贴用户 ID" @keydown.enter="addDirectId" />
          <Button size="small" :loading="directBusy" label="添加" @click="addDirectId" />
        </div>
      </div>
    </div>

    <div v-if="items === null" class="loading-mini"><ProgressSpinner style="width:28px;height:28px" strokeWidth="4" /></div>
    <div v-else-if="!filtered.length" class="empty" style="padding:24px">
        <i class="pi pi-eye empty-icon" aria-hidden="true"></i>
      {{ q ? '无匹配的追踪用户' : '暂无追踪用户——好友动态中出现过的非好友会自动加入，也可点「添加追踪」手动指定' }}
    </div>
    <div v-else class="tk-list">
      <div v-for="x in filtered" :key="x.userId" class="tk-item">
        <!-- 2026-09-22：由 button 改为 div[role=button] —— 用户要求「资料/移除」放到本行末尾，而 button 内不能嵌套 button ✗（动态流页同做法）-->
        <!-- 2026-09-22 用户：「先把这一页按好友页的样式统一」✓ —— 行结构与样式对齐 FriendsView 的 .friend-card：
             Avatar + .fc-text（名字 → 备注 → uid/状态 → 最近变化·上次检测），动作区右推在本行末尾 ✓ -->
        <!-- 2026-09-22 用户：把好友页的整个样式抄过来 ✓；多出来的信息与按钮**先不加** ✓（由用户决定怎么加）
             因此本卡＝好友页 .friend-card 的等价物：头像 + 名字 + 备注 + 状态；**展开入口保留**（2026-10-16 审查 🔴1 恢复），
             资料/移除入口迁到 UserDialog（卡片内不再放这两个按钮）✓ -->
        <div class="friend-card" v-clickable="(e) => (openUser(x.userId))" >
          <Avatar :image="x.avatarUrl || ''" :label="avatarLabel(x.avatarUrl, x.displayName)" shape="circle" />
          <div class="fc-text">
            <b :style="{ color: trustColor(x.trustLevel) }" :title="x.trustLevel ? ('信任等级：' + x.trustLevel) : ''">{{ x.displayName || x.userId }}</b><!-- 2026-09-22：非好友现在也有信任等级了（来自 tags ✓）⇒ 名字配色自动生效 ✓ + 悬停可看等级名 ✓（与好友页口径一致 ✓）-->
            <small><span class="fc-dot" :style="statusDotStyle(x.location)"></span>{{ x.statusDescription || statusText(x.status) }}<i v-if="platformIcon(x.platform)" class="pi fc-plat" :class="platformIcon(x.platform)" :title="platformLabel(x.platform)"></i><!-- 2026-09-22 用户报「平台图标是乱码」✗：漏了 pi（图标字体基础类）与 fc-plat（尺寸样式）⇒ 渲染成豆腐块 ✓；现与好友页写法完全一致 ✓ --></small>
            <small v-if="memoOf(x)" class="fc-memo" :title="memoOf(x)">{{ memoOf(x) }}</small>   <!-- 2026-09-22 用户：备注行放到在线行下面 ✓ -->
<small>
                          <span v-if="lastChangeAt(x)">变化 {{ reltime(lastChangeAt(x)) }}</span><!-- 2026-09-22 用户：卡片一行放不下「上次资料变化」⇒ 用短的「变化」✓（弹窗空间够，那边保留全称 ✓） -->
                          <span v-if="lastChangeAt(x) && x.lastRefreshAt">·</span>
                          <span v-if="x.lastRefreshAt">上次检测 {{ fmtRefresh(x.lastRefreshAt) }}</span>
                          <span v-if="!lastChangeAt(x) && !x.lastRefreshAt">暂无记录</span>
                        </small>
            
          </div>
                  <!-- 2026-10-16（审查 🔴1）：恢复展开入口 —— 卡片点击已改为「打开资料」，若不给展开留入口，`expanded` 永不置位 ⇒ 变化时间线与类型筛选（以及 /api/dashboard/tracked-changes）整体不可达 ✗ -->
          <Button class="tk-expand" size="small" text rounded
            :icon="expanded === x.userId ? 'pi pi-chevron-up' : 'pi pi-chevron-down'"
            :title="expanded === x.userId ? '收起变化历史' : '展开变化历史'"
            :aria-label="expanded === x.userId ? '收起变化历史' : '展开变化历史'"
            @click.stop="toggle(x.userId)" />
</div>
        <!-- 展开：变化时间线 -->
        <div v-if="expanded === x.userId" class="tk-detail">
          <div v-if="loadingChanges === x.userId" class="loading-mini"><ProgressSpinner style="width:22px;height:22px" strokeWidth="4" /></div>
          <div v-else-if="!(changesMap[x.userId] || []).length" class="tk-empty">暂无资料变化记录（bio/状态稳定，或尚未开始每小时快照）</div>
          <div v-else-if="!filteredChanges(x.userId).length" class="tk-empty">该类型暂无变化记录</div>
          <div v-else>
            <div class="tc-filters" role="group" aria-label="变化类型筛选">
              <button v-for="t in CHANGE_TYPES" :key="t.v" class="chip tc-chip" :class="{ active: changeFilter === t.v }" @click="changeFilter = t.v">{{ t.l }}</button>
            </div>
            <div v-if="filteredChanges(x.userId).length" class="tk-timeline">
            <div v-for="c in filteredChanges(x.userId)" :key="c.eventId" class="tk-change">
              <div class="tc-rail">
                <span class="tc-time mono" :title="dateTime(c.createdAt)">{{ time(c.createdAt) }}</span>
                <small class="tc-date">{{ date(c.createdAt) }}</small>
              </div>
              <div class="tc-card">
                <Tag :value="CHANGE_LABEL[c.type] || c.type || '资料变化'" severity="info" rounded />
                <div class="tc-body">
                  <template v-if="c.type === 'avatar'">
                    <div class="tc-avatars">
                      <div class="tc-avpair">
                        <img v-if="c.previousAvatarImageUrl" :src="c.previousAvatarImageUrl" class="tc-av" alt="旧头像" loading="lazy" />
                        <span v-else class="tc-av tc-avnone">无</span>
                        <small class="tc-avlabel">旧</small>
                      </div>
                      <i class="pi pi-arrow-right tc-avarrow"></i>
                      <div class="tc-avpair">
                        <img v-if="c.avatarImageUrl" :src="c.avatarImageUrl" class="tc-av" alt="新头像" loading="lazy" />
                        <span v-else class="tc-av tc-avnone">无</span>
                        <small class="tc-avlabel">新</small>
                      </div>
                    </div>
                  </template>
                  <template v-else-if="c.type === 'bio'">
                    <span v-if="c.previousBio" class="tc-old" :title="c.previousBio">旧：{{ c.previousBio }}</span>
                    <span class="tc-new" :title="c.bio">新：{{ c.bio || '（已清空）' }}</span>
                  </template>
                  <template v-else-if="c.type === 'status'">
                    <!-- 对齐动态页状态灯样式：[旧灯]→[新灯] 新签名（种类未变时只显新灯；旧种类/旧签名在灯 title） -->
                    <span class="tc-statusrow">
                      <template v-if="c.previousStatus && c.previousStatus !== c.status">
                        <span class="tc-slamp" :style="{ background: statusColor(c.previousStatus) }" :title="'旧：' + statusText(c.previousStatus) + (c.previousStatusDescription ? ' · ' + c.previousStatusDescription : '')"></span>
                        <span class="tc-sarr">→</span>
                      </template>
                      <span class="tc-slamp" :style="{ background: statusColor(c.status) }" :title="'新：' + statusText(c.status)"></span>
                      <span v-if="c.statusDescription" class="tc-sdesc" :title="c.statusDescription">{{ c.statusDescription }}</span>
                      <span v-else-if="c.status" class="tc-sdesc dim">{{ statusText(c.status) }}</span>
                    </span>
                  </template>
                  <template v-else-if="c.type === 'location'">
                    <span class="tc-old">旧：{{ locLabel(c.previousLocation) }}</span>
                    <span class="tc-new">新：{{ locLabel(c.location) }}{{ c.worldName ? '（' + c.worldName + '）' : '' }}</span>
                  </template>
                  <span v-else class="tc-new">{{ JSON.stringify(c).slice(0, 120) }}</span>
                </div>
              </div>
            </div>
            </div>
            </div>
          </div>
        </div>
      </div>
    </div>


</template>

<style scoped>
.tk { padding: 4px; }
.tk-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
.tk-title h2 { font-size: 15px; font-weight: 700; margin: 0 0 2px; }
.tk-count { font-size: 11px; color: var(--text-dim); }
.tk-tools { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.tk-search { width: 170px; }

/* 添加追踪面板 */
.tk-add { margin-bottom: 12px; }
.tk-addbox { background: var(--surface-2); border: 1px solid var(--border); border-radius: 12px; padding: 10px 12px; }
.ta-inputrow { display: flex; align-items: center; gap: 8px; border-bottom: 1px solid var(--border); padding-bottom: 8px; }
.ta-inputrow i { color: var(--text-dim); }
.ta-hint { font-size: 12px; color: var(--text-dim); padding: 8px 2px; }
.ta-direct { display: flex; align-items: center; gap: 8px; margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--border); }
.ta-dlabel { font-size: 11px; color: var(--text-dim); flex: none; }
.ta-results { display: flex; flex-direction: column; gap: 3px; margin-top: 8px; max-height: 240px; overflow-y: auto; }
.ta-row { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: 8px; }
.ta-row:hover { background: var(--surface-3); }
.ta-info { min-width: 0; flex: 1; }
.ta-name { font-size: 13px; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ta-sub { font-size: 11px; color: var(--text-dim); display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.tk-item { display: flex; flex-direction: column; gap: 3px; }

.tk-detail { background: var(--surface-2); border: 1px solid var(--border-soft); border-radius: 10px; padding: 10px 12px; margin-left: 34px; }
.tk-empty { font-size: 12px; color: var(--text-dim); padding: 6px 2px; }
.tc-filters { display: flex; gap: 5px; margin-bottom: 8px; flex-wrap: wrap; }
.tc-chip { padding: 4px 12px; font-size: 12px; height: 32px; }
.tk-timeline { display: flex; flex-direction: column; gap: 8px; max-height: 360px; overflow-y: auto; }
.tk-change { display: flex; gap: 10px; }
.tc-rail { flex: none; width: 74px; display: flex; flex-direction: column; align-items: flex-end; padding-top: 2px; }
.tc-time { font-size: 11px; color: var(--text); font-weight: 600; }
.tc-date { font-size: 9px; color: var(--text-dim); }
.tc-card { min-width: 0; flex: 1; background: var(--surface); border: 1px solid var(--border-soft); border-radius: 8px; padding: 7px 9px; }
.tc-body { margin-top: 5px; display: flex; flex-direction: column; gap: 3px; }
/* 状态变更行：对齐动态页（FeedView）状态灯视觉，横排 [旧灯]→[新灯] 签名 */
.tc-avatars { display: flex; align-items: center; gap: 8px; }
.tc-avpair { display: flex; flex-direction: column; align-items: center; gap: 2px; }
.tc-av { width: 42px; height: 42px; border-radius: 8px; object-fit: cover; }
.tc-avnone { display: flex; align-items: center; justify-content: center; background: var(--surface-2); font-size: 10px; color: var(--text-dim); }
.tc-avlabel { font-size: 10px; color: var(--text-dim); }
.tc-avarrow { color: var(--text-dim); font-size: 11px; }

.loading-mini { display: flex; justify-content: center; padding: 12px; }
@media (max-width: 899px) {
  .tk-search { width: 100%; order: 2; }
  .tk-tools { order: 3; }
  .tk-detail { margin-left: 0; }
  /* 2026-10-16 审查 ⚠️1：这条来自 main（原第 495 行），本轮重构时漏还原 ⇒ 窄屏下长 bio/状态旧值
     从「换行」退化成「单行省略号截断」= 信息可见性下降，已还原 ✓ */
  .tc-old, .tc-new { white-space: normal; }
}

/* ── tk-polish-2026-09-22（用户："非好友追踪这个界面是不是太丑了"）────────────────
   只加样式、不动结构：修「筛选 chip 被挤成孤字」「详情内容贴左留白」「时间列不对齐」「头像对尺寸不一」。
   全部使用项目令牌（--surface/--border-soft/--text/--text-dim）✓ 不引入新颜色 ✓ */
/* 1) 筛选 chip 行：允许换行、均匀间距，避免「头像」被拆成孤字 */
.tc-filters { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.tc-chip { white-space: nowrap; }
.tk-expand { flex: none; margin-left: auto; }
/* 2026-10-16（审查 3）：.tk-expand 就在 Button 根元素上 ⇒ 后代选择器匹配不到自身 ✓ */
.tk-expand.p-button { padding: 2px 6px; }
/* 2) 时间列：等宽数字 + 稍宽，时间与内容对齐 */
.tc-rail { width: 86px; font-variant-numeric: tabular-nums; }
.tc-rail b, .tc-rail strong { font-size: 12.5px; color: var(--text); }
.tc-date { font-size: 10px; color: var(--text-dim); }
/* 3) 内容列：占满剩余宽度、正文用主文本色（旧值仍为 dim + 删除线）*/
.tc-body { flex: 1; min-width: 0; color: var(--text); }
.tc-body > * { min-width: 0; }
/* 4) 头像对：统一 24px 圆角，与全站 .av-thumb 一致 */
.tc-av { width: 24px; height: 24px; border-radius: 6px; object-fit: cover; border: 1px solid var(--border-soft); }
.tc-avnone { display: inline-flex; align-items: center; justify-content: center; font-size: 10px; color: var(--text-dim); }
.tc-avlabel { font-size: 9px; color: var(--text-dim); }
/* 5) 卡片：与其它列表一致的分隔与悬停反馈 */
.tc-card { border: 1px solid var(--border-soft); border-radius: var(--radius); }
.tc-card:hover { border-color: var(--border); }

/* ── tk-grid-2026-09-22（用户：「PC 端你不觉得一条太长了吗？」）────────────────
   宽屏改为多列卡片网格：一屏 2 列（≥1200px）/ 3 列（≥1700px），窄屏保持 1 列。
   展开的详情用 :has() 自动占满整行（Chromium 支持 ✓），避免详情被挤在 570px 里。*/
/* 2026-09-22 用户：与好友页**同一套网格**（.fg-body 同款 auto-fill minmax(240px,1fr) ⇒ 宽屏约 5 个/行 ✓）*/
/* 2026-09-22 用户：有备注和没备注的块高度不一样 ✗ => 去掉我自加的 align-items:start，
   与好友页 .fg-body 完全一致（默认 stretch = 同一行卡片自动等高 ✓）*/
.tk-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 6px; }
/* 2026-10-16（审查 2）：原写法引用已消失的 .tk-row.open ⇒ 永不命中、展开详情被挤在单列；改为按 .tk-detail 命中 ✓ */
.tk-item:has(.tk-detail) { grid-column: 1 / -1; }

/* ── tk-sub-oneline-2026-09-22（用户：「最近变化和上次检测可以放到一行吧？」）───────────
   元信息强制单行、超出省略；动作按钮随行尾对齐 ✓ */

/* ── friend-page-2026-09-22（用户：「先按好友页的样式统一」）──────────────────
   以下 6 条与 FriendsView.vue:242-258 **完全一致**（同变量同数值 ✓），仅作用域在本组件 ✓ */
.friend-card { display: flex; align-items: center; gap: 10px; padding: 8px 10px; background: var(--surface); border: 1px solid var(--border-soft); border-radius: var(--radius); cursor: pointer; transition: background 0.12s, border-color 0.12s; }
.friend-card:hover { background: var(--surface-2); border-color: var(--border); }
.fc-text { min-width: 0; flex: 1; }
.fc-text b { display: block; font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fc-text small { color: var(--text-dim); font-size: 11px; display: flex; align-items: center; gap: 5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fc-memo { display: block; font-size: 10px; color: var(--accent); opacity: 0.85; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; cursor: pointer; }
/* 增量：动作区右推（好友页卡内没有动作按钮 ✓）*/
/* ==== 以下样式整块抄自 FriendsView（用户 2026-09-22 要求「整个样式都抄过来」） ==== */

/* 搜索框与右侧好友栏搜索统一 32px；几何全写死不随字体加载伸缩 */
.fc-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; transform: translateY(1px); }
.fc-plat {
  flex: none;
  font-size: 10px;
  color: var(--text-dim);
  line-height: 1;
  cursor: help;
}
.fc-plat:hover { color: var(--text); }
@media (max-width: 899px) {
  .friend-card { padding: 10px 11px; }
  .fc-text b { font-size: 13px; }
  .fc-text small { font-size: 11.5px; }
}


/* 2026-09-22 用户：有备注和没备注的块高度不一样 ✗
   网格项 .tk-item 会被 stretch 拉齐 ✓，但项内的卡片不跟着撑满 ✗ ⇒ 补这几条：
   让 .tk-item 变成等高列、卡片 height:100% 填满 ✓（等价于"同排卡片一样高"✓） */
.tk-list > .tk-item { display: flex; flex-direction: column; }
.tk-list > .tk-item > .friend-card { height: 100%; }


/* 2026-10-16（审查 1 修正）：机械清理时误删了这些**仍被模板引用**的定义（.tc-slamp / .tc-sdesc / .tc-old / .tc-new / .tc-statusrow / .tc-sarr）⇒ 从 main 原样还原。教训：「已用类」的提取必须覆盖动态来源 ✓ */
.tc-slamp { width: 12px; height: 12px; border-radius: 50%; display: inline-block; flex: none; box-shadow: 0 0 0 2px color-mix(in srgb, currentColor 12%, transparent); border: 1.5px solid rgba(0,0,0,0.35); }
.tc-sdesc { color: var(--text); font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tc-sdesc.dim { color: var(--text-dim); font-weight: 400; }
.tc-old { color: var(--text-dim); text-decoration: line-through; opacity: 0.75; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tc-new { color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tc-statusrow { display: flex; align-items: center; gap: 6px; min-width: 0; }
.tc-sarr { color: var(--text-dim); font-size: 11px; flex: none; }
</style>
