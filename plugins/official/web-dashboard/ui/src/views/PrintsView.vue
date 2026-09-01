<script setup>
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { get } from '../api.js';
import { imgUrl } from '../api.js';
import { time, date } from '../utils.js';
import { openWorld } from '../store.js';
import { toast } from '../toast.js';
import { confirm } from '../confirm.js';

// 相册（VRChat Plus 照片）：get_prints 工具实时拉取，网格展示 + 点击放大预览
const tab = ref('prints');           // prints | gallery
const prints = ref(null);
const gallery = ref(null);
const loading = ref(false);
const preview = ref(null);          // 当前预览的图片
const previewOpen = ref(false);     // 预览 Dialog 可见性
const error = ref('');

function openPreview(p) { preview.value = p; previewOpen.value = true; }
function closePreview() { previewOpen.value = false; preview.value = null; }

// 删除照片/画廊图片（安全模式下服务端拦截；确认后删除并刷新）
const removingId = ref('');
async function removeMedia(p) {
  if (removingId.value) return;
  const isPrint = tab.value === 'prints';
    if (!await confirm({ message: '确认删除这张' + (isPrint ? '照片' : '图片') + '？不可恢复。', header: '删除图片', acceptLabel: '删除' })) return;
  removingId.value = p.printId || p.fileId;
  try {
    const r = isPrint
      ? await post('/api/dashboard/prints/remove', { printId: p.printId })
      : await post('/api/dashboard/gallery/remove', { fileId: p.fileId });
    if (r && r.error) throw new Error(r.error);
    toast('已删除' + (isPrint ? '照片' : '图片'), 'success');
    await load();
  } catch (e) {
    toast('删除失败：' + (e.message || e), 'error');
  } finally {
    removingId.value = '';
  }
}
function previewIndex() {
  const list = items.value || [];
  if (!preview.value || !list.length) return -1;
  return list.findIndex((x) => (x.printId || x.fileId) === (preview.value.printId || preview.value.fileId));
}
function prevItem() {
  const list = items.value || [];
  const i = previewIndex();
  if (list.length && i >= 0) openPreview(list[(i - 1 + list.length) % list.length]);
}
function nextItem() {
  const list = items.value || [];
  const i = previewIndex();
  if (list.length && i >= 0) openPreview(list[(i + 1) % list.length]);
}
// 预览打开时支持左右方向键
function onKey(e) {
  if (!previewOpen.value) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); prevItem(); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); nextItem(); }
  else if (e.key === 'Escape') { closePreview(); }
}
onMounted(() => window.addEventListener('keydown', onKey));
onUnmounted(() => window.removeEventListener('keydown', onKey));

const fileInput = ref(null);
const uploading = ref(false);
function pickImage() { if (fileInput.value) fileInput.value.click(); }
async function onFileChosen(ev) {
  const file = ev.target.files && ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) { toast('请选择图片文件', 'warn'); return; }
  if (file.size > 15 * 1024 * 1024) { toast('图片超过 15MB', 'warn'); return; }
  if (uploading.value) return;
  uploading.value = true;
  try {
    const data = await new Promise((resolve, reject) => {
      const rd = new FileReader();
      rd.onload = () => resolve(rd.result);
      rd.onerror = () => reject(new Error('读取文件失败'));
      rd.readAsDataURL(file);
    });
    const r = tab.value === 'prints'
      ? await post('/api/dashboard/prints/upload', { data, note: '' })
      : await post('/api/dashboard/gallery/upload', { data });
    if (r && r.error) throw new Error(r.error);
    toast(tab.value === 'prints' ? '照片已上传到相册' : '图片已上传到画廊', 'success');
    await load();
  } catch (e) {
    toast('上传失败：' + (e.message || e), 'error');
  } finally {
    uploading.value = false;
  }
}

async function load() {
  if (loading.value) return;
  loading.value = true;
  error.value = '';
  try {
    if (tab.value === 'prints') {
      const r = await get('/api/dashboard/prints?limit=100');
      if (r && r.error) throw new Error(r.error);
      prints.value = (r && r.prints) || [];
      if (!prints.value.length) error.value = '相册为空——VRChat Plus 照片（游戏中拍照）会出现在这里';
    } else {
      const r = await get('/api/dashboard/gallery?limit=100');
      if (r && r.error) throw new Error(r.error);
      gallery.value = (r && r.images) || [];
      if (!gallery.value.length) error.value = '画廊为空——资料页展示图会出现在这里';
    }
  } catch (e) {
    if (tab.value === 'prints') prints.value = [];
    else gallery.value = [];
    error.value = '加载失败：' + (e.message || e);
  } finally {
    loading.value = false;
  }
}

