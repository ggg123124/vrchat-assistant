<script setup>
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { get } from '../api.js';
import { locLabel, platformLabel, platformIcon, trustColor, statusLabels } from '../utils.js';
import { openUser, openWorld, copyText } from '../store.js';

const statusText = (s) => statusLabels[s] || '';

// 房间玩家列表（VRCX PlayerList）：当前所在实例 + 同房在线好友。
// 诚实限制：VRChat API 不暴露非好友玩家（VRCX 靠 Photon 抓包），服务器端仅好友可见。
const data = ref(null);
const loading = ref(false);

async function load() {
  if (loading.value) return;
  loading.value = true;
  try {
    data.value = await get('/api/dashboard/player-list');
  } catch (e) {
    data.value = { inInstance: false, error: String(e.message || e) };
  } finally {
    loading.value = false;
  }
}

const players = computed(() => (data.value && Array.isArray(data.value.players) ? data.value.players : []));
const trustDot = (t) => {
  const c = trustColor(t);
  return c ? { style: { background: c } } : {};
};

// 30 秒自动刷新（对齐文案；卸载时清理）
let timer = null;
function copyPlayerLink(p) {
  const uid = p.userId;
  if (!String(uid).startsWith('usr_')) { toast('无用户 ID', 'warn'); return; }
  copyText('https://vrchat.com/home/user/' + uid);
  toast('玩家链接已复制', 'success');
}

onMounted(() => {
  load();
  timer = setInterval(load, 30000);
});
onUnmounted(() => { if (timer) clearInterval(timer); });
</script>

<template>
  <div class="pl">
    <div class="pl-head">
      <h2><i class="pi pi-id-card"></i> 房间玩家</h2>
      <span class="pl-count">当前实例同房好友 · 30 秒自动刷新</span>
      <Button size="small" text icon="pi pi-refresh" title="刷新" @click="load" />
    </div>

    <div v-if="data === null" class="loading-mini"><ProgressSpinner style="width:28px;height:28px" strokeWidth="4" /></div>

    <template v-else-if="data && data.inInstance">
      <button type="button" class="pl-world" @click="openWorld(data.world && data.world.worldId)">
        <img v-if="data.world && data.world.imageUrl" class="pl-cover" :src="data.world.imageUrl" :alt="data.world.name" @error="(e) => { e.target.style.display = 'none'; }" />
        <div class="pl-winfo">
          <b class="pl-wname">{{ (data.world && data.world.name) || (data.world && data.world.worldId) || '未知世界' }}</b>
          <small class="pl-wsub">
            {{ locLabel(data.location) }} · {{ data.instance && data.instance.capacity ? '容量 ' + data.instance.capacity : '' }}
            <template v-if="data.instance && data.instance.platforms && data.instance.platforms.length"> · 平台 {{ data.instance.platforms.join('/') }}</template>
          </small>
          <small class="pl-wsub">同房好友 {{ players.length }} 人</small>
        </div>
        <Button v-if="data.world && data.world.worldId" text size="small" icon="pi pi-external-link" title="查看世界资料" @click.stop="openWorld(data.world.worldId)" />
      </button>

      <div class="pl-list">
        <button v-for="p in players" :key="p.userId" class="pl-row" @click="openUser(p.userId)">
          <Button v-if="String(p.userId || '').startsWith('usr_')" class="pl-copy" icon="pi pi-link" text size="small" rounded :aria-label="'复制玩家链接 ' + (p.displayName || '')" title="复制玩家链接" @click.stop="copyPlayerLink(p)" />
          <span class="pl-dot" v-bind="trustDot(p.trustLevel)" :title="p.trustLevel || ''"></span>
          <Avatar :image="p.avatarUrl || p.userIcon || ''" :label="(p.displayName || '?').charAt(0).toUpperCase()" shape="circle" size="normal" />
          <div class="pl-info">
            <b class="pl-name">{{ p.displayName }}</b>
            <small class="pl-sub">{{ p.statusDescription || statusText(p.status) || p.userId }}</small>
          </div>
          <span class="pl-platform" :title="platformLabel(p.platform)">
            <i v-if="platformIcon(p.platform)" :class="'pi ' + platformIcon(p.platform)"></i>
            <template v-else>{{ platformLabel(p.platform) }}</template>
          </span>
        </button>
        <div v-if="!players.length" class="empty" style="padding:20px">同房暂无私密好友（非好友玩家 API 不暴露）</div>
      </div>
    </template>

    <div v-else class="empty" style="padding:32px">
      <i class="pi pi-home" style="font-size:26px;display:block;margin-bottom:10px"></i>
      当前不在任何 VRChat 实例中{{ data && data.error ? '（' + data.error + '）' : '' }}
    </div>
  </div>
</template>

<style scoped>
.pl { padding: 4px; }
.pl-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.pl-count { font-size: 11px; color: var(--text-dim); flex: 1; }
.pl-world { display: flex; align-items: center; gap: 12px; padding: 10px; border-radius: 10px; background: var(--surface); border: 1px solid var(--border-soft); margin-bottom: 10px; cursor: pointer; text-align: left; width: 100%; color: inherit; font-family: inherit; }
.pl-world:hover { border-color: var(--accent); }
.pl-world:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.pl-cover { width: 72px; height: 40px; object-fit: cover; border-radius: 6px; flex: none; }
.pl-winfo { min-width: 0; flex: 1; }
.pl-wname { font-size: 13px; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pl-wsub { font-size: 11px; color: var(--text-dim); display: block; }
.pl-list { display: flex; flex-direction: column; gap: 4px; }
.pl-copy { flex: none; margin-left: auto; }
.pl-row { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: 8px; background: var(--surface); border: 1px solid var(--border-soft); cursor: pointer; text-align: left; width: 100%; color: inherit; font-family: inherit; transition: border-color 0.12s; }
.pl-row:hover { border-color: var(--accent); }
.pl-row:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.pl-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--text-dim); }
.pl-info { min-width: 0; flex: 1; }
.pl-name { font-size: 13px; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pl-sub { font-size: 11px; color: var(--text-dim); display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pl-platform { font-size: 11px; color: var(--text-dim); flex: none; }


@media (max-width: 899px) {
  .pl-world { flex-wrap: wrap; }
}
</style>
