<script setup>
import { ref, onMounted, computed } from 'vue';
import { get } from '../api.js';
import { fmtMin, dateTime } from '../utils.js';
import { openUser, openWorld, openGroup } from '../store.js';
import { toast } from '../toast.js';

// 周报（对齐 MCP get_weekly_report）：活跃概况 + 每日世界足迹 + 世界 Top + 同屏伙伴 Top + 群组活动 + 上线规律
const days = ref(7);
const report = ref(null);
const loading = ref(false);

// seq 防竞态：加载中切换天数立即发新请求，过期响应丢弃（修复审查#5）
let seq = 0;
async function load() {
  const mySeq = ++seq;
  loading.value = true;
  try {
    const r = await get(`/api/dashboard/weekly-report?days=${days.value}`);
    if (mySeq !== seq) return;
    if (r && r.error) throw new Error(r.error);
    report.value = r;
  } catch (e) {
    if (mySeq === seq) { report.value = null; toast('加载周报失败：' + (e.message || e), 'error'); }
  } finally {
    if (mySeq === seq) loading.value = false;
  }
}

function setDays(d) {
  if (days.value === d) return;
  days.value = d;
  load();
}

const ov = computed(() => (report.value && report.value.overview) || {});
const totalHour = computed(() => fmtMin(ov.value.totalMinutes) || '0 分钟');
const periodLabel = computed(() => {
  const p = report.value && report.value.period;
  if (!p || !p.start) return '';
  return dateTime(p.start).slice(0, 10) + ' ~ ' + dateTime(p.end).slice(0, 10);
});

onMounted(load);
</script>