function switchTab(t) {
  if (tab.value === t) return;
  tab.value = t;
  error.value = '';
  load();
}

const worldFilter = ref('all');   // 相册按世界筛选（仅 prints tab）
const items = computed(() => {
  let list = tab.value === 'prints' ? prints.value : gallery.value;
  list = list || [];
  if (tab.value === 'prints' && worldFilter.value !== 'all') {
    list = list.filter((p) => (p.worldId || '') === worldFilter.value);
  }
  return list;
});
// 世界 chips：由已加载照片推导（按数量取前 8）
const worldChips = computed(() => {
  const counts = new Map();
  for (const p of (prints.value || [])) {
    const key = p.worldId || '';
    if (!key) continue;
    const name = p.worldName || key;
    counts.set(key, { key, name, n: (counts.get(key)?.n || 0) + 1 });
  }
  return [...counts.values()].sort((a, b) => b.n - a.n).slice(0, 8);
});
const fmtNote = (p) => (p.note || '').slice(0, 40);
const previewUrl = computed(() => (preview.value ? imgUrl(preview.value.downloadUrl) : ''));
const previewDate = computed(() => {
  const p = preview.value;
  if (!p) return '';
  return (p.createdAt || p.uploadedAt) ? date(p.createdAt || p.uploadedAt) + ' ' + time(p.createdAt || p.uploadedAt) : '';
});

onMounted(load);
</script>

<template>
  <div class="pr">
    <div class="pr-head">
      <h2><i class="pi pi-images"></i> 媒体</h2>
      <div class="pr-tabs" role="group" aria-label="媒体类型">
        <button class="chip" :class="{ active: tab === 'prints' }" @click="switchTab('prints')">相册{{ prints ? ' (' + prints.length + ')' : '' }}</button>
        <button class="chip" :class="{ active: tab === 'gallery' }" @click="switchTab('gallery')">画廊{{ gallery ? ' (' + gallery.length + ')' : '' }}</button>
      </div>
      <span class="pr-count">{{ tab === 'prints' ? 'VRChat Plus 照片' : '资料展示图' }}</span>
      <Button size="small" icon="pi pi-upload" :loading="uploading" :label="tab === 'prints' ? '上传' : '上传'" :title="tab === 'prints' ? '上传照片到 VRChat Plus 相册' : '上传图片到 VRChat Plus 画廊'" @click="pickImage" />
      <input ref="fileInput" type="file" accept="image/*" class="hidden-file" aria-hidden="true" @change="onFileChosen" />
      <Button size="small" text icon="pi pi-refresh" title="刷新" @click="load" />
    </div>

    <div v-if="tab === 'prints' && worldChips.length" class="ws-chips" role="group" aria-label="按世界筛选">
      <button class="chip" :class="{ active: worldFilter === 'all' }" @click="worldFilter = 'all'">全部</button>
      <button v-for="w in worldChips" :key="w.key" class="chip" :class="{ active: worldFilter === w.key }" @click="worldFilter = w.key">{{ w.name }}<span class="chip-n">{{ w.n }}</span></button>
    </div>
    <div v-if="loading && !items.length" class="loading-mini"><ProgressSpinner style="width:28px;height:28px" strokeWidth="4" /></div>
    <div v-else-if="error && !items.length" class="empty" style="padding:24px">{{ error }}</div>
    <div v-else class="pr-grid">
      <div v-for="p in items" :key="p.printId || p.fileId" class="pr-card">
        <button type="button" class="pr-cardbtn" @click="openPreview(p)">
        <img v-if="p.downloadUrl" :src="imgUrl(p.downloadUrl)" class="pr-img" :alt="fmtNote(p) || '照片'" loading="lazy" />
        <div v-else class="pr-img pr-noimg"><i class="pi pi-image"></i></div>
        <div class="pr-meta">
          <small class="pr-date mono">{{ date(p.createdAt) }} {{ time(p.createdAt) }}</small>
          <span v-if="fmtNote(p)" class="pr-note">{{ fmtNote(p) }}</span>
        </div>
        </button>
        <button type="button" class="pr-del" :title="'删除' + (tab === 'prints' ? '照片' : '图片')" :aria-label="'删除' + (tab === 'prints' ? '照片' : '图片')" @click="removeMedia(p)">
          <i :class="removingId === (p.printId || p.fileId) ? 'pi pi-spin pi-spinner' : 'pi pi-trash'"></i>
        </button>
      </div>
    </div>

    <!-- 预览 -->
    <Dialog v-model:visible="previewOpen" :header="(tab === 'prints' ? '照片' : '图片') + ' · ' + previewDate" :modal="true" :style="{ width: 'min(92vw, 720px)' }" dismissable-mask @hide="closePreview">
      <div v-if="preview" class="pr-preview">
        <div class="pr-nav">
          <Button icon="pi pi-chevron-left" text rounded :aria-label="'上一张'" @click="prevItem" />
          <span class="pr-navcount">{{ previewIndex() + 1 }} / {{ (items || []).length }}</span>
          <Button icon="pi pi-chevron-right" text rounded :aria-label="'下一张'" @click="nextItem" />
        </div>
        <img :src="previewUrl" class="pr-big" alt="照片" />
        <div class="pr-pinfo">
          <span v-if="fmtNote(preview)" class="pr-pnote">{{ preview.note }}</span>
          <button v-if="tab === 'prints' && preview.worldId" class="pr-pworld" @click="openWorld(preview.worldId)">
            <i class="pi pi-globe"></i> {{ preview.worldName || preview.worldId }}
          </button>
          <a class="pr-open" :href="previewUrl" target="_blank" rel="noopener"><i class="pi pi-external-link"></i> 打开原图</a>
          <button v-if="tab === 'prints' && preview.worldId" class="pr-pworld" @click="openWorld(preview.worldId)">
            <i class="pi pi-globe"></i> {{ preview.worldName || preview.worldId }}
          </button>
          <small class="pr-pid mono">{{ preview.printId }}</small>
        </div>
      </div>
    </Dialog>
  </div>
