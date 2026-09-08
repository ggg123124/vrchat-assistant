<script setup>
// 设置视图：动态状态（按在线好友数量自动更新自定义状态）等运行期配置。
// 后端：GET/POST /api/dashboard/dynamic-status（保存默认立即同步一次，绕过冷却）。
import { ref, onMounted } from 'vue';
import { get, post } from '../api.js';
import { toast } from '../toast.js';

const enabled = ref(false);
const template = ref('');
const onlineNow = ref(null);
const lastSent = ref('');
const loading = ref(true);
const saving = ref(false);

async function load() {
  loading.value = true;
  try {
    const r = await get('/api/dashboard/dynamic-status');
    enabled.value = !!r.enabled;
    template.value = r.template || '';
    onlineNow.value = (r.onlineNow ?? null);
    lastSent.value = r.lastSent || '';
  } catch (e) {
    toast('加载失败：' + (e.message || e), 'error');
  } finally {
    loading.value = false;
  }
}

async function save() {
  if (saving.value) return;
  const tpl = template.value.trim();
  if (tpl.includes('{online}') === false && tpl.length > 0) {
    toast('模板建议包含 {online} 占位符（会替换为当前在线好友数）', 'warn');
  }
  saving.value = true;
  try {
    const r = await post('/api/dashboard/dynamic-status', { enabled: enabled.value, template: tpl });
    if (r && r.error) throw new Error(r.error);
    const sr = r.syncResult || {};
    if (sr.action === 'synced') {
      toast(`已保存并同步状态：${sr.statusDescription}`, 'success');
      lastSent.value = sr.statusDescription || lastSent.value;
    } else if (sr.reason === 'unchanged') {
      toast('已保存（状态文本无变化，未提交 API）', 'info');
    } else if (sr.reason === 'cooldown') {
      toast('已保存；刚提交过状态，稍后自动同步', 'info');
    } else {
      toast('已保存', 'success');
    }
    // onlineNow 由 finally 的 load() 随最新配置刷新（review #166：原三元恒等无操作，移除）
  } catch (e) {
    toast('保存失败：' + (e.message || e), 'error');
  } finally {
    saving.value = false;
    await load();
  }
}

onMounted(load);
</script>

<template>
  <div class="page-head"><h2>设置</h2></div>
  <div class="settings-wrap">
    <div class="set-card">
      <div class="set-title">
        <i class="pi pi-sync"></i>
        <b>动态状态</b>
        <span class="set-sub">根据在线好友数量自动更新自己的自定义状态（statusDescription）</span>
      </div>
      <div v-if="loading" class="set-loading">加载中…</div>
      <template v-else>
        <label class="set-row set-toggle-row">
          <input type="checkbox" v-model="enabled" class="set-toggle" />
          <span class="set-toggle-label">启用动态状态</span>
          <span class="set-toggle-hint">开启后好友上下线时自动更新；状态种类（在线/忙碌等）保持不变，只改自定义文本</span>
        </label>
        <div class="set-row">
          <label class="set-label" for="ds-template">状态文本模板</label>
          <input id="ds-template" v-model="template" class="set-input" maxlength="64"
            placeholder="在线 {online} 人" aria-label="状态文本模板" />
          <small class="set-hint">{online} 会替换为当前在线好友数；最长 64 字符。频繁变更受 VRChat 接口限频，引擎内置 65 秒冷却且文本无变化不提交。</small>
        </div>
        <div class="set-row set-meta">
          <span>当前在线好友：<b>{{ onlineNow ?? '—' }}</b></span>
          <span v-if="lastSent">最近提交：<b>{{ lastSent }}</b></span>
        </div>
        <div class="set-actions">
          <Button :loading="saving" label="保存" icon="pi pi-check" @click="save" />
          <Button text label="刷新" icon="pi pi-refresh" @click="load" />
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.settings-wrap { padding: 12px 14px; max-width: 720px; }
.set-card { background: var(--surface-a, #fff); border: 1px solid var(--surface-border, #ddd); border-radius: 10px; padding: 16px; }
.set-title { display: flex; align-items: baseline; gap: 8px; margin-bottom: 14px; }
.set-title i { color: var(--text-color-secondary, #888); }
.set-sub { color: var(--text-color-secondary, #888); font-size: 12px; }
.set-row { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
.set-toggle-row { flex-direction: row; align-items: center; flex-wrap: wrap; cursor: pointer; }
.set-toggle { width: 18px; height: 18px; accent-color: var(--primary-color, #3f6ad8); }
.set-toggle-label { font-weight: 600; }
.set-toggle-hint { flex-basis: 100%; color: var(--text-color-secondary, #888); font-size: 12px; }
.set-label { font-weight: 600; }
.set-input { width: 100%; padding: 8px 10px; border: 1px solid var(--surface-border, #ccc); border-radius: 6px; background: transparent; color: inherit; }
.set-hint { color: var(--text-color-secondary, #888); font-size: 12px; }
.set-meta { flex-direction: row; gap: 18px; color: var(--text-color-secondary, #888); font-size: 12px; flex-wrap: wrap; }
.set-actions { display: flex; gap: 10px; }
@media (max-width: 640px) { .settings-wrap { padding: 10px 8px; } .set-card { padding: 12px; } }
</style>