<template>
  <div class="wr">
    <div class="wr-head">
      <h2><i class="pi pi-calendar-clock"></i> 周报</h2>
      <span class="wr-count">{{ periodLabel || '我的 VRChat 活动报告' }} · 北京时间</span>
      <Button size="small" text icon="pi pi-refresh" title="刷新" @click="load" />
    </div>

    <div class="wr-chips" role="group" aria-label="报告天数">
      <button v-for="d in [7, 14, 30]" :key="d" class="chip" :class="{ active: days === d }" @click="setDays(d)">近 {{ d }} 天</button>
    </div>

    <div v-if="loading && !report" class="loading-mini"><ProgressSpinner style="width:28px;height:28px" strokeWidth="4" /></div>
    <div v-else-if="!report" class="empty" style="padding:28px">暂无报告数据（事件库为空或未认证）</div>

    <div v-else class="wr-body">
      <!-- 概览卡片 -->
      <div class="stat-cards">
        <div class="stat-box"><span class="sb-label">活跃天数</span><b class="sb-val">{{ ov.activeDays || 0 }}</b></div>
        <div class="stat-box"><span class="sb-label">游玩总时长</span><b class="sb-val">{{ totalHour }}</b></div>
        <div class="stat-box"><span class="sb-label">到访世界</span><b class="sb-val">{{ ov.worldsVisited || 0 }}</b></div>
        <div class="stat-box"><span class="sb-label">同屏伙伴</span><b class="sb-val">{{ ov.companionUsers || 0 }}</b></div>
        <div v-if="ov.topCompanion" class="stat-box stat-wide">
          <span class="sb-label">最佳玩伴</span>
          <button class="sb-link" @click="openUser(ov.topCompanion.userId)">
            <b>{{ ov.topCompanion.nickname || ov.topCompanion.displayName }}</b>
            <small>同屏 {{ ov.topCompanion.days }} 天 · {{ ov.topCompanion.matchCount }} 次</small>
          </button>
        </div>
      </div>

      <!-- 每日世界足迹 -->
      <div class="wr-sec">
        <h3 class="sec-title">每日世界足迹</h3>
        <div v-if="(report.daily || []).length" class="daily-list">
          <div v-for="d in report.daily" :key="d.day" class="daily-row">
            <span class="dl-day mono">{{ d.day }}</span>
            <div class="dl-worlds">
              <button v-for="w in d.worlds" :key="w.worldId" class="dl-chip" :title="w.worldId" @click="openWorld(w.worldId)">
                {{ w.name || w.worldId }}
              </button>
            </div>
          </div>
        </div>
        <div v-else class="empty" style="padding:12px">暂无世界足迹</div>
      </div>

      <!-- 世界 Top -->
      <div class="wr-sec">
        <h3 class="sec-title">游玩世界 Top</h3>
        <div v-if="(report.topWorlds || []).length" class="tw-list">
          <button v-for="(w, i) in report.topWorlds.slice(0, 10)" :key="w.worldId" class="tw-row" @click="openWorld(w.worldId)">
            <span class="tw-rank">{{ i + 1 }}</span>
            <span class="tw-name">{{ w.name || w.worldId }}</span>
            <span class="tw-sub">{{ w.visits }} 次</span>
            <span class="tw-min">{{ fmtMin(w.minutes) }}</span>
          </button>
        </div>
        <div v-else class="empty" style="padding:12px">暂无世界数据</div>
      </div>

      <!-- 同屏伙伴 Top -->
      <div class="wr-sec">
        <h3 class="sec-title">同屏伙伴 Top</h3>
        <div v-if="(report.topCompanions || []).length" class="cp-list">
          <button v-for="(c, i) in report.topCompanions.slice(0, 10)" :key="c.userId" class="cp-row" @click="openUser(c.userId)">
            <span class="cp-rank">{{ i + 1 }}</span>
            <span class="cp-name">{{ c.nickname || c.displayName }}</span>
            <span class="cp-sub">同屏 {{ c.days }} 天 · {{ c.matchCount }} 次</span>
          </button>
        </div>
        <div v-else class="empty" style="padding:12px">暂无同屏记录</div>
      </div>

      <!-- 群组活动 -->
      <div v-if="(report.groupActivities || []).length" class="wr-sec">
        <h3 class="sec-title">群组活动</h3>
        <div class="ga-list">
          <button v-for="a in report.groupActivities" :key="a.groupId" class="ga-row" @click="openGroup(a.groupId)">
            <i class="pi pi-users ga-icon"></i>
            <span class="ga-name">{{ a.groupName || a.groupId }}</span>
            <span class="ga-sub">{{ a.eventCount || a.count || 0 }} 条 · {{ a.memberCount || 0 }} 成员</span>
          </button>
        </div>
      </div>

      <!-- 好友群组活跃（friendGroupCalendar：好友在哪些群组活动） -->
      <div v-if="(report.friendGroupCalendar || []).length" class="wr-sec">
        <h3 class="sec-title">好友群组活跃</h3>
        <div class="ga-list">
          <button v-for="c in report.friendGroupCalendar" :key="c.groupId" class="ga-row" @click="openGroup(c.groupId)">
            <i class="pi pi-users ga-icon"></i>
            <span class="ga-name">{{ c.groupName || c.groupId }}</span>
            <span class="ga-sub">{{ c.friendCount || 0 }} 位好友 · {{ c.eventCount || 0 }} 次活动 · {{ c.worldCount || 0 }} 个世界</span>
          </button>
        </div>
      </div>

      <!-- 上线规律 -->
      <div v-if="report.ownPattern" class="wr-sec">
        <h3 class="sec-title">上线规律</h3>
        <div class="pat-grid">
          <div class="pat-box"><span class="pb-label">30 天活跃天数</span><b>{{ report.ownPattern.activeDays30 || 0 }}</b></div>
          <div class="pat-box"><span class="pb-label">活跃高峰时段</span><b>{{ report.ownPattern.peakHour != null ? String(report.ownPattern.peakHour).padStart(2, '0') + ':00' : '—' }}</b></div>
          <div class="pat-box"><span class="pb-label">平均间隔</span><b>{{ report.ownPattern.avgGapDays != null ? report.ownPattern.avgGapDays + ' 天' : '—' }}</b></div>
          <div class="pat-box"><span class="pb-label">最长间隔</span><b>{{ report.ownPattern.longestGapDays != null ? report.ownPattern.longestGapDays + ' 天' : '—' }}</b></div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wr { padding: 4px; }
