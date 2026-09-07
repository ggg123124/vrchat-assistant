<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { get } from '../api.js';
import { time, date, fmtMin, reltime } from '../utils.js';
import { store, openWorld } from '../store.js';
import { toast } from '../toast.js';

// 足迹：自己去过的世界（dashboard.recentWorlds 服务）
const worlds = ref(null);
const loading = ref(false);
const onlyNoted = ref(false);
const onlyFav = ref(false);
// 好友地图统计（dashboard.friendWorldStats 服务，#165 数据层）
const fws = ref(null);
const fwsDays = ref(30);

async function loadFws() {
  try {
    const r = await get(`/api/dashboard/friend-world-stats?days=${fwsDays.value}&limit=12`);
    fws.value = (r && r.stats) || [];
  } catch {
    fws.value = [];
  }
}
onMounted(() => { loadFws(); });
watch(fwsDays, () => loadFws());
const maxMinutes = computed(() => Math.max(1, ...(shown.value || []).map((w) => w.minutes || 0)));
const q = ref('');

async function load() {
  if (loading.value) return;
  loading.value = true;
  try {
    const r = await get('/api/dashboard/recent-worlds?limit=60');
    worlds.value = (r && r.worlds) || [];
  } catch (e) {
    worlds.value = worlds.value || [];
    toast('加载足迹失败：' + (e.message || e), 'error');
  } finally {
    loading.value = false;
  }
}
function reload() { worlds.value = null; load(); }

const sortBy = ref(localStorage.getItem('ws_sort') || 'recent');   // recent | visits | minutes（localStorage 持久）
function setSort(v) { sortBy.value = v; try { localStorage.setItem('ws_sort', v); } catch { /* 忽略 */ } }
const SORTS = [
  { v: 'recent', l: '最近' },
  { v: 'visits', l: '次数' },
  { v: 'minutes', l: '时长' },
];
const shown = computed(() => {
  let list = worlds.value || [];
  if (q.value.trim()) {
    const query = q.value.trim().toLowerCase();
    list = list.filter(w => (w.worldName || w.name || '').toLowerCase().includes(query));
  }
  if (onlyNoted.value) list = list.filter(w => w.note);
  if (onlyFav.value) list = list.filter(w => w.favorited);
  // 排序：最近（默认服务端已按 lastSeen 倒序）/ 次数 / 游玩时长
  if (sortBy.value === 'visits') {
    list = [...list].sort((a, b) => (b.visits || 0) - (a.visits || 0));
  } else if (sortBy.value === 'minutes') {
    list = [...list].sort((a, b) => (b.minutes || 0) - (a.minutes || 0));
  }
  return list;
});

onMounted(load);
</script>

