<script setup>
import { ref, computed, onMounted } from 'vue';
import { store, openWorld, openUser, openPreview } from '../store.js';
import { get, post } from '../api.js';
import { toast } from '../toast.js';

const tab = ref('worlds');
const worlds = ref(null);
const avatars = ref(null);
const friends = ref(null);
const loading = ref(false);
const removing = ref(new Set());

// 收藏夹 tag → 友好名（worlds0=收藏夹1, worlds1=收藏夹2 ...）
function favName(tag) {
  // VRC+ 专属夹实际 tag 为 vrcPlusWorlds1-2（大写 W），/i 才能匹配
  const m = String(tag || '').match(/^(?:vrcplus)?worlds(\d+)$/i);
  if (m) return (/^vrc/i.test(String(tag)) ? 'VRC+ ' : '') + `收藏夹 ${Number(m[1]) + 1}`;
  const a = String(tag || '').match(/^avatars(\d+)$/);
  if (a) return `模型夹 ${Number(a[1]) + 1}`;
  const f = String(tag || '').match(/^friends(\d+)$/);
  if (f) return `好友夹 ${Number(f[1]) + 1}`;
  return tag || '未分类';
}

async function load() {
  loading.value = true;
  try {
    if (!worlds.value) {
      const w = await get('/api/dashboard/favorites?type=worlds&limit=200');
      worlds.value = (w && w.worlds) || [];
    }
    if (!avatars.value) {
      const a = await get('/api/dashboard/favorites?type=avatars&limit=120');
      avatars.value = (a && a.avatars) || [];
    }
    if (!friends.value) {
      const f = await get('/api/dashboard/favorites?type=friends&limit=120');
      friends.value = (f && f.favorites) || [];
    }
  } catch (e) {
    toast('加载收藏失败：' + (e.message || e), 'error');
  } finally {
    loading.value = false;
  }
}
function reload() {
  worlds.value = null; avatars.value = null; friends.value = null;
  load();
}
onMounted(load);

const worldGroups = computed(() => {
  const g = {};
  for (const w of worlds.value || []) {
    const k = w.favoriteGroup || '未分类';
    (g[k] = g[k] || []).push(w);
  }
  return Object.entries(g);
});
const avatarGroups = computed(() => {
  const g = {};
  for (const a of avatars.value || []) {
    const k = a.group || '未分类';
    (g[k] = g[k] || []).push(a);
  }
  return Object.entries(g);
});
// 好友收藏按夹分组（/favorites?type=friend 记录的 tags[0] = friends0-2）
const friendGroups = computed(() => {
  const g = {};
  for (const f of friends.value || []) {
    const k = (Array.isArray(f.tags) && f.tags[0]) || '未分类';
    (g[k] = g[k] || []).push(f);
  }
  return Object.entries(g);
});

// 收藏夹切换：'all' 全部堆叠 / 具体 tag 只看该夹；刷新后夹消失自动回退全部
const folderSel = ref({ worlds: 'all', avatars: 'all', friends: 'all' });
const chipsOf = (groups, total) => [
  { key: 'all', label: '全部', count: total },
  ...groups.map(([g, list]) => ({ key: g, label: favName(g), count: list.length })),
];
const effSel = (groups, sel) => (sel !== 'all' && !groups.some(([g]) => g === sel) ? 'all' : sel);
const pickGroups = (groups, sel) => (sel === 'all' ? groups : groups.filter(([g]) => g === sel));

const worldChips = computed(() => chipsOf(worldGroups.value, (worlds.value || []).length));
const worldSel = computed(() => effSel(worldGroups.value, folderSel.value.worlds));
const visibleWorldGroups = computed(() => pickGroups(worldGroups.value, worldSel.value));

const avatarChips = computed(() => chipsOf(avatarGroups.value, (avatars.value || []).length));
const avatarSel = computed(() => effSel(avatarGroups.value, folderSel.value.avatars));
const visibleAvatarGroups = computed(() => pickGroups(avatarGroups.value, avatarSel.value));

const friendChips = computed(() => chipsOf(friendGroups.value, (friends.value || []).length));
const friendSel = computed(() => effSel(friendGroups.value, folderSel.value.friends));
const visibleFriendGroups = computed(() => pickGroups(friendGroups.value, friendSel.value));

