<script setup>
import { ref, onMounted, computed } from 'vue';
import { get, post } from '../api.js';
import { date } from '../utils.js';
import { openWorld } from '../store.js';
import { toast } from '../toast.js';

// X 博主世界推荐：本地 x_world_recommendations 表（x_scan_creators 抓取落库）+ 博主清单
const data = ref(null);
const loading = ref(false);
const q = ref('');

async function load() {
  if (loading.value) return;
  loading.value = true;
  try {
    const r = await get('/api/dashboard/x-worlds?limit=200');
    data.value = r;
  } catch (e) {
    data.value = { worlds: [], creators: [] };
    toast('加载 X 推荐失败：' + (e.message || e), 'error');
  } finally {
    loading.value = false;
  }
}

const worlds = computed(() => {
  const list = (data.value && data.value.worlds) || [];
  const query = q.value.trim().toLowerCase();
  if (!query) return list;
  return list.filter((w) =>
    (w.worldName || '').toLowerCase().includes(query) ||
    (w.authorName || '').toLowerCase().includes(query) ||
    (w.worldId || '').includes(query));
});

const fmtNum = (n) => (n == null ? '—' : Number(n).toLocaleString());

// 博主管理：添加/扫描/移除（走 MCP 工具，安全模式下 remove 被拦截）
const newCreator = ref('');
const scanning = ref(false);
const removing = ref('');

async function addCreator() {
  const screen = newCreator.value.trim().replace(/^@/, '');
  if (!screen) { toast('请输入博主 X 用户名', 'warn'); return; }
  try {
    const r = await post('/api/dashboard/x-creators', { screen_name: screen });
    if (r && r.error) throw new Error(r.error);
    toast('已添加 @' + screen + '，点「扫描」抓取其推荐世界', 'success');
    newCreator.value = '';
    await load();
  } catch (e) {
    toast('添加失败：' + (e.message || e), 'error');
  }
}

async function scanCreators() {
  if (scanning.value) return;
  scanning.value = true;
  try {
    const r = await post('/api/dashboard/x-creators/scan');
    if (r && r.error) throw new Error(r.error);
    toast('已触发扫描（后台执行，可能需要几分钟，稍后刷新列表）', 'info');
    setTimeout(async () => { await load(); scanning.value = false; }, 8000);
  } catch (e) {
    toast('扫描触发失败：' + (e.message || e), 'error');
    scanning.value = false;
  }
}

async function removeCreator(c) {
  const screen = c.screen_name || '';
  if (!screen) return;
  if (!window.confirm('确认移除博主 @' + screen + '？其推荐记录将不再展示')) return;
  if (removing.value) return;
  removing.value = screen;
  try {
    const r = await post('/api/dashboard/x-creators/remove', { screen_name: screen });
    if (r && r.error) throw new Error(r.error);
    toast('已移除 @' + screen, 'success');
    await load();
  } catch (e) {
    toast('移除失败：' + (e.message || e), 'error');
  } finally {
    removing.value = '';
  }
}

onMounted(load);
</script>

