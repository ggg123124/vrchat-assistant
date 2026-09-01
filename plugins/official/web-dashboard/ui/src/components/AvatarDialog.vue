<script setup>
import { ref, computed } from 'vue';
import { store, closeAvatar, copyText } from '../store.js';
import { get } from '../api.js';

const visible = computed({
  get: () => !!store.avatarModal,
  set: (v) => { if (!v) closeAvatar(); },
});

const data = ref(null);
const loadError = ref('');
const loading = ref(false);

// 弹窗打开时按 avatarId 拉详情（缓存 5 分钟）
const avatarId = computed(() => (store.avatarModal && (store.avatarModal.avatarId || store.avatarModal)) || '');

async function load() {
  if (!avatarId.value) return;
  loading.value = true;
  loadError.value = '';
  try {
    const r = await get(`/api/dashboard/avatar?avatarId=${encodeURIComponent(avatarId.value)}`);
    if (r && r.error) throw new Error(r.error);
    data.value = r && r.avatarId ? r : null;
    if (!data.value) throw new Error('模型不存在');
  } catch (e) {
    loadError.value = String(e.message || e);
    data.value = null;
  }
  loading.value = false;
}

// 打开 VRChat 模型页（网页版模型链接）
function openVrcPage() {
  window.open(`https://vrchat.com/home/avatar/${avatarId.value}`, '_blank', 'noopener');
}

function copyId() {
  copyText(avatarId.value, '模型 ID 已复制');
}
</script>

<template>
  <Dialog v-model:visible="visible" :header="data && data.name ? '模型 · ' + data.name : '模型详情'" :style="{ width: 'min(520px, 94vw)' }"
    :dismissable-mask="true" :modal="true" :closeOnEscape="true" @show="load">
    <div v-if="loading" class="loading-mini"><ProgressSpinner style="width:28px;height:28px" strokeWidth="4" /></div>
    <div v-else-if="loadError" class="empty" style="padding:20px">
      <i class="pi pi-id-card empty-icon" aria-hidden="true"></i>
      模型加载失败：{{ loadError }}
      <div style="margin-top:12px"><Button size="small" icon="pi pi-refresh" label="重试" @click="load" /></div>
    </div>
    <div v-else-if="data" class="avd-body">
      <img v-if="data.imageUrl" :src="data.imageUrl" :alt="data.name" class="avd-img" loading="lazy" />
      <div v-else class="avd-noimg"><i class="pi pi-id-card"></i></div>
      <div class="avd-meta">
        <div class="avd-row"><span class="avd-label">ID</span><code class="mono avd-id">{{ data.avatarId }}</code></div>
        <div v-if="data.authorName" class="avd-row"><span class="avd-label">作者</span><span>{{ data.authorName }}</span></div>
        <div v-if="data.version" class="avd-row"><span class="avd-label">版本</span><span>v{{ data.version }}</span></div>
        <div v-if="data.unityVersion" class="avd-row"><span class="avd-label">Unity</span><span class="mono">{{ data.unityVersion }}</span></div>
        <div v-if="data.releaseStatus" class="avd-row">
          <span class="avd-label">状态</span>
          <span class="wd-badge" :class="data.releaseStatus === 'public' ? 'pub' : 'priv'">{{ data.releaseStatus === 'public' ? '公开' : data.releaseStatus }}</span>
        </div>
        <div v-if="data.tags && data.tags.length" class="avd-row">
          <span class="avd-label">标签</span>
          <span class="avd-tags"><span v-for="tg in data.tags.slice(0, 6)" :key="tg" class="chip avd-tag">{{ tg.replace(/^avatar_/,'').replace(/_/g,' ') }}</span><span v-if="data.tags.length > 6" class="avd-tmore">+{{ data.tags.length - 6 }}</span></span>
        </div>
        <div v-if="data.description" class="avd-desc">{{ data.description }}</div>
      </div>
      <div class="avd-actions">
        <Button size="small" icon="pi pi-external-link" label="打开 VRChat 页" @click="openVrcPage" />
        <Button size="small" icon="pi pi-copy" label="复制 ID" outlined @click="copyId" />
      </div>
    </div>
  </Dialog>
</template>

<style scoped>
.avd-body { display: flex; flex-direction: column; gap: 12px; }
.avd-img { width: 100%; max-height: 220px; object-fit: cover; border-radius: var(--radius); border: 1px solid var(--border); background: var(--surface-2); }
.avd-noimg { height: 120px; display: flex; align-items: center; justify-content: center; font-size: 28px; color: var(--text-dim); background: var(--surface-2); border-radius: var(--radius); border: 1px dashed var(--border); }
.avd-meta { display: flex; flex-direction: column; gap: 6px; }
.avd-row { display: flex; align-items: center; gap: 8px; font-size: 12px; min-width: 0; }
.avd-label { flex: none; width: 52px; color: var(--text-dim); font-size: 11px; }
.avd-id { font-size: 11px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.avd-desc { font-size: 12px; color: var(--text-dim); line-height: 1.6; max-height: 80px; overflow-y: auto; }
.avd-tags { display: flex; flex-wrap: wrap; gap: 4px; min-width: 0; }
.avd-tag { padding: 1px 8px; font-size: 10px; }
.avd-tmore { font-size: 10px; color: var(--text-dim); align-self: center; }
.avd-actions { display: flex; gap: 8px; flex-wrap: wrap; }
</style>
