<script setup>
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { get } from '../api.js';
import { LOG_KINDS, LOG_KIND_LABEL } from '../constants/log-kinds.js';
import { time, date } from '../utils.js';
import { toast } from '../toast.js';

// 服务日志：两个来源
//  - 数据库（ops_log）：认证/连接生命周期打点（cookie 过期重登录、TOTP、WS 错误帧/断连、通知发送）
//  - 文件（monitor.log）：structured logger 落盘的完整文件日志（app/ws 命名 logger 的 info/warn/error）
const items = ref(null);
const src = ref('db');          // 'db' 数据库 | 'file' 文件
const kindSel = ref('all');     // 数据库来源：kind 类别
const lvlSel = ref('all');      // 文件来源：最低级别
const nameSel = ref('all');     // 文件来源：logger 标签
const qSel = ref('');           // 文件来源：关键词
const loading = ref(false);
const fileExists = ref(true);   // monitor.log 是否存在
const filePath = ref('');

const SOURCES = [
  { v: 'db', l: '数据库' },
  { v: 'file', l: '文件' },
];
const KINDS = LOG_KINDS;
const KIND_LABEL = LOG_KIND_LABEL;
const LEVELS_FILTER = [
  { v: 'all', l: '全部' },
  { v: 'warn', l: '警告+' },
  { v: 'error', l: '错误' },
];
const NAMES = [
  { v: 'all', l: '全部' },
  { v: 'app', l: 'app' },
  { v: 'ws', l: 'ws' },
  { v: 'mcp', l: 'mcp' },
  { v: 'storage', l: 'storage' },
  { v: 'migrate', l: 'migrate' },
];
const LEVEL = {
  debug: { label: '调试', severity: 'secondary', ico: 'pi-circle' },
  info: { label: '信息', severity: 'info', ico: 'pi-info-circle' },
  warn: { label: '警告', severity: 'warn', ico: 'pi-exclamation-triangle' },
  error: { label: '错误', severity: 'danger', ico: 'pi-times-circle' },
};
let timer = null;

function rowTime(x) {
  return x.createdAt || x.created_at || x.ts || '';
}

