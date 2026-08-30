<script setup>
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { get } from '../api.js';
import { time, date } from '../utils.js';
import { toast } from '../toast.js';

// 服务运维日志：认证/连接生命周期（cookie 过期重登录、TOTP、WS 错误帧/断连、通知发送）
const items = ref(null);
const kindSel = ref('all');
const loading = ref(false);
const KINDS = [
  { v: 'all', l: '全部' },
  { v: 'auth', l: '认证' },
  { v: 'ws', l: '连接' },
  { v: 'ops', l: '运维' },
];
const KIND_LABEL = { auth: '认证', ws: '连接', ops: '运维' };
const LEVEL = {
  info: { label: '信息', severity: 'info', ico: 'pi-info-circle' },
  warn: { label: '警告', severity: 'warn', ico: 'pi-exclamation-triangle' },
  error: { label: '错误', severity: 'danger', ico: 'pi-times-circle' },
};
let timer = null;

async function load() {
  if (loading.value) return;
  loading.value = true;
  try {
    const q = kindSel.value === 'all' ? '' : '&kind=' + kindSel.value;
    const r = await get('/api/dashboard/ops-log?limit=200' + q);
    items.value = (r && r.items) || [];
  } catch (e) {
    items.value = items.value || [];
    toast('加载服务日志失败：' + (e.message || e), 'error');
  } finally {
    loading.value = false;
  }
}
function reload() {
  items.value = null;
  load();
}
function setKind(v) {
  if (kindSel.value === v) return;
  kindSel.value = v;
  load();
}
// 时间统一走 utils（本地时区），与动态页一致——此前直接切 ISO 字符串显示的是 UTC（用户反馈）
const shown = computed(() => items.value || []);

onMounted(() => {
  load();
  timer = setInterval(load, 30000);
});
onUnmounted(() => clearInterval(timer));
</script>

<template>
  <div class="lv">
    <div class="lv-head">
      <h2><i class="pi pi-history"></i> 服务日志</h2>
      <span class="lv-count">认证 / 连接生命周期 · 保留最近 500 条</span>
      <Button size="small" text icon="pi pi-refresh" title="刷新" @click="reload" />
    </div>

    <div class="lv-chips" role="group" aria-label="日志类别筛选">
      <button v-for="k in KINDS" :key="k.v" class="chip" :class="{ active: kindSel === k.v }" @click="setKind(k.v)">{{ k.l }}</button>
    </div>

    <div v-if="items === null" class="loading-mini"><ProgressSpinner style="width:28px;height:28px" strokeWidth="4" /></div>
    <div v-else-if="!shown.length" class="empty" style="padding:24px">暂无日志记录（服务运行平稳时此处安静是正常的）</div>
    <div v-else class="lv-list">
      <div v-for="x in shown" :key="x.id" class="lv-row">
        <span class="lv-time mono" :title="x.created_at">{{ time(x.created_at) }}<small>{{ date(x.created_at) }}</small></span>
        <Tag :value="KIND_LABEL[x.kind] || x.kind" :severity="x.kind === 'ws' ? 'info' : 'contrast'" rounded />
        <Tag :value="LEVEL[x.level]?.label || x.level" :severity="LEVEL[x.level]?.severity || 'secondary'" rounded><i class="pi lv-ico" :class="LEVEL[x.level]?.ico || 'pi-circle'"></i></Tag>
        <span class="lv-msg" :title="x.message">{{ x.message }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.lv { padding: 4px; }
.lv-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.lv-count { font-size: 11px; color: var(--text-dim); flex: 1; }
.lv-chips { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; }




.lv-list { display: flex; flex-direction: column; gap: 4px; }
.lv-ico { font-size: 9px; margin-right: 4px; }
.lv-row { display: flex; align-items: center; gap: 9px; padding: 6px 8px; border-radius: 8px; background: var(--surface); border: 1px solid var(--border-soft); }
.lv-row:hover { border-color: var(--accent); }
.lv-time { font-size: 11px; color: var(--text-dim); flex: none; width: 76px; }
.lv-time small { margin-left: 5px; opacity: 0.75; }
.lv-msg { font-size: 12px; min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

@media (max-width: 899px) {
  .lv-chips { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; -webkit-overflow-scrolling: touch; padding-bottom: 2px; }
  .lv-chips::-webkit-scrollbar { display: none; }
  .lv-row { flex-wrap: wrap; row-gap: 2px; }
  .lv-msg { white-space: normal; }
}
</style>
