<script setup>
import { ref, onMounted, computed } from 'vue';
import { get, post } from '../api.js';
import { time, date, dateTime, avatarLabel , reltime } from '../utils.js';
import { openUser } from '../store.js';
import { toast } from '../toast.js';
import { confirm } from '../confirm.js';

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
  if (addBusy.value || !user.userId) return;
  addBusy.value = true;
  try {
    const r = await post('/api/dashboard/tracked', { userId: user.userId, displayName: user.name });
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

// ── 移除追踪 ──
async function removeTracked(x) {
    if (!await confirm({ message: `确认移除对「${x.displayName || x.userId}」的追踪？其变化历史保留，但不再自动刷新。`, header: '移除追踪', acceptLabel: '移除' })) return;
  try {
    const r = await post('/api/dashboard/tracked/remove', { userId: x.userId });
    if (r && r.error) throw new Error(r.error);
    toast('已移除追踪', 'success');
    await load();
  } catch (e) {
    toast('移除失败：' + (e.message || e), 'error');
  }
}

// ── 刷新 ──
async function refreshNow() {
  if (refreshing.value) return;
  refreshing.value = true;
  try {
    const r = await post('/api/dashboard/tracked/refresh');
    if (r && r.ok) {
      toast('已触发资料刷新（限流队列中，稍后自动更新列表）', 'info');
      setTimeout(async () => { await load(); refreshing.value = false; }, 6000);
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

// 排序：在线优先（active/joinme/askme/busy），其次有变化的，最后按最近刷新倒序
function sortTracked(list) {
  const rank = (x) => {
    const s = String(x.status || '').toLowerCase();
    const online = ['active', 'join me', 'ask me', 'busy'].some((k) => s.includes(k.split(' ')[0]));
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

// 变化时间线类型筛选（全部/头像/简介/状态）
const changeFilter = ref('all');
const CHANGE_TYPES = [
  { v: 'all', l: '全部' },
  { v: 'avatar', l: '头像' },
  { v: 'bio', l: '简介' },
  { v: 'status', l: '状态' },
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

const lastChangeAt = (x) => {
  const cs = changesMap.value[x.userId];
  if (cs && cs.length && cs[0].createdAt) return cs[0].createdAt;
  return x.lastRefreshAt || '';
};

const CHANGE_LABEL = { bio: '简介变更', status: '状态变更', avatar: '头像更新', user_icon: '头像图标更新', pronouns: '代词更新', displayName: '改名' };
const statusText = (s) => ({ active: '在线', 'join me': '加入我', 'ask me': '问我', busy: '忙碌', offline: '离线' }[s] || s || '—');
// 状态圆点颜色（对齐好友页视觉）：在线系绿色，离线灰色
function statusDotStyle(s) {
  const v = String(s || '').toLowerCase();
  const online = ['active', 'join me', 'ask me', 'busy'].some((k) => v.includes(k.split(' ')[0]));
  return { background: online ? '#52c41a' : v.includes('offline') ? 'var(--border-strong)' : 'var(--text-dim)' };
}
const isOnline = (s) => !['offline', ''].includes(String(s || ''));

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
        <Button size="small" text icon="pi pi-refresh" title="刷新列表" @click="load" />
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
        <button type="button" class="tk-row" :class="{ open: expanded === x.userId }" @click="toggle(x.userId)">
          <Avatar :image="x.avatarUrl || ''" :label="avatarLabel(x.avatarUrl, x.displayName)" shape="circle" size="large" />
          <div class="tk-info">
            <b class="tk-name">
              <span v-if="x.status" class="tk-dot" :style="statusDotStyle(x.status)" :title="'当前状态：' + statusText(x.status)"></span>
              {{ x.displayName || x.userId }}
            </b>
            <small class="tk-sub">
              <span class="tk-statusline">
                <span class="mono tk-uid">{{ x.userId }}</span>
                <span v-if="x.status" class="tk-status" :class="{ on: isOnline(x.status) }">{{ statusText(x.status) }}</span>
              </span>
              <span v-if="lastChangeAt(x)" class="tk-stat">最近变化 {{ reltime(lastChangeAt(x)) }}</span>
              <span v-else class="tk-stat tk-stat-dim">最近刷新 {{ fmtRefresh(x.lastRefreshAt) }}</span>
            </small>
          </div>
          <span v-if="lastChangeAt(x)" class="tk-dot" title="有资料变化"></span>
          <Button size="small" text rounded :icon="expanded === x.userId ? 'pi pi-chevron-up' : 'pi pi-chevron-down'"
            :aria-label="expanded === x.userId ? '收起变化历史' : '展开变化历史'" @click.stop="toggle(x.userId)" />
        </button>

        <div class="tk-actions" @click.stop>
          <Button size="small" text icon="pi pi-user" label="资料" title="打开资料" :aria-label="'打开 ' + (x.displayName || x.userId) + ' 的资料'" @click="openUser(x.userId)" />
          <Button size="small" text severity="danger" icon="pi pi-user-minus" label="移除" title="移除追踪" :aria-label="'移除追踪 ' + (x.displayName || x.userId)" @click="removeTracked(x)" />
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
                    <span class="tc-old">旧：{{ statusText(c.previousStatus) }}{{ c.previousStatusDescription ? ' · ' + c.previousStatusDescription : '' }}</span>
                    <span class="tc-new">新：{{ statusText(c.status) }}{{ c.statusDescription ? ' · ' + c.statusDescription : '' }}</span>
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

.tk-list { display: flex; flex-direction: column; gap: 6px; }
.tk-item { display: flex; flex-direction: column; gap: 3px; }
.tk-row { display: flex; align-items: center; gap: 10px; padding: 8px; border-radius: 10px; background: var(--surface); border: 1px solid var(--border-soft); cursor: pointer; text-align: left; width: 100%; color: inherit; font-family: inherit; transition: border-color 0.12s; }
.tk-row:hover, .tk-row.open { border-color: var(--accent); }
.tk-row:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.tk-info { min-width: 0; flex: 1; }
.tk-name { font-size: 13px; display: flex; align-items: center; gap: 6px; overflow: hidden; }
.tk-name { white-space: nowrap; text-overflow: ellipsis; }
.tk-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; display: inline-block; }
.tk-statusline { display: flex; align-items: center; gap: 8px; min-width: 0; }
.tk-status { font-size: 10px; color: var(--text-dim); border: 1px solid var(--border); border-radius: 999px; padding: 0 7px; line-height: 16px; flex: none; }
.tk-status.on { color: #52c41a; border-color: rgba(82, 196, 26, 0.4); }
.tk-sub { font-size: 11px; color: var(--text-dim); display: flex; flex-direction: column; gap: 1px; overflow: hidden; }
.tk-uid { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.tk-stat { color: var(--accent); display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tk-stat { color: var(--accent); flex: none; }
.tk-stat-dim { color: var(--text-dim); }
.tk-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); flex: none; }
.tk-actions { display: flex; gap: 2px; margin-left: 42px; margin-top: 1px; }

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
.tc-avatars { display: flex; align-items: center; gap: 8px; }
.tc-avpair { display: flex; flex-direction: column; align-items: center; gap: 2px; }
.tc-av { width: 42px; height: 42px; border-radius: 8px; object-fit: cover; }
.tc-avnone { display: flex; align-items: center; justify-content: center; background: var(--surface-2); font-size: 10px; color: var(--text-dim); }
.tc-avlabel { font-size: 10px; color: var(--text-dim); }
.tc-avarrow { color: var(--text-dim); font-size: 11px; }
.tc-old { color: var(--text-dim); text-decoration: line-through; opacity: 0.75; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tc-new { color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.loading-mini { display: flex; justify-content: center; padding: 12px; }
@media (max-width: 899px) {
  .tk-search { width: 100%; order: 2; }
  .tk-tools { order: 3; }
  .tk-detail { margin-left: 0; }
  .tc-old, .tc-new { white-space: normal; }
}
</style>
