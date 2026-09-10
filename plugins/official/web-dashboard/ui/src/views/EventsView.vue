<script setup>
import { ref, onMounted, computed } from 'vue';
import { get } from '../api.js';
import { openGroup } from '../store.js';
import { toast } from '../toast.js';
import { time, date } from '../utils.js';

// 双源：vrc = VRChat 官方活动日历（/calendar 三态，2026-09-10 上线）；community = 社区聚合（Google 日历源，需配置 key）
const source = ref('vrc');
const win = ref('week');
const data = ref(null);
const loading = ref(false);
const expanded = ref('');

const WINDOWS = [
  { v: 'tonight', l: '今晚' },
  { v: 'week', l: '本周' },
  { v: 'month', l: '本月' },
];
const SRC_LABEL = { RLVRC: 'RLVRC', vrceve: 'VRCEve', vrckr: 'VRCEvent-KR', vrcsearch: 'VRC搜索' };

// seq 防竞态：加载中切换窗口立即发新请求，过期响应丢弃（修复审查#5；events 首拉可达 48s）
let seq = 0;
async function load() {
  const mySeq = ++seq;
  loading.value = true;
  try {
    const r = await get(`/api/dashboard/community-events?window=${win.value}`, 60000);
    if (mySeq !== seq) return;
    if (r && r.error) throw new Error(r.error);
    data.value = r;
  } catch (e) {
    if (mySeq === seq) { data.value = { events: [] }; toast('加载社区活动失败：' + (e.message || e), 'error'); }
  } finally {
    if (mySeq === seq) loading.value = false;
  }
}

function setWindow(w) {
  if (win.value === w) return;
  win.value = w;
  load();
}

const events = computed(() => (data.value && data.value.events) || []);
// 展开状态 key：group+start+name 唯一（同名同时段不同群组事件不再互相折叠冲突）
const evtKey = (e) => (e.group_id || '') + '|' + (e.start || '') + '|' + e.name;

// ── VRChat 官方日历流 ──
const CAL_SCOPES = [
  { v: 'all', l: '全部' },
  { v: 'featured', l: '精选' },
  { v: 'following', l: '关注的群组' },
];
// 官方日历 category 为英文枚举；已知取值映射中文，未知取值原样显示（官方枚举可能扩，回退是有意的）
const CAT_ZH = { education: '教育', social: '社交', gaming: '游戏', music: '音乐', art: '艺术', meetup: '聚会', community: '社区', development: '开发', fitness: '健身', charity: '公益', performance: '演出', workshop: '工作坊', talk: '讲座', party: '派对', exhibition: '展览' };
const calScope = ref('all');
const calEvents = ref([]);
const calHasNext = ref(false);
const calLoading = ref(false);
const calOffset = ref(0);
let calSeq = 0;
async function loadCal(reset = true) {
  const mySeq = ++calSeq;
  calLoading.value = true;
  try {
    const off = reset ? 0 : calOffset.value;
    const r = await get(`/api/dashboard/calendar?scope=${calScope.value}&n=30&offset=${off}`, 20000);
    if (mySeq !== calSeq) return;
    if (r && r.error) throw new Error(r.error);
    const list = r.events || [];
    calEvents.value = reset ? list : calEvents.value.concat(list);
    calHasNext.value = !!r.hasNext;
    calOffset.value = off + list.length;
  } catch (e) {
    if (mySeq === calSeq) toast('加载 VRChat 日历失败：' + (e.message || e), 'error');
  } finally {
    if (mySeq === calSeq) calLoading.value = false;
  }
}
function setSource(v) { if (source.value !== v) { source.value = v; if (v === 'vrc') loadCal(true); else load(); } }
function setCalScope(v) { if (calScope.value !== v) { calScope.value = v; loadCal(true); } }
const catZh = (c) => CAT_ZH[c] || c;
onMounted(() => { loadCal(true); load(); });
</script>