<template>
  <div class="xw">
    <div class="xw-head">
      <h2><i class="pi pi-twitter"></i> X 博主推荐</h2>
      <span class="xw-count">X（Twitter）博主推荐的世界 · 本地知识库{{ data ? ' · 共 ' + data.total + ' 个' : '' }}</span>
      <InputText v-model="q" placeholder="搜索世界 / 作者…" class="xw-search" aria-label="搜索推荐世界" />
      <Button size="small" text icon="pi pi-refresh" title="刷新" @click="load" />
    </div>

    <!-- 博主清单 -->
    <div class="xw-manage">
      <div class="xm-add">
        <InputText v-model="newCreator" placeholder="X 用户名（不带 @）…" class="xm-input" aria-label="X 博主用户名" @keydown.enter="addCreator" />
        <Button label="添加博主" icon="pi pi-plus" size="small" @click="addCreator" />
        <Button label="扫描推荐" icon="pi pi-sync" size="small" :loading="scanning" title="抓取所有博主的推荐世界（后台执行）" @click="scanCreators" />
      </div>
      <div v-if="data && data.creators && data.creators.length" class="xw-creators">
        <span class="xc-label">博主</span>
        <span v-for="c in data.creators" :key="c.screen_name || c.userId" class="xc-chip" :title="c.name || ''">
          <i class="pi pi-twitter"></i> @{{ c.screen_name }}
          <button class="xc-remove" :disabled="removing === (c.screen_name || '')" :title="'移除博主'" :aria-label="'移除 ' + c.screen_name" @click.stop="removeCreator(c)"><i class="pi pi-times"></i></button>
        </span>
      </div>
    </div>

    <div v-if="loading && !data" class="loading-mini"><ProgressSpinner style="width:28px;height:28px" strokeWidth="4" /></div>
    <div v-else-if="!worlds.length" class="empty" style="padding:24px">
      <template v-if="q">无匹配的推荐世界</template>
      <template v-else-if="data && data.creators && data.creators.length">
        已添加博主但扫描暂无结果——2026 年 X 匿名抓取通道受限（Nitter/API/浏览器均不可用），数据抓取受环境限制；
        可先点「扫描推荐」重试，或用「推荐」页的官方推荐
      </template>
      <template v-else>暂无 X 推荐数据——先「添加博主」（如 fox_yata9），再点「扫描推荐」抓取其推荐世界</template>
    </div>
    <div v-else class="xw-grid">
      <button v-for="w in worlds" :key="w.worldId" class="xw-card" @click="openWorld(w.worldId)">
        <div class="xw-body">
          <b class="xw-name">{{ w.worldName || w.worldId }}</b>
          <small class="xw-author">作者 {{ w.authorName || '—' }}</small>
          <small class="xw-meta">
            收藏 {{ fmtNum(w.favorites) }} · 访问 {{ fmtNum(w.visits) }}
            <template v-if="w.popularity != null"> · 热度 {{ fmtNum(w.popularity) }}</template>
            <template v-if="w.tweetCount"> · {{ w.tweetCount }} 推</template>
          </small>
        </div>
      </button>
    </div>
  </div>
</template>

<style scoped>
.xw { padding: 4px; }
.xw-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
.xw-count { font-size: 11px; color: var(--text-dim); flex: 1; min-width: 120px; }
.xw-search { width: 180px; }
.xw-manage { margin-bottom: 12px; display: flex; flex-direction: column; gap: 8px; }
.xm-add { display: flex; gap: 8px; flex-wrap: wrap; }
.xm-input { flex: 1 1 200px; }
.xc-remove { background: none; border: none; color: var(--text-dim); cursor: pointer; padding: 0 2px; font-size: 10px; display: inline-flex; align-items: center; }
.xc-remove:hover { color: var(--danger); }
.xc-remove:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; border-radius: 3px; }
.xw-creators { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; }
.xc-label { font-size: 11px; color: var(--text-dim); }
.xc-chip { border: 1px solid var(--border); background: var(--surface-2); color: var(--text); border-radius: 999px; padding: 3px 11px; font-size: 11px; display: inline-flex; align-items: center; gap: 4px; }
.xc-chip i { font-size: 10px; color: var(--accent); }
.xw-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; }
.xw-card { border: 1px solid var(--border-soft); border-radius: 10px; background: var(--surface); padding: 12px 14px; cursor: pointer; text-align: left; color: inherit; font-family: inherit; transition: border-color 0.12s; }
.xw-card:hover { border-color: var(--accent); }
.xw-card:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.xw-body { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.xw-name { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.xw-author { font-size: 11px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.xw-meta { font-size: 10px; color: var(--text-dim); font-family: var(--font-mono, monospace); }


@media (max-width: 899px) {
  .xw-search { width: 100%; order: 3; }
  .xw-grid { grid-template-columns: 1fr; }
}
</style>
