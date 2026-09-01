<script setup>
import { ref, onMounted, computed, watch } from 'vue';
import { get } from '../api.js';
import { time, date, dateTime } from '../utils.js';
import { openGroup, store, copyText } from '../store.js';
import { toast } from '../toast.js';

// 群组公告历史：跨群组汇总本地公告时间线（WS 推送过的 group.announcement）
const data = ref(null);
const q = ref('');
const expanded = ref('');
const loading = ref(false);

async function load() {
  if (loading.value) return;
  loading.value = true;
  try {
    const r = await get('/api/dashboard/group-announcements-all?limit=200');
    if (r && r.error) throw new Error(r.error);
    data.value = r;
  } catch (e) {
    data.value = { announcements: [] };
    toast('加载公告失败：' + (e.message || e), 'error');
  } finally {
    loading.value = false;
  }
}

const items = computed(() => {
  const list = (data.value && data.value.announcements) || [];
  const query = q.value.trim().toLowerCase();
  if (!query) return list;
  return list.filter((a) =>
    (a.groupName || '').toLowerCase().includes(query) ||
    (a.title || '').toLowerCase().includes(query) ||
    (a.text || '').toLowerCase().includes(query));
});

const total = computed(() => (data.value ? data.value.total : 0));
const groupChips = computed(() => {
  const counts = new Map();
  for (const a of (data.value && data.value.announcements) || []) {
    const g = a.groupId || '';
    if (!g) continue;
    counts.set(g, { g, name: a.groupName || g, n: (counts.get(g)?.n || 0) + 1 });
  }
  return [...counts.values()].sort((x, y) => y.n - x.n).slice(0, 8);
});
const groupFilter = ref('all');
// 新公告标记：localStorage 记录上次查看时间，新增的公告高亮「新」
const lastSeenAt = ref(localStorage.getItem('ga_last_seen') || '');
function isNew(a) {
  return !!a.createdAt && !!lastSeenAt.value && a.createdAt > lastSeenAt.value;
}
function markSeen() {
  const list = (data.value && data.value.announcements) || [];
  if (list.length && list[0].createdAt) {
    try { localStorage.setItem('ga_last_seen', list[0].createdAt); } catch { /* 隐私模式忽略 */ }
    lastSeenAt.value = list[0].createdAt;
    store.annHasNew = false;  // 同步导航徽标
  }
}
watch(() => (data.value && data.value.announcements && data.value.announcements.length) || 0, (n) => { if (n) markSeen(); });

const filtered = computed(() => {
  let list = items.value;
  if (groupFilter.value !== 'all') list = list.filter((a) => (a.groupId || '') === groupFilter.value);
  // 按日期插入分隔项
  const out = [];
  let lastDay = '';
  for (const a of list) {
    const d = date(a.createdAt);
    if (d !== lastDay) { out.push({ __day: d }); lastDay = d; }
    out.push(a);
  }
  return out;
});

function copyAnnouncement(a) {
  const head = [a.groupName, a.title].filter(Boolean).join(' · ');
  copyText((head ? head + '\n' : '') + (a.text || ''));
  toast('公告已复制', 'success');
}
function toggle(a) {
  expanded.value = expanded.value === a.eventId ? '' : a.eventId;
}
onMounted(load);
</script>

