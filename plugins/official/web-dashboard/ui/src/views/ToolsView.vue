<script setup>
import { ref, computed } from 'vue';
import { get } from '../api.js';
import { store, openUser, openWorld, openAvatar, openGroup, copyText } from '../store.js';
import { toast } from '../toast.js';

// 工具：手动同步 + VRChat ID → 链接生成/复制/打开弹窗
const syncing = ref(false);
const idInput = ref('');

async function syncNow() {
  if (syncing.value) return;
  syncing.value = true;
  try {
    const f = await get('/api/dashboard/friends?limit=1000');  // issue #127：同步也全量
    if (f && Array.isArray(f.friends)) {
      store.friends = f.friends;
      toast(`已同步好友列表（${f.friends.length} 人）`, 'success');
    } else {
      throw new Error('响应格式异常');
    }
  } catch (e) {
    toast('同步失败：' + (e.message || e), 'error');
  } finally {
    syncing.value = false;
  }
}

// 从输入提取 ID（支持纯 ID 或 vrchat.com 网页链接）
const parsed = computed(() => {
  const t = idInput.value.trim();
  const m = t.match(/(usr|wrld|avtr|grp)_[a-f0-9-]+/i);
  return m ? m[0] : '';
});
const link = computed(() => {
  if (!parsed.value) return '';
  const type = parsed.value.slice(0, 4);
  const map = { usr: 'user', wrld: 'world', avtr: 'avatar', grp: 'group' };
  return `https://vrchat.com/home/${map[type]}/${parsed.value}`;
});

function openById() {
  if (!parsed.value) {
    toast('未能识别有效的 VRChat ID', 'warn');
    return;
  }
  const id = parsed.value;
  if (id.startsWith('usr_')) openUser(id);
  else if (id.startsWith('wrld_')) openWorld(id);
  else if (id.startsWith('avtr_')) openAvatar(id);
  else if (id.startsWith('grp_')) openGroup(id);
}
</script>

<template>
  <div class="tw">
    <div class="tw-head">
      <h2><i class="pi pi-wrench"></i> 工具</h2>
      <span class="tw-count">快捷操作与 VRChat ID 工具</span>
    </div>

    <div class="tw-grid">
      <div class="tcard">
        <h3><i class="pi pi-sync"></i> 手动同步</h3>
        <p>向后端请求全量好友状态同步（刷新右侧好友栏与好友数据）。动态数据本身由 SSE 实时推送，一般无需手动。</p>
        <Button label="立即同步" icon="pi pi-sync" size="small" :loading="syncing" @click="syncNow" />
      </div>

      <div class="tcard">
        <h3><i class="pi pi-external-link"></i> ID 跳转与链接</h3>
        <p>粘贴 VRChat ID（<code>usr_</code> / <code>wrld_</code> / <code>avtr_</code> / <code>grp_</code>）或 vrchat.com 网页链接，可打开资料弹窗或复制标准链接。</p>
        <div class="trow">
          <InputText v-model="idInput" placeholder="粘贴 ID 或链接…" class="t-input" aria-label="VRChat ID 输入" @keydown.enter="openById" />
          <Button label="打开" icon="pi pi-arrow-right" size="small" @click="openById" :disabled="!parsed" />
        </div>
        <div v-if="link" class="tlink">
          <code class="t-code">{{ link }}</code>
          <Button icon="pi pi-copy" text rounded size="small" :aria-label="'复制链接'" :title="'复制链接'" @click="copyText(link)" />
        </div>
        <div v-else class="t-hint">支持格式：usr_xxx / wrld_xxx / avtr_xxx / grp_xxx</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tw { padding: 4px; }
.tw-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.tw-count { font-size: 11px; color: var(--text-dim); flex: 1; }
.tw-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
.tcard { background: var(--surface); border: 1px solid var(--border-soft); border-radius: 10px; padding: 14px 16px; }
.tcard h3 { font-size: 13px; font-weight: 700; margin: 0 0 8px; display: flex; align-items: center; gap: 6px; }
.tcard p { font-size: 12px; color: var(--text-dim); margin: 0 0 12px; line-height: 1.6; }
.tcard code { font-family: var(--font-mono, monospace); background: var(--surface-2); padding: 1px 5px; border-radius: 4px; font-size: 11px; }
.trow { display: flex; gap: 8px; }
.t-input { flex: 1; }
.tlink { display: flex; align-items: center; gap: 6px; margin-top: 10px; }
.t-code { font-size: 11px; background: var(--surface-2); border-radius: 6px; padding: 5px 8px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
.t-hint { font-size: 11px; color: var(--text-dim); margin-top: 10px; }
</style>