<template>
  <div class="ws">
    <div class="ws-head">
      <h2><i class="pi pi-map"></i> 足迹</h2>
      <div class="ws-sorts" role="group" aria-label="足迹排序">
        <button v-for="s in SORTS" :key="s.v" class="chip" :class="{ active: sortBy === s.v }" @click="setSort(s.v)">{{ s.l }}</button>
      </div>
      <span class="ws-count">最近去过的世界</span>
      <Button size="small" text icon="pi pi-refresh" title="刷新" @click="reload" />
    </div>

    <!-- 好友地图统计：好友群体最近 N 天去过的世界热度（发现好玩的图） -->
    <div class="fws-card">
      <div class="fws-head">
        <i class="pi pi-users"></i>
        <b>好友常去的世界</b>
        <span class="fws-sub">最近 {{ fwsDays }} 天 · 按去过的好友数排序</span>
        <span class="fws-spacer"></span>
        <button class="chip" :class="{ active: fwsDays === 7 }" @click="fwsDays = 7; loadFws()">7天</button>
        <button class="chip" :class="{ active: fwsDays === 30 }" @click="fwsDays = 30; loadFws()">30天</button>
        <button class="chip" :class="{ active: fwsDays === 90 }" @click="fwsDays = 90; loadFws()">90天</button>
      </div>
      <div v-if="fws === null" class="fws-empty">加载中…</div>
      <div v-else-if="!fws.length" class="fws-empty">暂无好友世界记录（统计自动累积）</div>
      <div v-else class="fws-list">
        <div v-for="s in fws" :key="s.worldId" class="fws-row">
          <img v-if="s.imageUrl" :src="s.imageUrl" class="fws-thumb" alt="" loading="lazy" />
          <div v-else class="fws-thumb fws-thumb-empty"></div>
          <div class="fws-info">
            <b class="fws-name">{{ s.worldName || s.worldId }}</b>
            <small class="fws-meta">
              {{ s.visitors }} 位好友去过 · {{ s.visits }} 次
              <template v-if="s.friends.length"> · {{ s.friends.join('、') }}</template>
            </small>
          </div>
          <Button size="small" text icon="pi pi-external-link" title="打开世界页" @click="openWorld(s.worldId)" />
        </div>
      </div>
    </div>

    <div class="ws-toolbar">
      <div class="ws-box">
        <i class="pi pi-search"></i>
        <input v-model="q" placeholder="过滤世界名…" class="ws-input" aria-label="过滤世界名" />
        <i v-if="q" class="pi pi-times ws-clear" title="清空" @click="q = ''"></i>
      </div>
      <button class="chip" :class="{ active: onlyNoted }" @click="onlyNoted = !onlyNoted">只看有备注</button>
      <button class="chip" :class="{ active: onlyFav }" @click="onlyFav = !onlyFav"><i class="pi pi-star"></i> 只看收藏</button>
    </div>

    <div v-if="loading && !worlds" class="loading-mini"><ProgressSpinner style="width:28px;height:28px" strokeWidth="4" /></div>
    <div v-else-if="!shown.length" class="empty" style="padding:24px">
        <i class="pi pi-globe empty-icon" aria-hidden="true"></i>
      {{ q || onlyNoted ? '没有匹配的世界' : '暂无足迹——去逛逛，回来就有了' }}
    </div>
    <div v-else class="ws-grid">
      <div v-for="(w, i) in shown" :key="w.worldId || i" class="ws-card" role="button" tabindex="0"
        @click="openWorld(w.worldId)" @keydown.enter="openWorld(w.worldId)">
        <div class="ws-imgwrap">
          <img v-if="w.imageUrl || w.thumbnailUrl" class="ws-img" :src="w.imageUrl || w.thumbnailUrl" alt="" loading="lazy" />
          <div v-else class="ws-img ws-img-empty"><i class="pi pi-globe"></i></div>
          <span v-if="i === 0" class="ws-latest">最近</span>
        </div>
        <div class="ws-info">
          <b class="ws-name" :title="w.worldName || w.name">{{ w.worldName || w.name || w.worldId }}</b>
          <div class="ws-meta">
            <span class="ws-time mono" :title="date(w.lastSeen)">{{ reltime(w.lastSeen) }}<small>{{ date(w.lastSeen) }}</small></span>
            <span v-if="w.visits" class="ws-visits">× {{ w.visits }}</span>
            <span v-if="w.minutes" class="ws-min" :title="'30 天内游玩时长'">{{ fmtMin(w.minutes) }}</span>
            <span v-if="w.minutes" class="ws-bar"><i :style="{ width: Math.round((w.minutes / maxMinutes) * 100) + '%' }"></i></span>
            <i v-if="w.favorited" class="pi pi-star-fill ws-fav" title="已收藏的世界"></i>
            <i v-if="w.note" class="pi pi-pencil ws-noted" title="有备注"></i>
            <span v-if="w.note" class="ws-note" :title="w.note">{{ w.note }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ws { padding: 4px; }
.ws-sorts { display: flex; gap: 5px; }
.ws-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.ws-count { font-size: 11px; color: var(--text-dim); flex: 1; }
.ws-toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
.ws-box { display: flex; align-items: center; gap: 7px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 10px; padding: 0 11px; height: 32px; flex: 1 1 200px; min-width: 140px; transition: border-color 0.15s; }
.ws-box:focus-within { border-color: var(--accent); }
.ws-box > .pi-search { font-size: 12px; color: var(--text-dim); flex: none; }
.ws-clear { font-size: 11px; color: var(--text-dim); cursor: pointer; flex: none; }




.ws-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 10px; }
.ws-card { position: relative; background: var(--surface); border: 1px solid var(--border-soft); border-radius: 10px; overflow: hidden; cursor: pointer; transition: border-color 0.12s; }
.ws-card:hover { border-color: var(--accent); }
.ws-card:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.ws-imgwrap { position: relative; }
.ws-img { width: 100%; height: 90px; object-fit: cover; display: block; background: var(--surface-3); }
.ws-img-empty { display: flex; align-items: center; justify-content: center; color: var(--text-dim); }
.ws-latest { position: absolute; top: 5px; left: 5px; font-size: 10px; background: color-mix(in srgb, var(--accent) 85%, transparent); color: #fff; border-radius: 8px; padding: 0 7px; line-height: 16px; }
.ws-info { padding: 7px 9px 9px; }
.ws-name { font-size: 12.5px; display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
.ws-meta { display: flex; align-items: center; gap: 8px; margin-top: 4px; font-size: 10.5px; color: var(--text-dim); }
.ws-time small { margin-left: 4px; }
.ws-noted { color: var(--accent); }
.ws-fav { color: #ffca28; font-size: 11px; }
.ws-bar { display: block; height: 3px; background: var(--surface-3); border-radius: 2px; overflow: hidden; margin-top: 3px; }
.ws-bar i { display: block; height: 100%; background: linear-gradient(90deg, var(--accent), var(--accent-2)); border-radius: 2px; }
.ws-note { font-size: 10px; color: var(--accent); opacity: 0.85; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; display: block; }

@media (max-width: 899px) {
  .ws-grid { grid-template-columns: 1fr 1fr; gap: 8px; }
  .ws-img { height: 76px; }
}

/* ── 好友常去的世界（好友地图统计卡片）── */
.fws-card { border: 1px solid var(--surface-border, #ddd); border-radius: 10px; padding: 12px 14px; margin-bottom: 18px; background: var(--surface-a, transparent); }
.fws-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
.fws-head i { color: var(--accent); }
.fws-sub { color: var(--text-color-secondary, #888); font-size: 12px; }
.fws-spacer { flex: 1; }
.fws-list { display: flex; flex-direction: column; gap: 8px; }
.fws-row { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: 8px; background: var(--surface-ground, rgba(128,128,128,0.06)); }
.fws-thumb { width: 64px; height: 40px; border-radius: 6px; object-fit: cover; flex: none; }
.fws-thumb-empty { background: var(--surface-border, #ccc); }
.fws-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.fws-name { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fws-meta { color: var(--text-color-secondary, #888); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fws-empty { color: var(--text-color-secondary, #888); font-size: 12px; padding: 8px 0; }
@media (max-width: 640px) { .fws-thumb { width: 52px; height: 34px; } }

</style>
