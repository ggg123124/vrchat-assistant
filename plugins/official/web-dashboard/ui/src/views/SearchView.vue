<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { get } from '../api.js';
import { time, date, avatarLabel } from '../utils.js';
import { store, openUser, openWorld, openGroup, openAvatar } from '../store.js';
import { toast } from '../toast.js';

// 统一搜索：用户/世界/群组（search_users/search_worlds/search_groups 规范化路由）
const q = ref('');
const type = ref('users');
const results = ref(null);
const loading = ref(false);
let debounceTimer = null;
let seq = 0;

// 搜索历史（localStorage 记忆最近 8 条，按类型）
const recent = ref(JSON.parse(localStorage.getItem('sv_recent') || '[]'));
function rememberRecent(t, query) {
  const q = String(query || '').trim();
  if (!q) return;
  const list = [{ type: t, q }, ...recent.value.filter((x) => !(x.type === t && x.q === q))].slice(0, 8);
  recent.value = list;
  try { localStorage.setItem('sv_recent', JSON.stringify(list)); } catch { /* 隐私模式忽略 */ }
}
function applyRecent(r) {
  if (type.value !== r.type) type.value = r.type;
  q.value = r.q;
  run();
}
function clearRecent() {
  recent.value = [];
  try { localStorage.removeItem('sv_recent'); } catch { /* 忽略 */ }
}

const TYPES = [
  { v: 'users', l: '用户', ph: '搜索用户名…' },
  { v: 'worlds', l: '世界', ph: '搜索世界名…' },
  { v: 'groups', l: '群组', ph: '搜索群组名…' },
  { v: 'avatars', l: '模型', ph: '搜索模型名…' },
];
const TYPE_LABEL = { users: '用户', worlds: '世界', groups: '群组', avatars: '模型' };

async function run() {
  const query = q.value.trim();
  seq++;
  const mySeq = seq;
  if (!query) { results.value = []; loading.value = false; return; }
  loading.value = true;
  try {
    const r = await get('/api/dashboard/search?type=' + type.value + '&q=' + encodeURIComponent(query) + '&limit=30');
    if (mySeq !== seq) return; // 过期响应丢弃
    results.value = (r && r.results) || [];
    if ((r && r.results) || true) rememberRecent(type.value, query);
  } catch (e) {
    if (mySeq === seq) { results.value = []; toast('搜索失败：' + (e.message || e), 'error'); }
  } finally {
    if (mySeq === seq) loading.value = false;
  }
}
function onInput() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(run, 500); // 防抖 500ms
}
function setType(v) {
  if (type.value === v) return;
  type.value = v;
  clearTimeout(debounceTimer);
  if (q.value.trim()) run(); else results.value = [];
}
function openResult(x) {
  if (x.kind === 'avatar') { if (typeof openAvatar === 'function') openAvatar(x.id); return; }
  if (x.kind === 'user') openUser({ userId: x.id, displayName: x.name });
  else if (x.kind === 'world') openWorld(x.id);
  else if (x.kind === 'group') openGroup(x.id);
}
function rowAvatar(x) { return x.image || ''; }
const shown = computed(() => results.value || []);

onMounted(() => {});
onUnmounted(() => clearTimeout(debounceTimer));
</script>

