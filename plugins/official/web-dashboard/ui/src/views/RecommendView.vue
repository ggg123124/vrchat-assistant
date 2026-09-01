<script setup>
import { ref, onMounted, computed } from 'vue';
import { get, post } from '../api.js';
import { openWorld } from '../store.js';
import { toast } from '../toast.js';

// 世界推荐（多源融合 recommend_worlds：local × PlanetVRC × 用户反馈，可解释 reasons）
const theme = ref('default');
const data = ref(null);
const loading = ref(false);

const THEMES = [
  { v: 'default', l: '综合' },
  { v: 'sleep', l: '睡觉' },
  { v: 'chat', l: '聊天' },
  { v: 'onsen', l: '温泉' },
  { v: 'game', l: '游戏' },
];

// seq 防竞态：加载中切换主题立即发新请求，过期响应丢弃（修复审查#5：旧 if(loading) return 会把切换丢弃）
let seq = 0;
async function load() {
  const mySeq = ++seq;
  loading.value = true;
  try {
    const r = await get(`/api/dashboard/recommend-worlds?theme=${theme.value}`, 40000);
    if (mySeq !== seq) return;
    if (r && r.error) throw new Error(r.error);
    data.value = r;
  } catch (e) {
    if (mySeq === seq) { data.value = null; toast('加载推荐失败：' + (e.message || e), 'error'); }
  } finally {
    if (mySeq === seq) loading.value = false;
  }
}

function setTheme(t) {
  if (theme.value === t) return;
  theme.value = t;
  load();
}

const recs = computed(() => (data.value && data.value.recommended) || []);
const fmtHeat = (h) => {
  if (!h) return '';
  const parts = [];
  if (h.occupants) parts.push('在线 ' + h.occupants);
  if (h.officialFavorites) parts.push('收藏 ' + h.officialFavorites);
  if (h.planetVisitors != null) parts.push('访问 ' + Number(h.planetVisitors).toLocaleString());
  return parts.join(' · ');
};
const reasonLabel = (r) => (typeof r === 'string' ? r : (r && r.label) || JSON.stringify(r).slice(0, 60));

// 反馈闭环：评分（👍/👎/清除）+ 标记已逛——喂给推荐引擎（rate_world / mark_world_visited）
const acting = ref('');
async function rate(w, rating) {
  if (!w.worldId || acting.value) return;
  acting.value = w.worldId + ':' + rating;
  try {
    const r = await post('/api/dashboard/world/rate', { worldId: w.worldId, rating });
    if (r && r.error) throw new Error(r.error);
    toast(rating === 1 ? '已标记为喜欢 👍（影响后续推荐）' : rating === -1 ? '已标记为不喜欢 👎' : '已清除评分', 'success');
    // 5 分钟后缓存过期，下次加载反映新评分
  } catch (e) {
    toast('评分失败：' + (e.message || e), 'error');
  } finally {
    acting.value = '';
  }
}
async function markVisited(w) {
  if (!w.worldId || acting.value) return;
  acting.value = w.worldId + ':v';
  try {
    const r = await post('/api/dashboard/world/visited', { worldId: w.worldId });
    if (r && r.error) throw new Error(r.error);
    toast('已标记为逛过（后续推荐将减少此类）', 'success');
  } catch (e) {
    toast('标记失败：' + (e.message || e), 'error');
  } finally {
    acting.value = '';
  }
}

onMounted(load);
</script>