async function removeFav(type, id, displayName) {
  const key = type + ':' + id;
  if (removing.value.has(key)) return;
  removing.value.add(key);
  // 乐观更新：先移除，失败回滚
  const prev = type === 'world' ? worlds.value : type === 'avatar' ? avatars.value : friends.value;
  try {
    await post('/api/dashboard/favorite-remove', { type, id });
    if (type === 'world') worlds.value = worlds.value.filter((w) => w.worldId !== id);
    else if (type === 'avatar') avatars.value = avatars.value.filter((a) => a.avatarId !== id);
    else friends.value = friends.value.filter((f) => f.userId !== id);
    toast('已取消收藏' + (displayName ? '「' + displayName + '」' : ''), 'success');
  } catch (e) {
    if (type === 'world') worlds.value = prev;
    else if (type === 'avatar') avatars.value = prev;
    else friends.value = prev;
    toast('取消收藏失败：' + (e.message || e), 'error');
  } finally {
    removing.value.delete(key);
  }
}

// 移动收藏分组（move_world_group；安全模式下被拦截——破坏性工具）
const moveMenuFor = ref('');   // 当前打开移动菜单的 worldId
const movingTo = ref('');
function toggleMove(w) { moveMenuFor.value = moveMenuFor.value === w.worldId ? '' : w.worldId; }
async function moveWorld(w, toGroup) {
  if (movingTo.value) return;
  movingTo.value = toGroup;
  try {
    const r = await post('/api/dashboard/favorites/move', { worldId: w.worldId, toGroup });
    if (r && r.error) throw new Error(typeof r.error === 'string' ? r.error : JSON.stringify(r.error));
    toast('已移动到「' + (r.toGroup || toGroup) + '」', 'success');
    moveMenuFor.value = '';
    await reload();
  } catch (e) {
    toast('移动失败：' + (e.message || e), 'error');
  } finally {
    movingTo.value = '';
  }
}
// 该世界的目标分组候选（除当前组外）
function moveTargets(w, currentGroup) {
  return (worldGroups.value || []).filter(([g]) => g !== currentGroup).map(([g]) => ({ tag: g, label: favName(g) }));
}

// 收藏夹分组管理（update_favorite_group：重命名/可见性）
const groupMgr = ref('');
const grpNewName = ref('');
const grpVis = ref('private');
const grpBusy = ref(false);
function toggleGroupMgr(g) {
  groupMgr.value = groupMgr.value === g ? '' : g;
  grpNewName.value = '';
  grpVis.value = 'private';
}
async function saveGroup(g, visOnly = false) {
  if (grpBusy.value) return;
  grpBusy.value = true;
  try {
    const body = { group: g };
    if (!visOnly && grpNewName.value.trim()) body.displayName = grpNewName.value.trim();
    if (visOnly) body.visibility = grpVis.value;
    if (!body.displayName && !body.visibility) { grpBusy.value = false; return; }
    const r = await post('/api/dashboard/favorites/group', body);
    if (r && r.error) throw new Error(typeof r.error === 'string' ? r.error : JSON.stringify(r.error));
    toast('收藏夹已更新', 'success');
    groupMgr.value = '';
    await reload();
  } catch (e) {
    toast('更新失败：' + (e.message || e), 'error');
  } finally { grpBusy.value = false; }
}

const statusText = (f) => {
  const s = f.status;
  const labels = { active: '在线', 'join me': '欢迎加入', 'ask me': '忙碌', busy: '请勿打扰', offline: '离线' };
  return labels[s] || (f.isOnline ? '在线' : '离线');
};
</script>

