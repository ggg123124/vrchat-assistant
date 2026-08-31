<script setup>
import { ref, onMounted, computed } from 'vue';
import { get } from '../api.js';
import { openGroup , copyText } from '../store.js';
import { toast } from '../toast.js';

// 我的群组（get_user_groups；详情由 GroupDialog 走 /group 接口带缓存）
const data = ref(null);
const loading = ref(false);
const q = ref('');

// 最新公告懒加载（每个群组一次本地查询，秒回）
const annMap = ref({});
const annLoading = ref(new Set());
async function loadAnn(g) {
  const gid = g.groupId || g.name;
  if (annLoading.value.has(gid) || annMap.value[gid] !== undefined) return;
  annLoading.value.add(gid);
  try {
    const r = await get('/api/dashboard/group-announcements?groupId=' + encodeURIComponent(gid) + '&limit=1');
    annMap.value = { ...annMap.value, [gid]: (r && r.announcements && r.announcements[0]) || null };
  } catch {
    annMap.value = { ...annMap.value, [gid]: null };
  } finally {
    annLoading.value.delete(gid);
  }
}
function copyGroupLink(g) {
  const gid = g.groupId || g.name;
  if (!String(gid).startsWith('grp_')) { toast('无群组 ID，无法生成链接', 'warn'); return; }
  copyText('https://vrchat.com/home/group/' + gid);
  toast('群组链接已复制', 'success');
}

function annText(g) {
  const a = annMap.value[g.groupId || g.name];
  return a ? (a.title || a.text || '').slice(0, 40) : '';
}
function annLoadTriggered(g) {
  // 行挂载时触发懒加载（用 onMounted 的 nextTick 兜底：模板只读，不在这里触发）
  return true;
}

async function load() {
  if (loading.value) return;
  loading.value = true;
  try {
    const r = await get('/api/dashboard/my-groups');
    if (r && r.error) throw new Error(r.error);
    data.value = r;
  } catch (e) {
    data.value = { groups: [] };
    toast('加载群组失败：' + (e.message || e), 'error');
  } finally {
    loading.value = false;
  }
}

const groups = computed(() => {
  const list = (data.value && data.value.groups) || [];
  const query = q.value.trim().toLowerCase();
  if (!query) return list;
  return list.filter((g) =>
    (g.name || '').toLowerCase().includes(query) || (g.groupId || '').includes(query) || (g.shortCode || '').toLowerCase().includes(query));
});

const RANK_LABEL = { owner: '群主', admin: '管理员', moderator: '版主', member: '成员', invited: '已受邀', banned: '已封禁' };
const rankLabel = (r) => RANK_LABEL[r] || r || '';

onMounted(async () => {
  await load();
  // 首屏群组最新公告批量懒加载（限 8 个避免瞬时并发）
  const gs = (groups.value || []).slice(0, 8);
  gs.forEach((g) => loadAnn(g));
});
</script>

<template>
  <div class="mg">
    <div class="mg-head">
      <h2><i class="pi pi-users"></i> 我的群组</h2>
      <span class="mg-count">{{ data ? '共 ' + data.count + ' 个 · 点击打开群组详情' : '' }}</span>
      <InputText v-model="q" placeholder="搜索群组…" class="mg-search" aria-label="搜索群组" />
      <Button size="small" text icon="pi pi-refresh" title="刷新" @click="load" />
    </div>

    <div v-if="loading && !data" class="loading-mini"><ProgressSpinner style="width:28px;height:28px" strokeWidth="4" /></div>
    <div v-else-if="!groups.length" class="empty" style="padding:24px">
      {{ q ? '无匹配群组' : '暂未加入任何群组' }}
    </div>
    <div v-else class="mg-list">
      <button v-for="g in groups" :key="g.groupId || g.name" class="mg-row" @click="loadAnn(g); openGroup(g.groupId || g.name)">
        <div class="mg-icon"><i class="pi pi-users"></i></div>
        <Button v-if="String(g.groupId || '').startsWith('grp_')" class="mg-copy" icon="pi pi-link" text size="small" rounded :aria-label="'复制群组链接 ' + (g.name || '')" title="复制群组链接" @click.stop="copyGroupLink(g)" />
        <div class="mg-info">
          <b class="mg-name">{{ g.name || g.groupId }}</b>
          <small v-if="annText(g)" class="mg-ann" :title="'最新公告：' + annText(g)"><i class="pi pi-megaphone"></i> {{ annText(g) }}</small>
          <small class="mg-sub">
            <template v-if="g.shortCode">#{{ g.shortCode }} · </template>
            {{ g.memberCount != null ? g.memberCount + ' 成员' : '' }}{{ g.myRank ? ' · ' + rankLabel(g.myRank) : '' }}
          </small>
        </div>
        <span v-if="g.isVerified" class="mg-verified" title="已认证群组"><i class="pi pi-verified"></i></span>
        <i class="pi pi-chevron-right mg-arrow"></i>
      </button>
    </div>
  </div>
</template>

<style scoped>
.mg { padding: 4px; }
.mg-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
.mg-count { font-size: 11px; color: var(--text-dim); flex: 1; min-width: 120px; }
.mg-search { width: 180px; }
.mg-list { display: flex; flex-direction: column; gap: 4px; }
.mg-row { display: flex; align-items: center; gap: 10px; padding: 8px; border-radius: 10px; background: var(--surface); border: 1px solid var(--border-soft); cursor: pointer; text-align: left; width: 100%; color: inherit; font-family: inherit; transition: border-color 0.12s; }
.mg-row:hover { border-color: var(--accent); }
.mg-row:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.mg-icon { width: 42px; height: 42px; border-radius: 10px; background: var(--surface-2); display: flex; align-items: center; justify-content: center; color: var(--accent); flex: none; font-size: 18px; }
.mg-info { min-width: 0; flex: 1; }
.mg-name { font-size: 14px; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mg-ann { display: block; font-size: 10px; color: var(--accent); opacity: 0.85; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.mg-copy { flex: none; margin-left: auto; }
.mg-sub { font-size: 11px; color: var(--text-dim); display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mg-verified { color: var(--accent); flex: none; }
.mg-arrow { color: var(--text-dim); flex: none; font-size: 12px; }


@media (max-width: 899px) {
  .mg-search { width: 100%; order: 3; }
}
</style>
