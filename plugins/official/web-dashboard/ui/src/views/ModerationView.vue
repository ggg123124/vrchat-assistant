<script setup>
import { ref, onMounted, computed } from 'vue';
import { get, post } from '../api.js';
import { trustColor, avatarLabel, statusLabels } from '../utils.js';
import { openUser } from '../store.js';
import { toast } from '../toast.js';

// 屏蔽管理（对齐 VRCX Moderation）：黑名单 / 静音列表，可解除（按 userId+type，
// VRChat 无按 moderationId 删除端点，PUT /auth/user/unplayermoderate）。
const tab = ref('blocked');
const blocked = ref([]);
const muted = ref([]);
const loading = ref(false);
const acting = ref('');

const list = computed(() => (tab.value === 'blocked' ? blocked.value : muted.value));
const kindLabel = computed(() => (tab.value === 'blocked' ? '屏蔽' : '静音'));

async function load() {
  if (loading.value) return;
  loading.value = true;
  try {
    const r = await get('/api/dashboard/moderation');
    blocked.value = (r && r.blocked) || [];
    muted.value = (r && r.muted) || [];
  } catch (e) {
    toast('加载屏蔽列表失败：' + (e.message || e), 'error');
  } finally {
    loading.value = false;
  }
}

async function remove(x) {
  const type = tab.value === 'blocked' ? 'block' : 'mute';
  if (!window.confirm(`确认解除对「${x.displayName || x.userId}」的${kindLabel.value}？`)) return;
  const key = x.userId + ':' + type;
  if (acting.value === key) return;
  acting.value = key;
  try {
    const r = await post('/api/dashboard/moderation/delete', { userId: x.userId, type });
    if (r && r.ok) {
      toast(`已解除${kindLabel.value}`, 'success');
      const arr = tab.value === 'blocked' ? blocked : muted;
      arr.value = arr.value.filter((i) => i.userId !== x.userId);
    } else {
      toast((r && r.error) || '解除失败', 'error');
    }
  } catch (e) {
    toast('解除失败：' + (e.message || e), 'error');
  } finally {
    acting.value = '';
  }
}

const dot = (t) => {
  const c = trustColor(t);
  return c ? { style: { background: c } } : {};
};

onMounted(load);
</script>

<template>
  <div class="md">
    <div class="md-head">
      <h2><i class="pi pi-ban"></i> 屏蔽管理</h2>
      <span class="md-count">黑名单 / 静音列表 · 后端 30 分钟缓存</span>
      <Button size="small" text icon="pi pi-refresh" title="刷新" @click="load" />
    </div>

    <div class="md-chips" role="group" aria-label="列表筛选">
      <button class="chip" :class="{ active: tab === 'blocked' }" @click="tab = 'blocked'">黑名单 ({{ blocked.length }})</button>
      <button class="chip" :class="{ active: tab === 'muted' }" @click="tab = 'muted'">静音列表 ({{ muted.length }})</button>
    </div>

    <div v-if="loading && !list.length" class="loading-mini"><ProgressSpinner style="width:28px;height:28px" strokeWidth="4" /></div>
    <div v-else-if="!list.length" class="empty" style="padding:24px">暂无{{ kindLabel }}记录</div>
    <div v-else class="md-list">
      <div v-for="x in list" :key="x.userId" class="md-row">
        <span class="md-dot" v-bind="dot(x.trustLevel)" :title="x.trustLevel || ''"></span>
        <Avatar :image="x.avatarImageUrl || ''" :label="avatarLabel(x.avatarImageUrl, x.displayName)" shape="circle" size="normal" />
        <button class="md-info" @click="openUser(x.userId)">
          <b class="md-name">{{ x.displayName || x.userId }}</b>
          <small class="md-sub">{{ x.userId }} · {{ statusLabels[x.status] || x.status || '' }}</small>
        </button>
        <Button size="small" severity="danger" text :loading="acting === x.userId + ':' + (tab === 'blocked' ? 'block' : 'mute')" label="解除" @click="remove(x)" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.md { padding: 4px; }
.md-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.md-count { font-size: 11px; color: var(--text-dim); flex: 1; }
.md-chips { display: flex; align-items: center; gap: 6px; margin-bottom: 12px; }




.md-list { display: flex; flex-direction: column; gap: 4px; }
.md-row { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: 8px; background: var(--surface); border: 1px solid var(--border-soft); }
.md-row:hover { border-color: var(--accent); }
.md-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--text-dim); }
.md-info { min-width: 0; flex: 1; text-align: left; background: none; border: none; padding: 0; color: inherit; font-family: inherit; cursor: pointer; }
.md-info:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; border-radius: 4px; }
.md-name { font-size: 13px; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.md-sub { font-size: 11px; color: var(--text-dim); display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }


@media (max-width: 899px) {
  .md-chips { flex-wrap: wrap; }
}
</style>