<template>
  <div class="fv">
    <div class="fv-head">
      <h2><i class="pi pi-star"></i> 收藏</h2>
      <span class="fv-count">{{ loading ? '加载中…' : ((worlds ? worlds.length : 0) + (avatars ? avatars.length : 0) + (friends ? friends.length : 0)) + ' 项' }}</span>
      <Button size="small" text icon="pi pi-refresh" title="刷新" @click="reload" />
    </div>

    <Tabs v-model:value="tab" :scrollable="true">
      <TabList>
        <Tab value="worlds">世界<span v-if="worlds"> ({{ worlds.length }})</span></Tab>
        <Tab value="avatars">模型<span v-if="avatars"> ({{ avatars.length }})</span></Tab>
        <Tab value="friends">好友<span v-if="friends"> ({{ friends.length }})</span></Tab>
      </TabList>
      <TabPanels>
        <!-- 世界收藏 -->
        <TabPanel value="worlds">
          <div v-if="loading && !worlds" class="loading-mini"><ProgressSpinner style="width:28px;height:28px" strokeWidth="4" /></div>
          <div v-else-if="worlds && !worlds.length" class="empty" style="padding:24px">暂无收藏世界</div>
          <div v-else>
            <div v-if="worldChips.length > 2" class="fv-chips" role="group" aria-label="收藏夹筛选">
              <button v-for="c in worldChips" :key="c.key" class="chip" :class="{ active: worldSel === c.key }" @click="folderSel.worlds = c.key">{{ c.label }}<span class="chip-n">{{ c.count }}</span></button>
            </div>
            <div v-for="[g, list] in visibleWorldGroups" :key="g" class="fv-group">
              <div class="fv-group-head"><i class="pi pi-bookmark"></i>{{ favName(g) }} <span class="fv-group-count">{{ list.length }}</span>
                <button class="fg-gear" :title="'管理收藏夹 ' + favName(g)" :aria-label="'管理收藏夹 ' + favName(g)" @click="toggleGroupMgr(g)"><i class="pi pi-cog"></i></button>
              </div>
              <div v-if="groupMgr === g" class="fg-mgr" @click.stop>
                <div class="fgm-row">
                  <InputText v-model="grpNewName" placeholder="新名称（留空不改）" size="small" class="fgm-input" :aria-label="'重命名 ' + favName(g)" @keydown.enter="saveGroup(g)" />
                  <Button label="改名" size="small" :loading="grpBusy" @click="saveGroup(g)" />
                </div>
                <div class="fgm-row fgm-vis">
                  <span class="fgm-label">可见性</span>
                  <button v-for="v in ['private', 'friends', 'public']" :key="v" class="chip" :class="{ active: grpVis === v }" @click="grpVis = v">{{ v === 'public' ? '公开' : v === 'friends' ? '好友' : '私密' }}</button>
                  <Button label="应用可见性" size="small" text :loading="grpBusy" @click="saveGroup(g, true)" />
                </div>
                <div class="fgm-note">设为公开后收藏夹对他人可见（敏感操作）</div>
              </div>
              <div class="world-grid">
                <div v-for="w in list" :key="w.worldId" class="world-card" role="button" tabindex="0" @click="openWorld(w.worldId)" @keydown.enter="openWorld(w.worldId)">
                  <img v-if="w.imageUrl" :src="w.imageUrl" class="world-img" alt="" loading="lazy" />
                  <div v-else class="world-img world-img-empty"><i class="pi pi-globe"></i></div>
                  <div class="world-info">
                    <b class="ellipsis" :title="w.worldName">{{ w.worldName }}</b>
                    <div class="text-dim world-sub">{{ w.authorName }}</div>
                    <div class="world-meta">
                      <span v-if="w.category" class="cat">{{ w.category }}</span>
                      <span v-if="w.favorites"><i class="pi pi-heart"></i>{{ w.favorites }}</span>
                    </div>
                  </div>
                  <div class="wc-actions">
                    <Button icon="pi pi-arrow-right" text size="small" class="rm-btn" title="移动分组" :aria-label="'移动分组 ' + w.worldName" @click.stop="toggleMove(w)" />
                    <Button icon="pi pi-star-fill" severity="warning" text size="small" class="rm-btn" title="取消收藏" :loading="removing.has('world:' + w.worldId)" @click.stop="removeFav('world', w.worldId, w.worldName)" />
                  </div>
                  <div v-if="moveMenuFor === w.worldId" class="move-menu" @click.stop>
                    <div class="mm-title">移动到收藏夹</div>
                    <button v-for="t in moveTargets(w, g)" :key="t.tag" class="mm-item" :disabled="movingTo === t.tag" @click="moveWorld(w, t.tag)">
                      {{ t.label }}<i v-if="movingTo === t.tag" class="pi pi-spin pi-spinner"></i>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </TabPanel>

        <!-- 模型收藏 -->
        <TabPanel value="avatars">
          <div v-if="loading && !avatars" class="loading-mini"><ProgressSpinner style="width:28px;height:28px" strokeWidth="4" /></div>
          <div v-else-if="avatars && !avatars.length" class="empty" style="padding:24px">暂无收藏的模型</div>
          <div v-else>
            <div v-if="avatarChips.length > 2" class="fv-chips" role="group" aria-label="收藏夹筛选">
              <button v-for="c in avatarChips" :key="c.key" class="chip" :class="{ active: avatarSel === c.key }" @click="folderSel.avatars = c.key">{{ c.label }}<span class="chip-n">{{ c.count }}</span></button>
            </div>
            <div v-for="[g, list] in visibleAvatarGroups" :key="g" class="fv-group">
              <div class="fv-group-head"><i class="pi pi-bookmark"></i>{{ favName(g) }} <span class="fv-group-count">{{ list.length }}</span></div>
              <div class="avatar-grid">
                <div v-for="a in list" :key="a.avatarId" class="avatar-card" role="button" tabindex="0" @click="openPreview(a.imageUrl || '')" @keydown.enter="openPreview(a.imageUrl || '')">
                  <img v-if="a.imageUrl" :src="a.imageUrl" class="avatar-img" alt="" loading="lazy" />
                  <div v-else class="avatar-img avatar-img-empty"><i class="pi pi-user"></i></div>
                  <div class="avatar-info">
                    <b class="ellipsis" :title="a.name">{{ a.name }}</b>
                    <div class="text-dim">{{ a.authorName || '' }}</div>
                  </div>
                  <Button icon="pi pi-star-fill" severity="warning" text size="small" class="rm-btn" title="取消收藏" :loading="removing.has('avatar:' + a.avatarId)" @click.stop="removeFav('avatar', a.avatarId, a.name)" />
                </div>
              </div>
            </div>
          </div>
        </TabPanel>

        <!-- 好友收藏 -->
        <TabPanel value="friends">
          <div v-if="loading && !friends" class="loading-mini"><ProgressSpinner style="width:28px;height:28px" strokeWidth="4" /></div>
          <div v-else-if="friends && !friends.length" class="empty" style="padding:24px">暂无收藏的好友</div>
          <div v-else>
            <div v-if="friendChips.length > 2" class="fv-chips" role="group" aria-label="收藏夹筛选">
              <button v-for="c in friendChips" :key="c.key" class="chip" :class="{ active: friendSel === c.key }" @click="folderSel.friends = c.key">{{ c.label }}<span class="chip-n">{{ c.count }}</span></button>
            </div>
            <div v-for="[g, list] in visibleFriendGroups" :key="g" class="fv-group">
              <div class="fv-group-head"><i class="pi pi-bookmark"></i>{{ favName(g) }} <span class="fv-group-count">{{ list.length }}</span></div>
              <div class="fav-friend-list">
                <div v-for="f in list" :key="f.userId" class="fav-friend" role="button" tabindex="0" @click="openUser({ userId: f.userId, displayName: f.name, avatarUrl: f.avatarUrl || '' })" @keydown.enter="openUser({ userId: f.userId, displayName: f.name, avatarUrl: f.avatarUrl || '' })">
                  <img v-if="f.avatarUrl" :src="f.avatarUrl" class="fav-friend-av" alt="" loading="lazy" />
                  <div v-else class="fav-friend-av fav-friend-av-empty">{{ (f.name || '?')[0] }}</div>
                  <div class="fav-friend-info">
                    <b>{{ f.name }}</b>
                    <div class="text-dim">{{ statusText(f) }}</div>
                  </div>
                  <Button icon="pi pi-star-fill" severity="warning" text size="small" class="rm-btn" title="取消收藏" :loading="removing.has('friend:' + f.userId)" @click.stop="removeFav('friend', f.userId, f.name)" />
                </div>
              </div>
            </div>
          </div>
        </TabPanel>
      </TabPanels>
    </Tabs>
  </div>
