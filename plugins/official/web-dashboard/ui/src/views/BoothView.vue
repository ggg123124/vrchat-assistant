<script setup>
import { ref, computed, onMounted } from 'vue';
import { get } from '../api.js';
import { toast } from '../toast.js';
import { copyText } from '../store.js';

// BOOTH 素材搜索（booth.pm，VRChat 模型/衣装/3D 素材市场）：快速列表 + 点击看详情
const q = ref('');
const results = ref(null);
const loading = ref(false);
const detail = ref(null);       // 当前查看的详情
const detailOpen = ref(false);
const detailLoading = ref(false);
const recent = ref([]);          // 最近搜索（get_booth_searches）
const favs = ref(new Map());      // 本地收藏（localStorage：id -> {name, price, imageUrl, url}）
const favFilter = ref(false);     // 只看收藏
let seq = 0;
let timer = null;

async function search() {
  const query = q.value.trim();
  const mySeq = ++seq;
  if (!query) { results.value = null; return; }
  loading.value = true;
  try {
    const r = await get('/api/dashboard/booth-search?q=' + encodeURIComponent(query) + '&limit=10');
    if (mySeq !== seq) return;
    if (r && r.error) throw new Error(r.error);
    results.value = (r && r.results) || [];
  } catch (e) {
    if (mySeq === seq) { results.value = []; toast('搜索失败：' + (e.message || e), 'error'); }
  } finally {
    if (mySeq === seq) loading.value = false;
  }
}
function onInput() {
  clearTimeout(timer);
  timer = setTimeout(search, 600);
}
function onEnter() { clearTimeout(timer); search(); }

// 最近搜索
async function loadRecent() {
  try {
    const r = await get('/api/dashboard/booth-searches?limit=8');
    const list = (r && r.searches) || [];
    recent.value = list.map((s) => s.query || s.q).filter(Boolean);
  } catch { /* 历史加载失败静默 */ }
}
function clearRecent() {
  try { localStorage.removeItem('bh_recent'); } catch { /* 忽略 */ }
  recent.value = [];
  toast('已清空最近搜索', 'info');
}

function applyRecent(query) {
  q.value = query;
  search();
}