<template>
  <div class="ev">
    <div class="ev-head">
      <h2><i class="pi pi-calendar"></i> 活动</h2>
      <span class="ev-count">{{ source === 'vrc' ? 'VRChat 官方活动日历' : 'VRChat 社区活动聚合（群组挖掘 + 日历源）' }}{{ source === 'community' && data && data.counts ? ' · 共 ' + data.counts.output + ' 个' : '' }}</span>
      <Button size="small" text icon="pi pi-refresh" title="刷新" @click="source === 'vrc' ? loadCal(true) : load()" />
    </div>

    <div class="ev-chips" role="group" aria-label="活动来源">
      <button class="chip" :class="{ active: source === 'vrc' }" @click="setSource('vrc')">VRChat 日历</button>
      <button class="chip" :class="{ active: source === 'community' }" @click="setSource('community')">社区聚合</button>
    </div>

    <template v-if="source === 'vrc'">
      <div class="ev-chips" role="group" aria-label="日历范围">
        <button v-for="s in CAL_SCOPES" :key="s.v" class="chip" :class="{ active: calScope === s.v }" @click="setCalScope(s.v)">{{ s.l }}</button>
      </div>

      <div v-if="calLoading && !calEvents.length" class="loading-mini"><ProgressSpinner style="width:28px;height:28px" strokeWidth="4" /></div>
      <div v-else-if="!calEvents.length" class="empty" style="padding:24px">暂无活动{{ calScope === 'following' ? '（关注的群组发布活动后会出现在这里）' : '' }}</div>
      <div v-else class="ev-list">
        <div v-for="e in calEvents" :key="e.id" class="ev-card">
          <div class="ev-row" @click="expanded = expanded === e.id ? '' : e.id">
            <img v-if="e.imageUrl" :src="e.imageUrl" class="ev-icon ev-calimg" alt="" loading="lazy" />
            <div v-else class="ev-icon ev-noicon"><i class="pi pi-calendar"></i></div>
            <div class="ev-info">
              <b class="ev-name">{{ e.title }}</b>
              <small class="ev-sub">
                <template v-if="e.startsAt">{{ date(e.startsAt) }} {{ time(e.startsAt) }}</template>
                <template v-if="e.endsAt"> → {{ time(e.endsAt) }}</template>
                <template v-if="e.category"> · {{ catZh(e.category) }}</template>
              </small>
              <small v-if="e.interestedUserCount != null" class="ev-group">{{ e.interestedUserCount }} 人感兴趣</small>
            </div>
            <Tag v-if="e.featured" value="精选" severity="warn" />
            <i class="pi ev-arrow" :class="expanded === e.id ? 'pi-chevron-up' : 'pi-chevron-down'"></i>
          </div>
          <div v-if="expanded === e.id" class="ev-detail">
            <p v-if="e.description" class="ev-desc">{{ e.description }}</p>
            <div class="ev-actions">
              <Button v-if="e.ownerId && e.ownerId.startsWith('grp_')" size="small" icon="pi pi-users" label="所属群组" @click="openGroup(e.ownerId)" />
            </div>
          </div>
        </div>
        <div v-if="calHasNext" class="cal-more">
          <Button size="small" text label="加载更多" :loading="calLoading" @click="loadCal(false)" />
        </div>
      </div>
    </template>

    <template v-else>

    <div v-if="loading && !data" class="loading-mini"><ProgressSpinner style="width:28px;height:28px" strokeWidth="4" /></div>
    <div v-else-if="!events.length" class="empty" style="padding:24px">
      {{ data && data.error ? '加载失败：' + data.error : '暂无活动（可 set_community_events_google_key 启用 VRCEve/VRCEvent-KR 日历源）' }}
    </div>
    <div v-else class="ev-list">
      <div v-for="e in events" :key="(e.group_id || '') + (e.start || '') + e.name" class="ev-card">
        <div class="ev-row" @click="expanded = expanded === evtKey(e) ? '' : evtKey(e)">
          <img v-if="e.icon_url" :src="e.icon_url" class="ev-icon" alt="" loading="lazy" />
          <div v-else class="ev-icon ev-noicon"><i class="pi pi-calendar"></i></div>
          <div class="ev-info">
            <b class="ev-name">{{ e.name }}</b>
            <small class="ev-sub">
              <template v-if="e.start_bj">{{ e.start_bj }}</template>
              <template v-if="e.category_zh"> · {{ e.category_zh }}</template>
              <template v-if="e.languages && e.languages.length"> · {{ e.languages.join('/') }}</template>
            </small>
            <small class="ev-group">
              <template v-if="e.group_name">{{ e.group_name }}</template>
              <template v-if="e.member_count != null"> · {{ Number(e.member_count).toLocaleString() }} 成员</template>
            </small>
          </div>
          <span class="ev-src" :title="'来源 ' + (SRC_LABEL[e.src] || e.src)">{{ SRC_LABEL[e.src] || e.src }}</span>
          <i class="pi ev-arrow" :class="expanded === evtKey(e) ? 'pi-chevron-up' : 'pi-chevron-down'"></i>
        </div>
        <div v-if="expanded === evtKey(e)" class="ev-detail">
          <p v-if="e.desc" class="ev-desc">{{ e.desc }}</p>
          <p v-if="e.join_info_zh && e.join_info_zh !== e.desc" class="ev-join"><b>参加方式：</b>{{ e.join_info_zh }}</p>
          <div class="ev-actions">
            <Button v-if="e.group_id" size="small" icon="pi pi-users" label="打开群组" @click="openGroup(e.group_id)" />
            <Button v-if="e.page_url" size="small" text icon="pi pi-external-link" :label="e.page_label || '查看原页'" @click="window.open(e.page_url, '_blank')" />
          </div>
        </div>
      </div>
    </div>
    </template>
  </div>