async function load() {
  if (loading.value) return;
  loading.value = true;
  try {
    if (src.value === 'db') {
      const q = kindSel.value === 'all' ? '' : '&kind=' + kindSel.value;
      const r = await get('/api/dashboard/ops-log?limit=200' + q);
      items.value = (r && r.items) || [];
      fileExists.value = true;
    } else {
      const p = new URLSearchParams();
      p.set('limit', '200');
      if (lvlSel.value !== 'all') p.set('level', lvlSel.value);
      if (nameSel.value !== 'all') p.set('name', nameSel.value);
      if (qSel.value.trim()) p.set('q', qSel.value.trim());
      const r = await get('/api/dashboard/logger?' + p.toString());
      items.value = (r && r.items) || [];
      if (r && r.info) {
        fileExists.value = !!r.info.exists;
        filePath.value = r.info.filePath || '';
      }
    }
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
function setSrc(v) {
  if (src.value === v) return;
  src.value = v;
  reload();
}
function setKind(v) {
  if (kindSel.value === v) return;
  kindSel.value = v;
  load();
}
function setLevel(v) {
  if (lvlSel.value === v) return;
  lvlSel.value = v;
  reload();
}
function setName(v) {
  if (nameSel.value === v) return;
  nameSel.value = v;
  reload();
}
let qTimer = null;
function onQInput() {
  clearTimeout(qTimer);
  qTimer = setTimeout(reload, 300);
}
// 时间统一走 utils（本地时区），与动态页一致——此前直接切 ISO 字符串显示的是 UTC（用户反馈）
const shown = computed(() => items.value || []);

// 顶栏说明随来源切换：数据库=五类生命周期打点；文件=monitor.log 完整日志
const lvNote = computed(() =>
  src.value === 'file'
    ? 'monitor.log 完整文件日志 · 级别 / 标签 / 关键词筛选'
    : '认证 / 连接 / 运维 / 接口 / 外部服务生命周期打点 · 保留最近 500 条'
);

onMounted(() => {
  load();
  timer = setInterval(load, 30000);
});
onUnmounted(() => {
  clearInterval(timer);
  clearTimeout(qTimer);
});
</script>

<template>
  <div class="lv">
    <div class="lv-head">
      <h2><i class="pi pi-history"></i> 服务日志</h2>
      <span class="lv-count">{{ lvNote }}</span>
      <Button size="small" text icon="pi pi-refresh" title="刷新" @click="reload" aria-label="刷新" />
    </div>

    <div class="lv-src" role="group" aria-label="日志来源">
      <button v-for="s in SOURCES" :key="s.v" class="chip chip-src" :class="{ active: src === s.v }" @click="setSrc(s.v)">{{ s.l }}</button>
    </div>

    <div v-if="src === 'db'" class="lv-chips" role="group" aria-label="日志类别筛选">
      <button v-for="k in KINDS" :key="k.v" class="chip" :class="{ active: kindSel === k.v }" @click="setKind(k.v)">{{ k.l }}</button>
    </div>

    <div v-else class="lv-filebar">
      <div class="lv-chips" role="group" aria-label="日志级别筛选">
        <button v-for="l in LEVELS_FILTER" :key="l.v" class="chip" :class="{ active: lvlSel === l.v }" @click="setLevel(l.v)">{{ l.l }}</button>
      </div>
      <div class="lv-chips" role="group" aria-label="日志来源标签筛选">
        <button v-for="n in NAMES" :key="n.v" class="chip" :class="{ active: nameSel === n.v }" @click="setName(n.v)">{{ n.l }}</button>
      </div>
      <input class="lv-q" type="text" placeholder="关键词…" aria-label="按关键词筛选日志" v-model="qSel" @input="onQInput" />
    </div>

    <div v-if="src === 'file' && fileExists === false" class="lvhint">
      <i class="pi pi-info-circle"></i> 文件日志 (monitor.log) 不存在：该来源未启用或尚未落盘。
    </div>

    <div v-if="items === null" class="loading-mini"><ProgressSpinner style="width:28px;height:28px" strokeWidth="4" /></div>
    <div v-else-if="!shown.length" class="empty" style="padding:24px">
      {{ src === 'file' ? '暂无文件日志条目（试调低筛选或稍后刷新）' : '暂无日志记录（服务运行平稳时此处安静是正常的）' }}
    </div>
    <div v-else class="lv-list">
      <div v-for="(x, i) in shown" :key="(src === 'file' ? 'f' : 'd') + '-' + i + '-' + x.ts" class="lv-row">
        <span class="lv-time mono" :title="rowTime(x)">{{ time(rowTime(x)) }}<small>{{ date(rowTime(x)) }}</small></span>
        <template v-if="src === 'db'">
          <Tag :value="KIND_LABEL[x.kind] || x.kind" :severity="x.kind === 'ws' ? 'info' : 'secondary'" rounded />
        </template>
        <template v-else>
          <Tag :value="x.name" severity="info" rounded class="lv-name" />
        </template>
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
.lv-src { display: flex; align-items: center; gap: 6px; margin-bottom: 10px; }
.lv-filebar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
.lv-filebar .lv-chips { margin-bottom: 0; }
.lv-q {
  flex: 0 0 140px; min-width: 100px; padding: 4px 8px; font-size: 12px;
  color: var(--text); background: var(--surface); border: 1px solid var(--border-soft);
  border-radius: 8px; outline: none;
}
.lv-q:focus { border-color: var(--accent); }
.lv-name { text-transform: lowercase; min-width: 46px; justify-content: center; }
.lvhint { font-size: 11px; color: var(--warn-text, var(--warn)); margin-bottom: 10px; display: flex; align-items: center; gap: 6px; }
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
  .lv-filebar { flex-wrap: nowrap; overflow-x: auto; }
}
</style>
