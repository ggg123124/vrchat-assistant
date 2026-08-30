<script setup>
import { computed } from 'vue';
import { store, openUser, openInstance, openWorld } from '../store.js';
import { trustColor, avatarLabel, platformLabel, platformIcon, locLabelFull } from '../utils.js';
import { useFriendGroups, friendDotStyle } from '../composables/useFriendGroups.js';

// 分组/折叠/签名/状态点统一走公共 composable（C5，与右侧好友栏同源）
const { collapsed, toggleGroup, isCollapsed, sameInstanceOf, sameWorldOf, groupByWorld, statusText, locText, avatarOf, groupIcon, nameFor } = useFriendGroups();

const tabOptions = [
  { label: '全部', value: 'all' },
  { label: '同实例', value: 'same' },
  { label: '同世界', value: 'sworld' },
  { label: '收藏', value: 'fav' },
  { label: '关注', value: 'watch' },
];

const sameInstance = computed(() => sameInstanceOf(store.onlineFriends));
const sameWorld = computed(() => sameWorldOf(store.onlineFriends));

const grouped = computed(() => {
  let list = store.friends;
  const q = store.friendsSearch.trim().toLowerCase();
  if (q) list = list.filter((f) => (f.displayName || '').toLowerCase().includes(q) || (f.userId || '').includes(q));
  if (store.friendsTab === 'fav') list = list.filter((f) => store.favFriendIds && store.favFriendIds.has(f.userId));
  if (store.friendsTab === 'watch') list = list.filter((f) => store.watchlistIds.has(f.userId));
  if (store.friendsTab === 'same') return { same: sameInstance.value, sworld: [], groups: [], offline: [] };
  if (store.friendsTab === 'sworld') return { same: [], sworld: sameWorld.value, groups: [], offline: [] };

  const si = new Set(sameInstance.value.map((f) => f.userId));
  const sw = new Set(sameWorld.value.map((f) => f.userId));
  const onlineList = list.filter((f) => f.isOnline && !si.has(f.userId) && !sw.has(f.userId));
  const groups = groupByWorld(onlineList);
  const offline = list.filter((f) => !f.isOnline);
  return {
    same: store.friendsTab === 'all' ? sameInstance.value : [],
    sworld: store.friendsTab === 'all' ? sameWorld.value : [],
    groups,
    offline,
  };
});

// 在线时长（服务返回 lastOnline/lastSeen；对齐 get_online_friends onlineSince 口径的近似）
function onlineSince(f) {
  if (!f.isOnline) return '';
  const t = f.lastOnline || f.lastSeen;
  if (!t) return '';
  const ms = Date.now() - new Date(t).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const m = Math.floor(ms / 60000);
  if (m < 1) return '刚上线';
  if (m < 60) return m + ' 分钟';
  const h = Math.floor(m / 60);
  return h + ' 小时' + (m % 60 ? ' ' + (m % 60) + ' 分' : '');
}
// 离线时长（上次在线时刻距今）
function offlineSince(f) {
  if (f.isOnline) return '';
  const t = f.lastOffline || f.lastSeen;
  if (!t) return '';
  const ms = Date.now() - new Date(t).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const h = Math.floor(ms / 3600000);
  if (h < 1) return Math.max(1, Math.floor(ms / 60000)) + ' 分钟前';
  if (h < 48) return h + ' 小时前';
  return Math.floor(h / 24) + ' 天前';
}
</script>

