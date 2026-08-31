<script setup>
import { ref } from 'vue';
import { openUser, openWorld, openAvatar, openGroup } from '../store.js';
import { toast } from '../toast.js';

// 直接打开：粘贴 VRChat ID 或网页链接 → 打开对应资料弹窗
const targetId = ref('');

function open() {
  const t = targetId.value.trim();
  if (!t) return;
  const m = t.match(/(usr|wrld|avtr|grp)_[a-f0-9-]+/i);
  if (!m) {
    toast('未能识别有效的 VRChat ID', 'warn');
    return;
  }
  const id = m[0];
  if (id.startsWith('usr_')) openUser(id);
  else if (id.startsWith('wrld_')) openWorld(id);
  else if (id.startsWith('avtr_')) openAvatar(id);
  else if (id.startsWith('grp_')) openGroup(id);
  targetId.value = '';
}
</script>

<template>
  <div class="op">
    <div class="op-head">
      <h2><i class="pi pi-external-link"></i> 直接打开</h2>
      <span class="op-count">支持 usr_ / wrld_ / avtr_ / grp_ 格式或 vrchat.com 网页链接</span>
    </div>

    <div class="op-box">
      <InputText v-model="targetId" placeholder="粘贴 ID 或链接，回车打开…" class="op-input" aria-label="VRChat ID 或链接" @keydown.enter="open" />
      <Button label="直接打开" icon="pi pi-arrow-right" size="small" @click="open" />
    </div>
    <p class="op-note">
      <i class="pi pi-info-circle"></i>
      打开后会弹出对应的资料/详情弹窗（用户、世界、模型或群组），也可在「工具」页生成并复制标准链接。
    </p>
  </div>
</template>

<style scoped>
.op { padding: 4px; }
.op-head { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
.op-count { font-size: 11px; color: var(--text-dim); flex: 1; }
.op-box { display: flex; gap: 10px; max-width: 560px; }
.op-input { flex: 1; }
.op-note { font-size: 12px; color: var(--text-dim); margin-top: 12px; line-height: 1.6; }
@media (max-width: 899px) {
  .op-box { flex-direction: column; }
}
</style>