<template>
  <div class="rc">
    <div class="rc-head">
      <h2><i class="pi pi-compass"></i> 世界推荐</h2>
      <span class="rc-count">多源融合（本地 × PlanetVRC × 你的反馈）· 按主题筛选</span>
      <Button size="small" text icon="pi pi-refresh" title="刷新" @click="load" />
    </div>

    <div class="rc-chips" role="group" aria-label="推荐主题">
      <button v-for="t in THEMES" :key="t.v" class="chip" :class="{ active: theme === t.v }" @click="setTheme(t.v)">{{ t.l }}</button>
    <div class="rc-legend" title="综合评分 = 收藏×2 + 在线人数×10 + Planet热度 + 主题加分 + 新图加分 + 作者偏好">分数 = 收藏×2 + 在线×10 + Planet热度 + 主题/新图/作者加分</div>
    </div>

    <div v-if="loading && !data" class="loading-mini"><ProgressSpinner style="width:28px;height:28px" strokeWidth="4" /></div>
    <div v-else-if="!recs.length" class="empty" style="padding:24px">
      {{ data && data.error ? '推荐失败：' + data.error : '暂无推荐（可先 rate_world / mark_world_visited 积累反馈，或稍后重试）' }}
    </div>
    <div v-else class="rc-list">
      <button v-for="w in recs" :key="w.worldId || w.name" class="rc-card" :disabled="!w.canOpen" @click="w.canOpen && openWorld(w.worldId)">
        <img v-if="w.imageUrl" class="rc-cover" :src="w.imageUrl" :alt="w.name" loading="lazy" />
        <div v-else class="rc-cover rc-nocover"><i class="pi pi-globe"></i></div>
        <div class="rc-body">
          <b class="rc-name">{{ w.name || w.worldId || '未知世界' }}</b>
          <small class="rc-author">{{ w.authorName || '作者未知' }}{{ w.capacity ? ' · 容量 ' + w.capacity : '' }}</small>
          <small v-if="fmtHeat(w.heat)" class="rc-heat">{{ fmtHeat(w.heat) }}</small>
          <div v-if="w.reasons && w.reasons.length" class="rc-reasons">
            <span v-for="(r, i) in w.reasons.slice(0, 3)" :key="i" class="rc-reason">{{ reasonLabel(r) }}</span>
          </div>
          <div class="rc-actions" @click.stop>
            <Button size="small" text icon="pi pi-thumbs-up" :loading="acting === w.worldId + ':1'" :title="'喜欢（影响后续推荐）'" :aria-label="'喜欢 ' + w.name" @click="rate(w, 1)" />
            <Button size="small" text icon="pi pi-thumbs-down" :loading="acting === w.worldId + ':-1'" :title="'不喜欢'" :aria-label="'不喜欢 ' + w.name" @click="rate(w, -1)" />
            <Button size="small" text icon="pi pi-check" :loading="acting === w.worldId + ':v'" :title="'标记已逛（后续减少推荐）'" :aria-label="'标记已逛 ' + w.name" @click="markVisited(w)" />
          </div>
          <span class="rc-score" :title="'综合评分 ' + (w.score != null ? w.score.toFixed(1) : '—')">{{ w.score != null ? w.score.toFixed(1) : '' }}</span>
          <span v-if="w.visited" class="rc-visited" title="已标记为逛过"><i class="pi pi-check-circle"></i> 已逛</span>
        </div>
      </button>
    </div>
  </div>
</template>

<style scoped>
.rc { padding: 4px; }
.rc-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.rc-count { font-size: 11px; color: var(--text-dim); flex: 1; }
.rc-chips { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; }




.rc-list { display: flex; flex-direction: column; gap: 8px; }
.rc-card { display: flex; gap: 12px; padding: 10px; border-radius: 10px; background: var(--surface); border: 1px solid var(--border-soft); cursor: pointer; text-align: left; width: 100%; color: inherit; font-family: inherit; transition: border-color 0.12s; position: relative; }
.rc-card:hover:not(:disabled) { border-color: var(--accent); }
.rc-card:disabled { opacity: 0.6; cursor: default; }
.rc-card:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.rc-cover { width: 120px; height: 68px; object-fit: cover; border-radius: 6px; flex: none; background: var(--surface-2); }
.rc-nocover { display: flex; align-items: center; justify-content: center; color: var(--text-dim); font-size: 22px; }
.rc-body { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 3px; }
.rc-name { font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-right: 40px; }
.rc-author, .rc-heat { font-size: 11px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rc-reasons { display: flex; flex-wrap: wrap; gap: 4px; }
.rc-reason { font-size: 10px; color: var(--text-dim); background: var(--surface-2); border: 1px solid var(--border-soft); border-radius: 999px; padding: 1px 8px; }
.rc-legend { font-size: 10px; color: var(--text-dim); margin-bottom: 10px; opacity: 0.85; }
.rc-actions { display: flex; gap: 2px; margin-top: 2px; }
.rc-actions .p-button { padding: 2px 6px; font-size: 11px; }
.rc-visited { position: absolute; bottom: 8px; right: 12px; font-size: 10px; color: var(--ok); display: inline-flex; align-items: center; gap: 3px; }
.rc-score { position: absolute; top: 10px; right: 12px; font-size: 15px; font-weight: 700; color: var(--accent); font-family: var(--font-mono, monospace); }


@media (max-width: 899px) {
  .rc-cover { width: 84px; height: 56px; }
  /* C1 触控目标：卡片喜欢/不喜欢/已逛按钮加大（20px→32px） */
  .rc-actions .p-button { min-width: 32px; min-height: 32px; }
}
</style>