<template>
  <div class="sv">
    <div class="sv-head">
      <h2><i class="pi pi-search"></i> 搜索</h2>
    </div>

    <div class="sv-types" role="group" aria-label="搜索类型">
      <button v-for="t in TYPES" :key="t.v" class="chip" :class="{ active: type === t.v }" @click="setType(t.v)">{{ t.l }}</button>
    </div>

    <div v-if="recent.length" class="sv-recent" role="group" aria-label="最近搜索">
      <span class="sv-rlabel">最近</span>
      <button v-for="(r, i) in recent" :key="i" class="sv-rchip" @click="applyRecent(r)">
        <i class="pi pi-clock"></i> {{ r.q }}
      </button>
      <button class="sv-rclear" title="清除历史" aria-label="清除搜索历史" @click="clearRecent"><i class="pi pi-times"></i></button>
    </div>

    <div class="sv-box">
      <i class="pi pi-search"></i>
      <input v-model="q" :placeholder="TYPES.find(t => t.v === type)?.ph || '搜索…'" class="sv-input" aria-label="搜索"
        @input="onInput" @keydown.enter="run" />
      <i v-if="q" class="pi pi-times sv-clear" title="清空" @click="q = ''; results = []"></i>
    </div>

    <div v-if="loading" class="loading-mini"><ProgressSpinner style="width:28px;height:28px" strokeWidth="4" /></div>
    <div v-else-if="!q.trim()" class="empty" style="padding:24px">输入关键词开始搜索（{{ TYPE_LABEL[type] }}）</div>
    <div v-else-if="!shown.length" class="empty" style="padding:24px">没有找到匹配的{{ TYPE_LABEL[type] }}</div>
    <div v-else class="sv-list">
      <div v-for="x in shown" :key="x.kind + x.id" class="sv-row" role="button" tabindex="0" @click="openResult(x)" @keydown.enter="openResult(x)">
        <img v-if="rowAvatar(x)" class="sv-av" :src="rowAvatar(x)" alt="" loading="lazy" />
        <div v-else class="sv-av sv-av-empty">{{ avatarLabel('', x.name) }}</div>
        <div class="sv-body">
          <b class="sv-name">{{ x.name }}</b>
          <div v-if="x.sub" class="sv-sub">{{ x.sub }}</div>
        </div>
        <i class="pi pi-angle-right sv-arrow" aria-hidden="true"></i>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sv { padding: 4px; }
.sv-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.sv-types { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }




.sv-recent { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
.sv-rlabel { font-size: 11px; color: var(--text-dim); }
.sv-rchip { border: 1px solid var(--border); background: var(--surface-2); color: var(--text-dim); border-radius: 999px; padding: 3px 11px; font-size: 11px; cursor: pointer; transition: all 0.12s; font-family: inherit; display: inline-flex; align-items: center; gap: 4px; }
.sv-rchip:hover { border-color: var(--accent); color: var(--text); }
.sv-rchip:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.sv-rchip i { font-size: 9px; }
.sv-rclear { background: none; border: none; color: var(--text-dim); cursor: pointer; font-size: 10px; padding: 3px; }
.sv-rclear:hover { color: var(--danger); }
.sv-rclear:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; border-radius: 3px; }
.sv-box { display: flex; align-items: center; gap: 8px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 10px; padding: 0 12px; height: 38px; margin-bottom: 12px; transition: border-color 0.15s, box-shadow 0.15s; }
.sv-box:focus-within { border-color: var(--accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 22%, transparent); }
.sv-box > .pi-search { font-size: 13px; color: var(--text-dim); flex: none; }
.sv-clear { font-size: 11px; color: var(--text-dim); cursor: pointer; padding: 2px; flex: none; }
.sv-list { display: flex; flex-direction: column; gap: 6px; }
.sv-row { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 8px; background: var(--surface); border: 1px solid var(--border-soft); cursor: pointer; transition: border-color 0.12s; }
.sv-row:hover { border-color: var(--accent); }
.sv-av { width: 38px; height: 38px; border-radius: 50%; object-fit: cover; flex: none; background: var(--surface-3); }
.sv-av-empty { display: flex; align-items: center; justify-content: center; color: var(--text-dim); font-weight: 600; }
.sv-body { min-width: 0; flex: 1; }
.sv-name { font-size: 13px; display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sv-sub { font-size: 11px; color: var(--text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sv-arrow { flex: none; color: var(--text-dim); }

@media (max-width: 899px) {
  .sv-types { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; -webkit-overflow-scrolling: touch; padding-bottom: 2px; }
  .sv-types::-webkit-scrollbar { display: none; }
  /* C1 触控目标：搜索历史 chips 与清除按钮移动端加大 */
  .sv-rchip { padding: 5px 13px; font-size: 12px; min-height: 32px; }
  .sv-rclear { font-size: 12px; padding: 6px 8px; }
}
</style>