// 本地收藏
function loadFavs() {
  try {
    const raw = localStorage.getItem('bh_favs');
    favs.value = new Map(raw ? JSON.parse(raw) : []);
  } catch { favs.value = new Map(); }
}
function saveFavs() {
  try { localStorage.setItem('bh_favs', JSON.stringify([...favs.value.entries()])); } catch { /* 隐私模式忽略 */ }
}
function isFav(id) { return favs.value.has(String(id)); }
function toggleFav(item) {
  const id = String(item.id);
  if (favs.value.has(id)) {
    favs.value.delete(id);
    toast('已取消收藏', 'info');
  } else {
    favs.value.set(id, { name: item.name || '', price: item.price || null, imageUrl: item.imageUrl || null, url: item.url || null });
    toast('已收藏（本地）', 'success');
  }
  saveFavs();
}
const favItems = computed(() => [...favs.value.entries()].map(([id, v]) => ({ id, ...v })).sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh')));
onMounted(() => { loadRecent(); loadFavs(); });

const fmtPrice = (p) => p || '—';
const fmtWish = (n) => (n == null ? '—' : Number(n).toLocaleString());

function exportFavs() {
  if (!favs.value.size) { toast('暂无收藏素材', 'warn'); return; }
  const lines = [...favs.value.entries()].map(([id, v]) => {
    const price = v.price ? ' ' + v.price : '';
    return (v.name || id) + price + (v.url ? ' ' + v.url : '');
  });
  copyText(lines.join('\n'));
  toast('已复制 ' + favs.value.size + ' 条收藏清单', 'success');
}

function searchTag(tag) {
  detailOpen.value = false;
  detail.value = null;
  q.value = tag;
  search();
}

function searchShop() {
  const shop = detail.value && (detail.value.shopName || detail.value.shop);
  if (!shop) return;
  detailOpen.value = false;
  detail.value = null;
  q.value = shop;
  search();
}

async function openDetail(item) {
  if (detailLoading.value) return;
  detailLoading.value = true;
  detail.value = null;
  try {
    const r = await get('/api/dashboard/booth-item?itemId=' + encodeURIComponent(item.id));
    if (r && r.error) throw new Error(r.error);
    detail.value = r;
    detailOpen.value = true;
  } catch (e) {
    toast('加载详情失败：' + (e.message || e), 'error');
  } finally {
    detailLoading.value = false;
  }
}
</script>

<template>
  <div class="bh">
    <div class="bh-head">
      <h2><i class="pi pi-shopping-bag"></i> BOOTH 素材</h2>
      <span class="bh-count">VRChat 模型/衣装/3D 素材市场 · 收藏数=热度</span>
    </div>
    <div class="bh-box">
      <i class="pi pi-search"></i>
      <input v-model="q" class="bh-input" placeholder="搜索素材（日文/英文，如 avatar、衣装、3Dモデル）…" aria-label="搜索 BOOTH 素材"
        @input="onInput" @keydown.enter="onEnter" />
      <i v-if="loading" class="pi pi-spin pi-spinner"></i>
    </div>

    <div class="bh-tools">
      <button class="chip" :class="{ active: favFilter }" @click="favFilter = !favFilter"><i class="pi pi-star"></i> 收藏 ({{ favs.size }})</button>
      <button v-if="favs.size" class="chip" title="复制收藏清单（名称 价格 链接）" @click="exportFavs"><i class="pi pi-copy"></i> 导出</button>
    </div>
    <div v-if="recent.length" class="bh-recent" role="group" aria-label="最近搜索">
      <span class="bh-rlabel">最近</span>
      <button v-for="(r, i) in recent" :key="i" class="bh-rchip" @click="applyRecent(r)"><i class="pi pi-clock"></i> {{ r }}</button>
      <button class="bh-rchip bh-rclear" title="清空最近搜索" @click="clearRecent"><i class="pi pi-times"></i></button>
    </div>
    <div v-if="!results" class="bh-hint">输入关键词搜索；点击结果查看详情（收藏数/店铺/标签）。</div>

    <div v-else-if="favFilter && !favItems.length" class="empty" style="padding:24px">
        <i class="pi pi-star empty-icon" aria-hidden="true"></i>暂无收藏素材——搜索结果点 ⭐ 收藏，离线也能回看</div>
    <div v-else-if="favFilter" class="bh-grid">
      <div v-for="it in favItems" :key="it.id" class="bh-card">
        <img v-if="it.imageUrl" :src="it.imageUrl" class="bh-img" alt="" loading="lazy" />
        <div v-else class="bh-img bh-noimg"><i class="pi pi-box"></i></div>
        <div class="bh-info">
          <b class="bh-name" :title="it.name">{{ it.name }}</b>
          <div class="bh-meta">
            <span class="bh-price">{{ fmtPrice(it.price) }}</span>
          </div>
          <div class="bh-acts">
            <Button size="small" text icon="pi pi-info-circle" :aria-label="'详情 ' + it.name" @click="openDetail(it)" />
            <Button size="small" text icon="pi pi-star-fill" severity="warning" :aria-label="'取消收藏 ' + it.name" @click="toggleFav(it)" />
            <a v-if="it.url" class="bh-open" :href="it.url" target="_blank" rel="noopener"><i class="pi pi-external-link"></i> 打开</a>
          </div>
        </div>
      </div>
    </div>
    <div v-else-if="!results.length" class="empty" style="padding:24px">无匹配素材，试试其他关键词。</div>
    <div v-else class="bh-grid">
      <div v-for="it in results" :key="it.id" class="bh-card">
        <img v-if="it.imageUrl" :src="it.imageUrl" class="bh-img" alt="" loading="lazy" />
        <div v-else class="bh-img bh-noimg"><i class="pi pi-box"></i></div>
        <div class="bh-info">
          <b class="bh-name" :title="it.name">{{ it.name }}</b>
          <div class="bh-meta">
            <span class="bh-price">{{ fmtPrice(it.price) }}</span>
            <span v-if="it.shopName" class="bh-shop">{{ it.shopName }}</span>
          </div>
          <div class="bh-acts">
            <Button size="small" text :icon="isFav(it.id) ? 'pi pi-star-fill' : 'pi pi-star'" :severity="isFav(it.id) ? 'warning' : undefined" :aria-label="(isFav(it.id) ? '取消收藏 ' : '收藏 ') + it.name" @click="toggleFav(it)" />
            <Button size="small" text icon="pi pi-info-circle" label="详情" :loading="detailLoading" @click="openDetail(it)" />
            <a v-if="it.url" class="bh-open" :href="it.url" target="_blank" rel="noopener"><i class="pi pi-external-link"></i> 打开</a>
          </div>
        </div>
      </div>
    </div>

    <!-- 详情 -->
    <Dialog v-model:visible="detailOpen" :header="(detail && (detail.name || '素材详情'))" :modal="true" :style="{ width: 'min(92vw, 560px)' }" dismissable-mask @hide="detail = null">
      <div v-if="detailLoading" class="loading-mini"><ProgressSpinner style="width:28px;height:28px" strokeWidth="4" /></div>
      <div v-else-if="detail" class="bh-detail">
        <div class="bh-dfav">
          <Button :icon="isFav(detail.id) ? 'pi pi-star-fill' : 'pi pi-star'" :severity="isFav(detail.id) ? 'warning' : undefined"
            :label="isFav(detail.id) ? '已收藏' : '收藏'" size="small" @click="toggleFav({ id: detail.id, name: detail.name, price: detail.price, imageUrl: detail.imageUrl || (detail.images && detail.images[0] && detail.images[0].original), url: detail.url })" />
        </div>
        <img v-if="detail.imageUrl || (detail.images && detail.images[0])" :src="detail.imageUrl || detail.images[0].original" class="bh-big" alt="" />
        <div class="bh-drows">
          <div v-if="detail.price" class="bh-drow"><span>价格</span><b>{{ detail.price }}</b></div>
          <div v-if="detail.wishlistCount != null" class="bh-drow"><span>收藏</span><b>{{ fmtWish(detail.wishlistCount) }}</b></div>
          <div v-if="detail.shopName || detail.shop" class="bh-drow"><span>店铺</span><b>{{ detail.shopName || detail.shop }}</b>
            <Button size="small" text icon="pi pi-search" label="搜该店" @click="searchShop" />
          </div>
          <div v-if="detail.isSoldOut != null" class="bh-drow"><span>状态</span><b>{{ detail.isSoldOut ? '已售罄' : '在售' }}</b></div>
          <div v-if="detail.tags && detail.tags.length" class="bh-drow"><span>标签</span><span class="bh-tags"><button v-for="t in detail.tags.slice(0, 6)" :key="t" class="chip bh-tag" :title="'搜索标签：' + t" @click="searchTag(t)">{{ t }}</button></span></div>
          <div v-if="detail.description" class="bh-drow"><span>简介</span><span class="bh-desc">{{ detail.description }}</span></div>
        </div>
        <a v-if="detail.url" class="bh-open bh-openbig" :href="detail.url" target="_blank" rel="noopener"><i class="pi pi-external-link"></i> 在 BOOTH 打开</a>
      </div>
    </Dialog>
  </div>
</template>

<style scoped>
.bh { padding: 4px; }
.bh-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
.bh-count { font-size: 11px; color: var(--text-dim); flex: 1; }
.bh-box { display: flex; align-items: center; gap: 8px; border: 1px solid var(--border); border-radius: 10px; padding: 8px 12px; margin-bottom: 12px; background: var(--surface); }
.bh-box i { color: var(--text-dim); }
.bh-tools { display: flex; gap: 5px; margin-bottom: 8px; }
.bh-recent { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; margin-bottom: 10px; }
.bh-rlabel { font-size: 11px; color: var(--text-dim); }
.bh-rchip { border: 1px solid var(--border); background: var(--surface-2); color: var(--text-dim); border-radius: 999px; padding: 2px 10px; font-size: 11px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; font-family: inherit; }
.bh-rchip:hover { border-color: var(--accent); color: var(--text); }
.bh-rchip i { font-size: 9px; }
.bh-rclear { color: var(--text-dim); }
.bh-hint { font-size: 12px; color: var(--text-dim); padding: 8px 2px; }
.bh-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
.bh-card { border: 1px solid var(--border-soft); border-radius: 10px; overflow: hidden; background: var(--surface); display: flex; flex-direction: column; }
.bh-img { width: 100%; aspect-ratio: 1/1; object-fit: cover; background: var(--surface-2); display: block; }
.bh-noimg { display: flex; align-items: center; justify-content: center; color: var(--text-dim); font-size: 22px; }
.bh-info { padding: 7px 9px; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.bh-name { font-size: 12px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.bh-meta { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.bh-price { font-size: 12px; font-weight: 700; color: var(--accent); }
.bh-shop { font-size: 10px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bh-acts { display: flex; align-items: center; gap: 4px; }
.bh-open { font-size: 11px; color: var(--accent); text-decoration: none; display: inline-flex; align-items: center; gap: 3px; }
.bh-detail { display: flex; flex-direction: column; gap: 10px; }
.bh-dfav { display: flex; justify-content: flex-end; }
.bh-big { width: 100%; border-radius: 8px; max-height: 320px; object-fit: contain; background: var(--surface-2); }
.bh-drows { display: flex; flex-direction: column; gap: 6px; }
.bh-drow { display: flex; gap: 8px; font-size: 12px; }
.bh-drow > span:first-child { color: var(--text-dim); flex: none; width: 42px; }
.bh-tags { display: flex; gap: 4px; flex-wrap: wrap; }
.bh-tag { padding: 1px 8px; font-size: 10px; height: 20px; cursor: pointer; }
.bh-tag:hover { border-color: var(--accent); color: var(--text); }
.bh-desc { color: var(--text); line-height: 1.5; }
.bh-openbig { margin-top: 4px; align-self: flex-start; }

.loading-mini { display: flex; justify-content: center; padding: 12px; }
@media (max-width: 899px) {
  .bh-grid { grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 6px; }
}
</style>
