<script setup>
import { ref, onMounted, computed } from 'vue';
import { get } from '../api.js';
import { fmtMin } from '../utils.js';
import { openUser } from '../store.js';

// 图表（对齐 VRCX Charts）：活跃时段分布 + 在线热图（InstanceActivity）+ 每日/类型统计。
// 数据源：/stats（byHour/byType/byDay）、/game-sessions（游玩时长）、/activity-heatmap（24h 热图）。
const days = ref(7);
const stats = ref({});
const gameStats = ref({});
const heatmap = ref(null);
const loading = ref(false);

// seq 防竞态：加载中切换天数立即发新请求，过期响应丢弃（修复审查#5）
let seq = 0;
async function load() {
  const mySeq = ++seq;
  loading.value = true;
  try {
    const settled = await Promise.allSettled([
      get(`/api/dashboard/stats?days=${days.value}`),
      get(`/api/dashboard/game-sessions?days=${days.value}`),
      get(`/api/dashboard/activity-heatmap?days=${Math.min(days.value, 30)}`),
    ]);
    if (mySeq !== seq) return;
    if (settled[0].status === 'fulfilled') stats.value = settled[0].value || {};
    if (settled[1].status === 'fulfilled') gameStats.value = settled[1].value || {};
    if (settled[2].status === 'fulfilled') heatmap.value = settled[2].value || null;
  } catch {
    /* 单接口失败保留旧值 */
  } finally {
    if (mySeq === seq) loading.value = false;
  }
}

function setDays(d) {
  if (days.value === d) return;
  days.value = d;
  load();
}

const maxHour = computed(() => Math.max(1, ...(stats.value.byHour || []).map((h) => Number(h.value) || 0)));
const dayMax = computed(() => Math.max(1, ...(stats.value.byDay || []).map((d) => Number(d.count) || 0)));
const typeTotal = computed(() => (stats.value.byType || []).reduce((a, x) => a + (Number(x.count) || 0), 0));
const TYPE_LABEL = {
  'friend-online': '上线', 'friend-offline': '离线', 'friend-location': '位置',
  'friend-active': '状态', 'friend-update': '资料', 'friend-update-avatar': '模型',
  'friend-update-bio': '简介', 'friend-update-status': '状态', 'user-location': '我的位置',
  'user-update': '我的资料', 'notification': '通知', 'notification-v2': '通知',
  'friend-add': '加好友', 'friend-delete': '删好友', 'group-joined': '入群',
  'content-refresh': '内容库', 'unknown': '未知',
};
const typeLabel = (t) => TYPE_LABEL[t] || t;

// 热图：heatmap.days = [{ date, hours: [0/1 × 24] }]（UTC 小时，对齐 VRCX InstanceActivity）
const heatRows = computed(() => (heatmap && heatmap.value && Array.isArray(heatmap.value.days) ? heatmap.value.days : []));
const heatTotal = computed(() => heatRows.value.reduce((a, d) => a + d.hours.reduce((x, v) => x + (v ? 1 : 0), 0), 0));

onMounted(load);
</script>