</template>

<style scoped>
.ev { padding: 4px; }
.ev-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
.ev-count { font-size: 11px; color: var(--text-dim); flex: 1; min-width: 120px; }
.ev-chips { display: flex; gap: 6px; margin-bottom: 12px; }




.ev-list { display: flex; flex-direction: column; gap: 8px; }
.ev-card { background: var(--surface); border: 1px solid var(--border-soft); border-radius: 10px; overflow: hidden; }
.ev-row { display: flex; align-items: center; gap: 10px; padding: 10px 12px; cursor: pointer; text-align: left; width: 100%; color: inherit; font-family: inherit; background: none; border: none; }
.ev-row:hover { background: var(--surface-2); }
.ev-row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; border-radius: 10px; }
.ev-icon { width: 40px; height: 40px; border-radius: 8px; object-fit: cover; flex: none; background: var(--surface-2); }
.ev-noicon { display: flex; align-items: center; justify-content: center; color: var(--text-dim); }
.ev-info { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; }
.ev-name { font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ev-sub, .ev-group { font-size: 11px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ev-src { font-size: 9px; color: var(--text-dim); background: var(--surface-2); border: 1px solid var(--border-soft); border-radius: 999px; padding: 2px 8px; flex: none; }
.ev-arrow { color: var(--text-dim); flex: none; font-size: 11px; }
.ev-detail { padding: 0 12px 12px 62px; }
.ev-desc, .ev-join { font-size: 12px; color: var(--text); line-height: 1.7; margin: 6px 0; white-space: pre-wrap; }
.ev-join b { color: var(--text-dim); }
.ev-calimg { width: 56px; height: 40px; }
.cal-more { display: flex; justify-content: center; padding: 6px 0 2px; }
.ev-actions { display: flex; gap: 8px; margin-top: 8px; }


@media (max-width: 899px) {
  .ev-detail { padding-left: 12px; }
}
</style>