</template>

<style scoped>
.fv { padding: 4px; }
.fv-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.fv-count { font-size: 11px; color: var(--text-dim); flex: 1; }
.fv-group { margin-bottom: 16px; }
.fg-gear { background: none; border: none; color: var(--text-dim); cursor: pointer; font-size: 11px; margin-left: auto; padding: 2px 4px; border-radius: 4px; }
.fg-gear:hover { color: var(--text); background: var(--surface-2); }
.fg-gear:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.fg-mgr { background: var(--surface-2); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; margin-bottom: 8px; display: flex; flex-direction: column; gap: 8px; }
.fgm-row { display: flex; align-items: center; gap: 8px; }
.fgm-input { flex: 1; }
.fgm-vis { gap: 6px; }
.fgm-label { font-size: 11px; color: var(--text-dim); }
.fgm-note { font-size: 10px; color: var(--text-dim); }
.fv-group-head { display: flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 700; color: var(--text-dim); margin-bottom: 8px; }
.fv-group-count { font-size: 10.5px; background: var(--surface-3); border-radius: 8px; padding: 0 7px; line-height: 15px; }
/* 收藏夹切换 chips（与动态页 chip 同视觉语言） */
.fv-chips { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin: 0 0 12px; }




.chip-n { font-size: 10px; opacity: 0.75; }
.world-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 8px; }
.wc-actions { position: absolute; top: 6px; right: 6px; display: flex; gap: 2px; background: rgba(0,0,0,0.35); border-radius: 8px; padding: 1px; }
.move-menu { position: absolute; top: 38px; right: 6px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 10px; padding: 6px; z-index: 30; min-width: 140px; box-shadow: 0 6px 20px rgba(0,0,0,0.35); }
.mm-title { font-size: 11px; color: var(--text-dim); padding: 2px 8px 6px; }
.mm-item { display: block; width: 100%; text-align: left; background: none; border: none; color: var(--text); font-size: 12px; padding: 6px 8px; border-radius: 6px; cursor: pointer; font-family: inherit; }
.mm-item:hover { background: var(--surface-3); }
.mm-item:disabled { opacity: 0.5; cursor: default; }
.mm-item:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.world-card { position: relative; background: var(--surface); border: 1px solid var(--border-soft); border-radius: 8px; overflow: hidden; cursor: pointer; transition: border-color 0.12s; }
.world-card:hover { border-color: var(--accent); }
.world-img { width: 100%; height: 84px; object-fit: cover; display: block; background: var(--surface-3); }
.world-img-empty, .avatar-img-empty { display: flex; align-items: center; justify-content: center; color: var(--text-dim); }
.world-info { padding: 7px 8px; }
.world-info b { font-size: 12.5px; display: block; }
.world-sub { font-size: 11px; }
.world-meta { display: flex; gap: 6px; margin-top: 4px; font-size: 10.5px; color: var(--text-dim); }
.cat { background: var(--surface-3); border-radius: 6px; padding: 0 5px; line-height: 14px; }
.rm-btn { position: absolute; top: 4px; right: 4px; }
.avatar-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 8px; }
.avatar-card { position: relative; background: var(--surface); border: 1px solid var(--border-soft); border-radius: 8px; overflow: hidden; cursor: pointer; transition: border-color 0.12s; }
.avatar-card:hover { border-color: var(--accent); }
.avatar-img { width: 100%; aspect-ratio: 1; object-fit: cover; display: block; background: var(--surface-3); }
.avatar-info { padding: 6px 7px; }
.avatar-info b { font-size: 12px; display: block; }
.fav-friend-list { display: flex; flex-direction: column; gap: 4px; }
.fav-friend { position: relative; display: flex; align-items: center; gap: 9px; padding: 6px 8px; border-radius: 8px; cursor: pointer; background: var(--surface); border: 1px solid var(--border-soft); }
.fav-friend:hover { border-color: var(--accent); }
.fav-friend-av { width: 34px; height: 34px; border-radius: 50%; object-fit: cover; flex: none; }
.fav-friend-av-empty { display: flex; align-items: center; justify-content: center; background: var(--surface-3); color: var(--text-dim); font-size: 14px; font-weight: 600; }
.fav-friend-info { flex: 1; min-width: 0; }
.fav-friend-info b { font-size: 13px; display: block; }

/* 移动端：收藏夹 chips 单行横向滚动（与动态页类型 chips 同处理） */
@media (max-width: 899px) {
  .fv-chips { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; -webkit-overflow-scrolling: touch; padding-bottom: 2px; }
  .fv-chips::-webkit-scrollbar { display: none; }
}
</style>
