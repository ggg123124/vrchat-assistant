<script setup>
import { ref, watch } from 'vue';
import { store, openUser, openWorld } from '../store.js';
import { get, imgUrl } from '../api.js';

const visible = computedLike(() => store.quickSearchOpen);
const q = ref('');
const local = ref([]);
const remote = ref([]);
const searching = ref(false);
let timer = null;

function computedLike(fn) {
  return {
    get: fn,
    set: (v) => { store.quickSearchOpen = v; },
  };
}

watch(() => store.quickSearchOpen, (v) => {
  if (v) {
    q.value = '';
    local.value = [];
    remote.value = [];
    setTimeout(() => { const el = document.querySelector('.qs-input input'); if (el) el.focus(); }, 50);
  }
});

watch(q, (v) => {
  clearTimeout(timer);
  const query = v.trim().toLowerCase();
  if (!query) { local.value = []; remote.value = []; return; }
  local.value = (store.friends || []).filter((f) => (f.displayName || '').toLowerCase().includes(query)).slice(0, 8);
  timer = setTimeout(async () => {
    searching.value = true;
    try {
      const d = await get(`/api/dashboard/search?q=${encodeURIComponent(v.trim())}&type=users&limit=8`);
      remote.value = d.items || d.users || d.results || [];
    } catch { remote.value = []; }
    searching.value = false;
  }, 300);
});

function pick(u) {
  store.quickSearchOpen = false;
  openUser(u.userId || u.id || u);
}
</script>

<template>
  <Dialog v-model:visible="visible" header="快速搜索" :style="{ width: 'min(460px, 94vw)' }" :dismissable-mask="true">
    <InputText v-model="q" placeholder="输入玩家名…（Enter 打开资料）" class="qs-input w-full" autocomplete="off" />
    <div v-if="searching" class="loading-mini"><ProgressSpinner style="width:22px;height:22px" strokeWidth="4" /></div>
    <div v-else-if="!q.trim()" class="empty" style="padding:16px">输入名字搜索好友 / VRChat 用户</div>
    <div v-else>
      <div v-if="local.length" class="qs-sec">
        <div class="qs-label">好友</div>
        <div v-for="f in local" :key="f.userId" class="qs-item" @click="pick(f)" role="button" tabindex="0" @keydown.enter="pick(f)">
          <Avatar :image="imgUrl(f.avatarUrl || f.userIcon)" shape="circle" size="small" :label="(f.displayName || '?').charAt(0).toUpperCase()" />
          <span class="qs-name">{{ f.displayName }}</span>
          <span class="qs-sub">{{ f.isOnline ? '在线' : '离线' }}</span>
        </div>
      </div>
      <div v-if="remote.length" class="qs-sec">
        <div class="qs-label">VRChat 用户</div>
        <div v-for="u in remote" :key="u.userId || u.id" class="qs-item" @click="pick(u)" role="button" tabindex="0" @keydown.enter="pick(u)">
          <Avatar :image="imgUrl(u.currentAvatarImageUrl || u.currentAvatarThumbnailImageUrl || u.userIcon)" shape="circle" size="small" :label="(u.displayName || '?').charAt(0).toUpperCase()" />
          <span class="qs-name">{{ u.displayName }}</span>
          <span class="qs-sub">{{ u.status || '' }}</span>
        </div>
      </div>
      <div v-if="!local.length && !remote.length && !searching" class="empty" style="padding:16px">未找到匹配用户</div>
    </div>
  </Dialog>
</template>

<style scoped>
.w-full { width: 100%; }
.loading-mini { display: flex; justify-content: center; padding: 20px; }
.qs-sec { margin-top: 12px; }
.qs-label { font-size: 11px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.4px; margin-bottom: 6px; }
.qs-item { display: flex; align-items: center; gap: 10px; padding: 7px 8px; border-radius: 8px; cursor: pointer; }
.qs-item:hover { background: var(--surface-2); }
.qs-name { font-weight: 600; font-size: 13px; }
.qs-sub { margin-left: auto; color: var(--text-dim); font-size: 11px; }
</style>