<template>
  <div class="ga">
    <div class="ga-head">
      <h2><i class="pi pi-megaphone"></i> 群组公告</h2>
      <span class="ga-count">{{ total }} 条 · WS 推送过的群组公告历史（点击展开全文）</span>
      <InputText v-model="q" placeholder="搜索群组/标题/内容…" class="ga-search" aria-label="搜索公告" />
      <Button size="small" text icon="pi pi-refresh" title="刷新" @click="load" />
    </div>

    <div v-if="groupChips.length > 1" class="ga-chips" role="group" aria-label="按群组筛选">
      <button class="chip" :class="{ active: groupFilter === 'all' }" @click="groupFilter = 'all'">全部</button>
      <button v-for="g in groupChips" :key="g.g" class="chip" :class="{ active: groupFilter === g.g }" @click="groupFilter = g.g">{{ g.name }}<span class="chip-n">{{ g.n }}</span></button>
    </div>

    <div v-if="loading && !data" class="loading-mini"><ProgressSpinner style="width:28px;height:28px" strokeWidth="4" /></div>
    <div v-else-if="!filtered.length" class="empty" style="padding:24px">
        <i class="pi pi-megaphone empty-icon" aria-hidden="true"></i>
      {{ q || groupFilter !== 'all' ? '无匹配公告' : '暂无群组公告历史（群组发布公告后会出现在这里）' }}
    </div>
    <div v-else class="ga-list">
      <div v-for="a in filtered" :key="a.eventId || a.__day" class="ga-item">
        <div v-if="a.__day" class="ga-day"><span>{{ a.__day }}</span></div>
        <template v-else>
        <button type="button" class="ga-row" @click="toggle(a)">
          <div class="ga-info">
            <div class="ga-line">
              <button v-if="a.groupId" class="ga-group" @click.stop="openGroup(a.groupId)"><i class="pi pi-users"></i> {{ a.groupName || a.groupId }}</button>
              <b class="ga-title">{{ a.title || '（无标题）' }}</b>
              <span v-if="isNew(a)" class="ga-new">新</span>
            </div>
            <small class="ga-time mono" :title="dateTime(a.createdAt)">{{ time(a.createdAt) }} {{ date(a.createdAt) }}</small>
          </div>
          <i class="pi ga-chev" :class="expanded === a.eventId ? 'pi-chevron-up' : 'pi-chevron-down'" aria-hidden="true"></i>
        </button>
        <div v-if="expanded === a.eventId" class="ga-detail">
          <p class="ga-text">{{ a.text || '（无内容）' }}</p>
          <div class="ga-copyrow">
            <Button size="small" text icon="pi pi-copy" label="复制全文" @click="copyAnnouncement(a)" />
          </div>
        </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ga { padding: 4px; }
.ga-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
.ga-count { font-size: 11px; color: var(--text-dim); flex: 1; min-width: 140px; }
.ga-search { width: 170px; }
.ga-chips { display: flex; gap: 5px; flex-wrap: wrap; margin-bottom: 10px; }

.ga-day { display: flex; align-items: center; gap: 8px; margin: 8px 0 2px; font-size: 11px; color: var(--text-dim); }
.ga-day::after { content: ''; flex: 1; height: 1px; background: var(--border-soft); }
.ga-list { display: flex; flex-direction: column; gap: 5px; }
.ga-item { display: flex; flex-direction: column; gap: 3px; }
.ga-row { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 10px; background: var(--surface); border: 1px solid var(--border-soft); cursor: pointer; text-align: left; width: 100%; color: inherit; font-family: inherit; transition: border-color 0.12s; }
.ga-row:hover, .ga-row.open { border-color: var(--accent); }
.ga-row:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.ga-info { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; }
.ga-line { display: flex; align-items: center; gap: 8px; min-width: 0; }
.ga-group { background: none; border: 1px solid var(--border); color: var(--accent); border-radius: 999px; padding: 1px 9px; font-size: 11px; cursor: pointer; flex: none; display: inline-flex; align-items: center; gap: 4px; font-family: inherit; }
.ga-group:hover { border-color: var(--accent); }
.ga-title { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 0 1 auto; }
.ga-new { flex: none; background: var(--danger); color: #fff; font-size: 9px; border-radius: 4px; padding: 0 4px; line-height: 14px; font-weight: 700; }
.ga-time { font-size: 10px; color: var(--text-dim); }
.ga-chev { color: var(--text-dim); font-size: 12px; flex: none; }
.ga-detail { background: var(--surface-2); border: 1px solid var(--border-soft); border-radius: 8px; padding: 10px 12px; margin-left: 20px; }
.ga-text { font-size: 13px; line-height: 1.6; margin: 0; white-space: pre-wrap; word-break: break-word; }
.ga-copyrow { display: flex; justify-content: flex-end; margin-top: 4px; }


@media (max-width: 899px) {
  .ga-group { padding: 4px 12px; font-size: 12px; min-height: 32px; }
  .ga-search { width: 100%; order: 3; }
  .ga-detail { margin-left: 0; }
}
</style>