<template>
  <div class="friends-view">
    <div class="view-title">好友位置</div>

    <div class="fv-toolbar">
      <SelectButton v-model="store.friendsTab" :options="tabOptions" optionLabel="label" optionValue="value" size="small" />
      <span class="ft-spacer"></span>
      <InputText v-model="store.friendsSearch" placeholder="搜索好友…" class="fv-search" aria-label="搜索好友" />
    </div>

    <div v-if="!store.friends.length" class="empty">
      <i class="pi pi-users empty-icon" aria-hidden="true"></i>
      暂无好友数据
      <small>正在同步好友列表…</small>
    </div>

    <template v-else>
      <!-- 同实例 -->
      <div v-if="grouped.same.length" class="fg">
        <div class="fg-head accent" role="button" tabindex="0" title="点击折叠/展开" @click="toggleGroup('same')" @keydown.enter="toggleGroup('same')">
          <i class="pi pi-map-marker"></i>
          <span>同实例好友</span>
          <span v-if="locLabelFull(store.me.location)" class="fg-loc" @click.stop="openInstance(store.me.location)" :title="'查看房间信息'">{{ locLabelFull(store.me.location) }}</span>
          <span class="fg-count">{{ grouped.same.length }}</span>
          <i class="pi fg-arrow" :class="isCollapsed('same') ? 'pi-chevron-down' : 'pi-chevron-up'"></i>
        </div>
        <div v-if="!isCollapsed('same')" class="fg-body">
          <div v-for="f in grouped.same" :key="f.userId" class="friend-card" @click="openUser(f.userId)" role="button" tabindex="0" @keydown.enter="openUser(f.userId)">
            <Avatar :image="avatarOf(f)" shape="circle" :label="avatarLabel(avatarOf(f), f.displayName)" />
            <div class="fc-text">
              <b :style="{ color: trustColor(f.trustLevel) }">{{ nameFor(f) }}</b>
              <small v-if="f.memo" class="fc-memo" :title="'备注：' + f.memo">{{ f.memo }}</small>
              <small v-if="f.worldName" class="fc-loc" @click.stop="openWorld(f.worldId)" :title="'打开世界：' + f.worldName"><i class="pi pi-globe"></i> {{ f.worldName }}</small>
              <small><span class="fc-dot" :style="friendDotStyle(f)"></span>{{ statusText(f) }}<i v-if="platformIcon(f.platform)" class="pi fc-plat" :class="platformIcon(f.platform)" :title="platformLabel(f.platform)"></i><template v-if="onlineSince(f)"> · {{ onlineSince(f) }}</template></small>
            </div>
          </div>
        </div>
      </div>

      <!-- 同世界（同世界不同实例） -->
      <div v-if="grouped.sworld && grouped.sworld.length" class="fg">
        <div class="fg-head" role="button" tabindex="0" title="同世界、不同实例的在线好友，点击折叠/展开" @click="toggleGroup('sworld')" @keydown.enter="toggleGroup('sworld')">
          <i class="pi pi-compass"></i>
          <span>同世界好友</span>
          <span v-if="locLabelFull(store.me.location)" class="fg-loc" @click.stop="openInstance(store.me.location)" :title="'查看我所在房间'">{{ locLabelFull(store.me.location) }}</span>
          <span class="fg-count">{{ grouped.sworld.length }}</span>
          <i class="pi fg-arrow" :class="isCollapsed('sworld') ? 'pi-chevron-down' : 'pi-chevron-up'"></i>
        </div>
        <div v-if="!isCollapsed('sworld')" class="fg-body">
          <div v-for="f in grouped.sworld" :key="f.userId" class="friend-card" @click="openUser(f.userId)" role="button" tabindex="0" @keydown.enter="openUser(f.userId)">
            <Avatar :image="avatarOf(f)" shape="circle" :label="avatarLabel(avatarOf(f), f.displayName)" />
            <div class="fc-text">
              <b :style="{ color: trustColor(f.trustLevel) }">{{ nameFor(f) }}</b>
              <small v-if="f.memo" class="fc-memo" :title="'备注：' + f.memo">{{ f.memo }}</small>
              <small v-if="f.worldName" class="fc-loc" @click.stop="openWorld(f.worldId)" :title="'打开世界：' + f.worldName"><i class="pi pi-globe"></i> {{ f.worldName }}</small>
              <small><span class="fc-dot" :style="friendDotStyle(f)"></span>{{ statusText(f) }}<span v-if="locText(f)"> · {{ locText(f) }}</span><i v-if="platformIcon(f.platform)" class="pi fc-plat" :class="platformIcon(f.platform)" :title="platformLabel(f.platform)"></i><template v-if="onlineSince(f)"> · {{ onlineSince(f) }}</template></small>
            </div>
          </div>
        </div>
      </div>

      <!-- 世界分组 -->
      <div v-for="g in grouped.groups" :key="g.label" class="fg">
        <div class="fg-head" role="button" tabindex="0" title="点击折叠/展开" @click="toggleGroup('w:' + (g.worldId || g.label))" @keydown.enter="toggleGroup('w:' + (g.worldId || g.label))">
          <img v-if="groupIcon(g)" :src="groupIcon(g)" class="fg-thumb" alt="" loading="lazy" />
          <span>{{ g.label }}</span>
          <span v-if="g.loc" class="fg-loc" @click.stop="openInstance(g.list[0].location)" :title="'查看房间信息'">{{ g.loc }}</span>
          <span class="fg-count">{{ g.list.length }}</span>
          <i class="pi fg-arrow" :class="isCollapsed('w:' + (g.worldId || g.label)) ? 'pi-chevron-down' : 'pi-chevron-up'"></i>
        </div>
        <div v-if="!isCollapsed('w:' + (g.worldId || g.label))" class="fg-body">
          <div v-for="f in g.list" :key="f.userId" class="friend-card" @click="openUser(f.userId)" role="button" tabindex="0" @keydown.enter="openUser(f.userId)">
            <Avatar :image="avatarOf(f)" shape="circle" :label="avatarLabel(avatarOf(f), f.displayName)" />
            <div class="fc-text">
              <b :style="{ color: trustColor(f.trustLevel) }">{{ nameFor(f) }}</b>
              <small v-if="f.memo" class="fc-memo" :title="'备注：' + f.memo">{{ f.memo }}</small>
              <small v-if="f.worldName" class="fc-loc" @click.stop="openWorld(f.worldId)" :title="'打开世界：' + f.worldName"><i class="pi pi-globe"></i> {{ f.worldName }}</small>
              <small><span class="fc-dot" :style="friendDotStyle(f)"></span>{{ statusText(f) }}<i v-if="platformIcon(f.platform)" class="pi fc-plat" :class="platformIcon(f.platform)" :title="platformLabel(f.platform)"></i><template v-if="onlineSince(f)"> · {{ onlineSince(f) }}</template></small>
            </div>
          </div>
        </div>
      </div>

      <!-- 离线 -->
      <div v-if="grouped.offline.length" class="fg">
        <div class="fg-head">
          <span>离线</span>
          <span class="fg-count">{{ grouped.offline.length }}</span>
        </div>
        <div class="fg-body">
          <div v-for="f in grouped.offline" :key="f.userId" class="friend-card" @click="openUser(f.userId)" role="button" tabindex="0" @keydown.enter="openUser(f.userId)">
            <Avatar :image="avatarOf(f)" shape="circle" :label="avatarLabel(avatarOf(f), f.displayName)" />
            <div class="fc-text">
              <b :style="{ color: trustColor(f.trustLevel) }">{{ nameFor(f) }}</b>
              <small v-if="f.memo" class="fc-memo" :title="'备注：' + f.memo">{{ f.memo }}</small>
              <small v-if="f.worldName" class="fc-loc" @click.stop="openWorld(f.worldId)" :title="'打开世界：' + f.worldName"><i class="pi pi-globe"></i> {{ f.worldName }}</small>
              <small><span class="fc-dot" :style="friendDotStyle(f)"></span>{{ statusText(f) }}<template v-if="offlineSince(f)"> · {{ offlineSince(f) }}</template></small>
            </div>
          </div>
        </div>
      </div>

      <div v-if="!grouped.same.length && !(grouped.sworld && grouped.sworld.length) && !grouped.groups.length && !grouped.offline.length" class="empty">无匹配好友</div>
    </template>
  </div>