</template>

<style scoped>
.pr { padding: 4px; }
.pr-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
.pr-tabs { display: flex; gap: 5px; }
.hidden-file { display: none; }
.ws-chips { display: flex; gap: 5px; flex-wrap: wrap; margin-bottom: 10px; }

.pr-count { font-size: 11px; color: var(--text-dim); flex: 1; }
.pr-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 8px; }
.pr-card { border: 1px solid var(--border-soft); border-radius: 10px; overflow: hidden; background: var(--surface); cursor: pointer; padding: 0; text-align: left; color: inherit; font-family: inherit; transition: border-color 0.12s; display: flex; flex-direction: column; }
.pr-card:hover { border-color: var(--accent); }
.pr-card:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.pr-img { width: 100%; aspect-ratio: 16/10; object-fit: cover; display: block; background: var(--surface-2); }
.pr-noimg { display: flex; align-items: center; justify-content: center; color: var(--text-dim); font-size: 20px; }
.pr-card { position: relative; }
.pr-del { position: absolute; top: 6px; right: 6px; background: rgba(0,0,0,0.5); border: none; border-radius: 50%; width: 24px; height: 24px; color: #ff6b6b; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 11px; }
.pr-del:hover { background: rgba(255, 107, 107, 0.25); }
.pr-cardbtn { border: none; background: none; padding: 0; cursor: pointer; text-align: left; color: inherit; font-family: inherit; display: flex; flex-direction: column; }
.pr-meta { padding: 6px 8px; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.pr-date { font-size: 10px; color: var(--text-dim); }
.pr-note { font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pr-nav { display: flex; align-items: center; justify-content: center; gap: 10px; }
.pr-navcount { font-size: 12px; color: var(--text-dim); }
.pr-preview { display: flex; flex-direction: column; gap: 10px; }
.pr-big { width: 100%; border-radius: 8px; }
.pr-pinfo { display: flex; flex-direction: column; gap: 6px; }
.pr-pnote { font-size: 13px; }
.pr-open { font-size: 12px; color: var(--accent); display: inline-flex; align-items: center; gap: 4px; text-decoration: none; align-self: flex-start; }
.pr-pworld { background: none; border: 1px solid var(--border); color: var(--accent); border-radius: 999px; padding: 2px 10px; font-size: 11px; cursor: pointer; align-self: flex-start; font-family: inherit; display: inline-flex; align-items: center; gap: 4px; }
.pr-pworld:hover { border-color: var(--accent); }
.pr-pworld { background: none; border: 1px solid var(--border); border-radius: 999px; padding: 3px 12px; font-size: 12px; cursor: pointer; color: var(--accent); align-self: flex-start; font-family: inherit; }
.pr-pid { font-size: 10px; color: var(--text-dim); }


@media (max-width: 899px) {
  .pr-grid { grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); gap: 6px; }
}
</style>