.wr-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.wr-count { font-size: 11px; color: var(--text-dim); flex: 1; }
.wr-chips { display: flex; gap: 6px; margin-bottom: 12px; }




.wr-body { display: flex; flex-direction: column; gap: 16px; }
.stat-wide { grid-column: span 2; }
.sb-link { background: none; border: none; padding: 0; text-align: left; cursor: pointer; color: inherit; font-family: inherit; display: flex; flex-direction: column; }
.sb-link b { font-size: 16px; }
.sb-link small { font-size: 11px; color: var(--text-dim); }
.sb-link:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
.wr-sec { background: var(--surface); border: 1px solid var(--border-soft); border-radius: 10px; padding: 12px 14px; }
.sec-title { font-size: 13px; font-weight: 700; margin: 0 0 10px; }
.daily-list { display: flex; flex-direction: column; gap: 6px; }
.daily-row { display: flex; align-items: flex-start; gap: 10px; }
.dl-day { font-size: 11px; color: var(--text-dim); width: 44px; flex: none; padding-top: 3px; }
.dl-worlds { display: flex; flex-wrap: wrap; gap: 5px; flex: 1; }
.dl-chip { border: 1px solid var(--border); background: var(--surface-2); color: var(--text); border-radius: 999px; padding: 5px 13px; font-size: 12px; cursor: pointer; transition: border-color 0.12s; font-family: inherit; min-height: 32px; display: inline-flex; align-items: center; }
.dl-chip:hover { border-color: var(--accent); }
.dl-chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.tw-list, .cp-list { display: flex; flex-direction: column; gap: 4px; }
.tw-row, .cp-row { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: 8px; background: var(--surface); border: 1px solid var(--border-soft); cursor: pointer; text-align: left; width: 100%; color: inherit; font-family: inherit; transition: border-color 0.12s; }
.tw-row:hover, .cp-row:hover { border-color: var(--accent); }
.tw-row:focus-visible, .cp-row:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.tw-rank, .cp-rank { font-size: 12px; font-weight: 700; color: var(--text-dim); width: 22px; flex: none; text-align: center; font-family: var(--font-mono, monospace); }
.tw-name, .cp-name { font-size: 13px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tw-sub, .cp-sub { font-size: 11px; color: var(--text-dim); flex: none; }
.tw-min { font-size: 12px; font-weight: 600; flex: none; width: 80px; text-align: right; font-family: var(--font-mono, monospace); }
.ga-list { display: flex; flex-direction: column; gap: 4px; }
.ga-row { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: 8px; background: var(--surface); border: 1px solid var(--border-soft); cursor: pointer; text-align: left; width: 100%; color: inherit; font-family: inherit; transition: border-color 0.12s; }
.ga-row:hover { border-color: var(--accent); }
.ga-row:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.ga-icon { color: var(--text-dim); }
.ga-name { font-size: 13px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ga-sub { font-size: 11px; color: var(--text-dim); flex: none; }
.pat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; }
.pat-box { background: var(--surface-2); border-radius: 8px; padding: 10px 12px; }
.pb-label { display: block; font-size: 11px; color: var(--text-dim); margin-bottom: 4px; }
.pat-box b { font-size: 16px; }



/* 移动端：stat-wide 不再跨列、每日足迹世界 chips 换行、ga-row 子项收缩 */
@media (max-width: 899px) {
  .stat-wide { grid-column: span 1; }
  .daily-worlds { flex-wrap: wrap; }
  .ga-row { flex-wrap: wrap; row-gap: 4px; }
  .wr-head { flex-wrap: wrap; }
  .wr-chips { flex-wrap: wrap; }
}
</style>