</template>

<style scoped>
.fv-toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.ft-spacer { flex: 1; }
/* 搜索框与右侧好友栏搜索统一 32px；几何全写死不随字体加载伸缩 */
.fv-search {
  max-width: 240px;
  width: 100%;
  height: 32px;
  min-height: 32px;
  max-height: 32px;
  line-height: 1;
  padding-top: 0;
  padding-bottom: 0;
  font-size: 12.5px;
}
.fg { margin-bottom: 14px; }
.fg-thumb {
  width: 22px;
  height: 22px;
  object-fit: cover;
  border-radius: 5px;
  flex: none;
}
.fg-head {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  font-weight: 700;
  color: var(--text-dim);
  padding: 5px 8px;
  margin-bottom: 6px;
  border-left: 3px solid var(--border);
  cursor: pointer;
  user-select: none;
  border-radius: 4px;
  transition: background 0.1s, color 0.1s;
}
.fg-head:hover { background: var(--surface-2); color: var(--text); }
.fg-head.accent { color: var(--accent); border-left-color: var(--accent); }
.fg-arrow { flex: none; font-size: 9px; opacity: 0.7; margin-left: 2px; }
.fg-count { margin-left: auto; flex: none; font-size: 10.5px; color: var(--text-dim); background: var(--surface-3); padding: 1px 7px; border-radius: 10px; }
.fg-loc {
  font-size: 10.5px;
  color: var(--text-dim);
  background: var(--surface-3);
  border: 1px solid var(--border);
  padding: 0 7px;
  border-radius: 8px;
  flex: 0 1 auto;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 42%;
  min-width: 0;
}
.fg-body { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 6px; }
.friend-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  background: var(--surface);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
}
.friend-card:hover { background: var(--surface-2); border-color: var(--border); }
.fc-text { min-width: 0; }
.fc-text b { display: block; font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fc-text small { color: var(--text-dim); font-size: 11px; display: flex; align-items: center; gap: 5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fc-memo { display: block; font-size: 10px; color: var(--accent); opacity: 0.85; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.fc-loc { display: block; font-size: 10px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; cursor: pointer; }
.fc-loc:hover { color: var(--accent); }
.fc-loc i { font-size: 8px; }
.fc-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; transform: translateY(1px); }
.fc-plat {
  flex: none;
  font-size: 10px;
  color: var(--text-dim);
  line-height: 1;
  cursor: help;
}
.fc-plat:hover { color: var(--text); }
@media (max-width: 899px) {
  .fg-body { grid-template-columns: 1fr 1fr; }
  .fv-search { max-width: none; flex: 1; }
  /* C1/C2：触屏目标加大 + 字号提升 */
  .fg-head { padding: 8px 9px; }
  .fg-head > span:nth-child(2) { font-size: 12.5px; }
  .friend-card { padding: 10px 11px; }
  .fc-text b { font-size: 13px; }
  .fc-text small { font-size: 11.5px; }
}
@media (max-width: 560px) {
  .fg-body { grid-template-columns: 1fr; }
}
</style>
