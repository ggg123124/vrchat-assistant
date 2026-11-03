<script setup>
// 设置视图：动态状态（按在线好友数量自动更新自定义状态）等运行期配置。
// 后端：GET/POST /api/dashboard/dynamic-status（保存默认立即同步一次，绕过冷却）。
import { ref, onMounted } from 'vue';
import { get, post } from '../api.js';
import { toast } from '../toast.js';
import { readPref, setPref } from '../theme.js';

const enabled = ref(false);
const template = ref('');
const mode = ref('fixed');
const separator = ref(' · ');
const onlineNow = ref(null);
const lastSent = ref('');
const loading = ref(true);
const saving = ref(false);


// 主题：浅色 / 深色 / 跟随系统（持久化到 localStorage，首帧由 index.html 内联脚本先行应用）
const THEME_OPTIONS = [
  { v: 'light', label: '浅色', hint: '白底黑字，室内/白天看着更清楚' },
  { v: 'dark', label: '深色', hint: '黑底浅字，夜间使用' },
  { v: 'system', label: '跟随系统', hint: '随操作系统的深色模式自动切换' },
];
const themePref = ref(readPref());
function pickTheme(v) {
  themePref.value = v;
  setPref(v);
}

async function load() {
  loading.value = true;
  try {
    const r = await get('/api/dashboard/dynamic-status');
    enabled.value = !!r.enabled;
    mode.value = r.mode === 'suffix' ? 'suffix' : 'fixed';
    template.value = r.template || '';
    separator.value = r.separator || ' · ';
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
  const hasPh = ['{total}', '{online}', '{webOnline}', '{gameOnline}'].some((k) => tpl.includes(k));
  if (!hasPh && tpl.length > 0) {
    toast('模板建议包含占位符：{total}/{webOnline}/{gameOnline}（会替换为对应计数）', 'warn');
  }
  saving.value = true;
  try {
    const r = await post('/api/dashboard/dynamic-status', { enabled: enabled.value, mode: mode.value, template: tpl, separator: separator.value });
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
        <i class="pi pi-palette"></i>
        <b>外观主题</b>
        <span class="set-sub">选择界面配色；改动立即生效并记住，下次打开保持一致</span>
      </div>
      <div class="set-row">
        <div class="theme-radios">
          <label v-for="t in THEME_OPTIONS" :key="t.v" class="theme-opt" :class="{ active: themePref === t.v }">
            <input type="radio" :value="t.v" :checked="themePref === t.v" @change="pickTheme(t.v)" />
            <span class="theme-name">{{ t.label }}</span>
            <small class="theme-hint">{{ t.hint }}</small>
          </label>
        </div>
      </div>
    </div>
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
          <span class="set-label">模式</span>
          <div class="set-radios">
            <label><input type="radio" value="fixed" v-model="mode" /> 整段覆盖（历史行为）</label>
            <label><input type="radio" value="suffix" v-model="mode" /> 保留我写的正文，只在结尾加后缀</label>
          </div>
          <small class="set-hint">「保留正文」模式：你在 VRChat 里手打「打机中」，它会变成「打机中 · 在线 5 人」；你自己改文字不会被覆盖，只在结尾补或更新那截后缀；刚刚改过它会先等约 2 分钟再补。</small>
        </div>
        <div class="set-row">
          <label class="set-label" for="ds-template">{{ mode === 'suffix' ? '后缀文本模板' : '状态文本模板' }}</label>
          <input id="ds-template" v-model="template" class="set-input" maxlength="64"
            :placeholder="mode === 'suffix' ? '在线 {total} 人（会接在你正文后面）' : '在线 {total} 人'"
            aria-label="状态文本模板" />
          <small class="set-hint">可用占位符：{total}（总在线）、{webOnline}（网页/App 在线）、{gameOnline}（游戏内在线）；最长 64 字符（「保留正文」模式下超长时先截正文、保住计数）。频繁变更受 VRChat 接口限频，引擎内置 65 秒冷却、文本无变化不提交。</small>
        </div>
        <div class="set-row" v-if="mode === 'suffix'">
          <label class="set-label" for="ds-sep">分隔符</label>
          <input id="ds-sep" v-model="separator" class="set-input" maxlength="4" placeholder=" · " />
          <small class="set-hint">正文与后缀之间的连接符，默认「 · 」（两边各一个空格）。</small>
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
/* 原写法与 .set-radios（display:flex; flex-direction:column，同特异性且定义在后）冲突
   ⇒ 3 列网格是死代码、实际渲染成 1 列竖排（复审 EMeowAGENT ⚠️5）。
   现在不再共用 .set-radios，类名独立；font-size 等通用项在此显式补齐。 */
.theme-radios { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; width: 100%; font-size: 13px; }
@media (max-width: 640px) { .theme-radios { grid-template-columns: 1fr; } }
.theme-opt { display: flex; flex-direction: column; gap: 2px; padding: 9px 11px; border: 1px solid var(--border); border-radius: 8px; cursor: pointer; }
.theme-opt:hover { border-color: var(--text-dim); }
.theme-opt.active { border-color: var(--accent); background: var(--surface-2); }
.theme-opt input { margin: 0 0 4px; }
.theme-name { font-size: 13px; }
.theme-hint { color: var(--text-dim); font-size: 11px; line-height: 1.4; }
.set-card { background: var(--surface); border: 1px solid var(--border-soft); border-radius: 10px; padding: 16px; }
.set-radios { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
.set-radios label { display: flex; align-items: center; gap: 6px; }
.set-title { display: flex; align-items: baseline; gap: 8px; margin-bottom: 14px; }
.set-title i { color: var(--text-dim); }
.set-sub { color: var(--text-dim); font-size: 12px; }
.set-row { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
.set-toggle-row { flex-direction: row; align-items: center; flex-wrap: wrap; cursor: pointer; }
.set-toggle { width: 18px; height: 18px; accent-color: var(--accent, #7c5cff); }
.set-toggle-label { font-weight: 600; }
.set-toggle-hint { flex-basis: 100%; color: var(--text-dim); font-size: 12px; }
.set-label { font-weight: 600; }
.set-input { width: 100%; padding: 8px 10px; border: 1px solid var(--border-soft); border-radius: 6px; background: transparent; color: inherit; }
.set-hint { color: var(--text-dim); font-size: 12px; }
.set-meta { flex-direction: row; gap: 18px; color: var(--text-dim); font-size: 12px; flex-wrap: wrap; }
.set-actions { display: flex; gap: 10px; }
@media (max-width: 640px) { .settings-wrap { padding: 10px 8px; } .set-card { padding: 12px; } }
</style>