<template>
  <div class="ch">
    <div class="ch-head">
      <h2><i class="pi pi-chart-bar"></i> 图表</h2>
      <span class="ch-count">活动统计 · 依据本地事件库</span>
    </div>

    <div class="ch-chips" role="group" aria-label="统计天数">
      <button v-for="d in [7, 14, 30]" :key="d" class="chip" :class="{ active: days === d }" @click="setDays(d)">近 {{ d }} 天</button>
    </div>

    <div v-if="loading && !stats.totalEvents" class="loading-mini"><ProgressSpinner style="width:28px;height:28px" strokeWidth="4" /></div>

    <div v-else class="ch-body">
      <div class="stat-cards">
        <div class="stat-box"><span class="sb-label">当前在线好友</span><b class="sb-val">{{ stats.onlineNow || 0 }}</b></div>
        <div class="stat-box"><span class="sb-label">动态事件总数</span><b class="sb-val">{{ stats.totalEvents || 0 }}</b></div>
        <div class="stat-box"><span class="sb-label">游玩总时长</span><b class="sb-val">{{ fmtMin(gameStats.totalMinutes) || '0 分钟' }}</b></div>
        <div class="stat-box"><span class="sb-label">游戏会话数</span><b class="sb-val">{{ gameStats.count || 0 }}</b></div>
      </div>

      <div class="chart-sec">
        <h3 class="sec-title">在线热图（UTC 小时 · 近 {{ heatRows.length }} 天）</h3>
        <div v-if="heatRows.length" class="heatmap">
          <div v-for="row in heatRows" :key="row.date" class="hm-row" :title="row.date">
            <span class="hm-date">{{ String(row.date).slice(5).replace('-', '/') }}</span>
            <div class="hm-cells">
              <span v-for="(v, h) in row.hours" :key="h" class="hm-cell" :class="{ on: v }" :title="row.date + ' ' + String(h).padStart(2, '0') + ':00'"></span>
            </div>
          </div>
        </div>
        <div v-else class="empty" style="padding:12px">暂无在线时段数据</div>
      </div>

      <div class="chart-sec">
        <h3 class="sec-title">活跃时段分布（好友上线 · 小时）</h3>
        <div v-if="(stats.byHour || []).length" class="bar-chart">
          <div v-for="h in stats.byHour" :key="h.label" class="bar-col">
            <div class="bar-fill" :style="{ height: Math.max(4, Math.round((Number(h.value) / maxHour) * 100)) + '%' }" :title="h.label + ' · ' + h.value + ' 次'"></div>
            <span class="bar-lbl">{{ h.label.slice(0, 2) }}</span>
          </div>
        </div>
        <div v-else class="empty" style="padding:12px">暂无上线时段数据</div>
      </div>

      <div class="chart-sec">
        <h3 class="sec-title">每日活动量（近 {{ days }} 天）</h3>
        <div v-if="(stats.byDay || []).length" class="day-chart">
          <div v-for="d in stats.byDay" :key="d.day" class="day-col" :title="d.day + ' · ' + d.count + ' 条'">
            <div class="day-bar" :style="{ height: Math.max(4, Math.round((Number(d.count) / dayMax) * 100)) + '%' }"></div>
            <span class="day-lbl">{{ String(d.day).slice(5).replace('-', '/') }}</span>
          </div>
        </div>
        <div v-else class="empty" style="padding:12px">暂无每日数据</div>
      </div>

      <div class="chart-sec">
        <h3 class="sec-title">活跃好友 Top（近 {{ days }} 天）</h3>
        <div v-if="(stats.topFriends || []).length" class="top-list">
          <button v-for="(f, i) in stats.topFriends" :key="f.userId" class="top-row" @click="openUser(f.userId)">
            <span class="top-rank">{{ i + 1 }}</span>
            <span class="top-name">{{ f.displayName || f.userId }}</span>
            <span class="top-count">{{ f.count }} 条</span>
          </button>
        </div>
        <div v-else class="empty" style="padding:12px">暂无好友活动数据</div>
      </div>

      <div class="chart-sec">
        <h3 class="sec-title">事件类型分布（共 {{ typeTotal }} 条）</h3>
        <div v-if="(stats.byType || []).length" class="type-list">
          <div v-for="t in stats.byType.slice(0, 12)" :key="t.type" class="type-row">
            <span class="tp-name">{{ typeLabel(t.type) }}</span>
            <div class="tp-bar"><div class="tp-fill" :style="{ width: Math.max(2, Math.round((Number(t.count) / typeTotal) * 100)) + '%' }"></div></div>
            <span class="tp-count">{{ t.count }}</span>
          </div>
        </div>
        <div v-else class="empty" style="padding:12px">暂无事件数据</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ch { padding: 4px; }
.ch-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.ch-count { font-size: 11px; color: var(--text-dim); flex: 1; }
.ch-chips { display: flex; align-items: center; gap: 6px; margin-bottom: 12px; }




.ch-body { display: flex; flex-direction: column; gap: 16px; }
.chart-sec { background: var(--surface); border: 1px solid var(--border-soft); border-radius: 10px; padding: 12px 14px; }
.sec-title { font-size: 13px; font-weight: 700; margin: 0 0 10px; }
.heatmap { display: flex; flex-direction: column; gap: 3px; }
.hm-row { display: flex; align-items: center; gap: 8px; }
.hm-date { font-size: 10px; color: var(--text-dim); width: 46px; flex: none; font-family: var(--font-mono, monospace); }
.hm-cells { display: grid; grid-template-columns: repeat(24, 1fr); gap: 2px; flex: 1; }
.hm-cell { aspect-ratio: 1/1; border-radius: 2px; background: var(--surface-2); }
.hm-cell.on { background: var(--accent); }
.bar-chart { display: flex; align-items: flex-end; gap: 3px; height: 110px; }
.bar-col { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%; gap: 3px; }
.bar-fill { width: 100%; max-width: 18px; background: var(--accent); border-radius: 3px 3px 0 0; min-height: 3px; }
.bar-lbl { font-size: 9px; color: var(--text-dim); }
.type-list { display: flex; flex-direction: column; gap: 5px; }
.day-chart { display: flex; align-items: flex-end; gap: 3px; height: 110px; }
.day-col { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%; gap: 3px; min-width: 0; }
.day-bar { width: 100%; max-width: 22px; background: var(--accent); border-radius: 3px 3px 0 0; min-height: 3px; opacity: 0.85; }
.day-lbl { font-size: 8px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.top-list { display: flex; flex-direction: column; gap: 4px; }
.top-row { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: 8px; background: var(--surface); border: 1px solid var(--border-soft); cursor: pointer; text-align: left; width: 100%; color: inherit; font-family: inherit; transition: border-color 0.12s; }
.top-row:hover { border-color: var(--accent); }
.top-row:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.top-rank { font-size: 12px; font-weight: 700; color: var(--text-dim); width: 22px; flex: none; text-align: center; font-family: var(--font-mono, monospace); }
.top-name { font-size: 13px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.top-count { font-size: 11px; color: var(--text-dim); flex: none; font-family: var(--font-mono, monospace); }
.type-row { display: flex; align-items: center; gap: 10px; }
.tp-name { font-size: 12px; width: 90px; flex: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tp-bar { flex: 1; height: 8px; border-radius: 4px; background: var(--surface-2); overflow: hidden; }
.tp-fill { height: 100%; background: var(--accent); border-radius: 4px; }
.tp-count { font-size: 11px; color: var(--text-dim); width: 40px; text-align: right; font-family: var(--font-mono, monospace); }


@media (max-width: 899px) {
  .hm-cells { gap: 1px; }
}
</style>
