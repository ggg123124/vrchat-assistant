<script setup>
import { ref, computed, watch } from 'vue';
import { store, closeWorld, openUser, copyText, openPreview, openInstance, openGroup } from '../store.js';
import { get, post, imgUrl } from '../api.js';
import { date, dateTime, trustColor, parseLoc, instanceLabel } from '../utils.js';
import { toast } from '../toast.js';

const visible = computed({
  get: () => !!store.worldModal,
  set: (v) => { if (!v) closeWorld(); },
});
const world = ref(null);
const history = ref(null);
const liveInst = ref(null);   // 实时实例（world-instances 端点；在线实例是实时数据不缓存）
const loading = ref(false);
const activeTab = ref('info');
const noteText = ref('');
const noteSaving = ref(false);
const favBusy = ref(false);
const faved = ref(false);

const w = computed(() => world.value || store.worldModal || {});

function platformLabel(p) {
  const v = String(p || '').toLowerCase();
  if (v.includes('standalone')) return 'PC';
  if (v.includes('android')) return '安卓';
  if (v.includes('ios')) return 'iOS';
  return v || '';
}

async function load() {
  const modal = store.worldModal;
  if (!modal || !modal.worldId) return;
  loading.value = true;
  world.value = null;
  history.value = null;
  liveInst.value = null;
  activeTab.value = 'info';
  try {
    const d = await get(`/api/dashboard/world?worldId=${encodeURIComponent(modal.worldId)}`);
    if (!d.error) world.value = d;
    const h = await get(`/api/dashboard/world-history?worldId=${encodeURIComponent(modal.worldId)}`);
    if (!h.error) history.value = h;
    // 实时实例（在线实例变化频繁，走独立实时端点）
    const li = await get(`/api/dashboard/world-instances?worldId=${encodeURIComponent(modal.worldId)}`);
    if (!li.error) liveInst.value = li;
  } catch { /* 保持空 */ }
  loading.value = false;
}
watch(() => store.worldModal, (v) => { if (v) load(); });

const infoFacts = computed(() => {
  const ww = world.value;
  if (!ww) return [];
  const platformStr = (Array.isArray(ww.platforms) ? ww.platforms.map(platformLabel).filter(Boolean) : []).join(', ');
  const facts = [
    { k: '世界 ID', v: ww.worldId || '—' },
    { k: '作者添加的标签', v: (Array.isArray(ww.tags) && ww.tags.length) ? ww.tags.join(', ') : '—' },
    { k: '地图内总在线人数', v: ww.occupants != null ? String(ww.occupants) : '—' },
    { k: '收藏人数', v: ww.favorites ? ww.favorites.toLocaleString() : '—' },
    { k: '总游玩人次', v: ww.visits ? ww.visits.toLocaleString() : '—' },
    { k: '推荐人数', v: ww.recommendedCapacity ? `${ww.recommendedCapacity} (${ww.capacity || '?'})` : (ww.capacity ? `${ww.capacity} 人` : '—') },
    { k: '创建时间', v: ww.createdAt ? dateTime(ww.createdAt) : '—' },
    { k: '最后更新时间', v: ww.updatedAt ? dateTime(ww.updatedAt) : '—' },
    { k: '进入实验室的日期', v: ww.labsPublicationDate ? date(ww.labsPublicationDate) : '—' },
    { k: '正式公开于', v: ww.publicationDate ? date(ww.publicationDate) : '—' },
    { k: '版本', v: ww.version ? String(ww.version) : '—' },
    { k: '热度', v: ww.heat ? '🔥'.repeat(Math.min(10, Math.max(1, ww.heat))) : '—' },
    { k: '支持的平台', v: platformStr || '—' },
    { k: '公开状态', v: ww.releaseStatus || '—' },
    { k: '特色世界', v: ww.featured ? '是' : '—' },
  ];
  return facts;
});

// 创建房间（create_instance：hidden/friends/group/public + region）
const INST_TYPES = [
  { v: 'hidden', l: '私密' },
  { v: 'friends', l: '仅好友' },
  { v: 'group', l: '群组' },
  { v: 'public', l: '公开' },
];
const instType = ref('hidden');
const instRegion = ref('jp');
const instCreating = ref(false);
const instResult = ref(null);
async function createInstance() {
  if (!world.value || !world.value.worldId || instCreating.value) return;
  instCreating.value = true;
  instResult.value = null;
  try {
    const r = await post('/api/dashboard/instance/create', { worldId: world.value.worldId, type: instType.value, region: instRegion.value });
    if (r && r.error) throw new Error(r.error);
    instResult.value = r;
    toast('房间已创建', 'success');
  } catch (e) {
    toast('创建失败：' + (e.message || e), 'error');
  } finally {
    instCreating.value = false;
  }
}

// 该世界在线的好友（房间 tab 底部）
const onlineHere = computed(() => {
  const wid = w.value.worldId;
  if (!wid) return [];
  return (store.friends || []).filter((f) => f.isOnline && f.worldId === wid);
});

// 实例列表（实时 world-instances 端点；后端已解析类型/房主/短ID）
const instances = computed(() => (liveInst.value ? (liveInst.value.instances || []) : []));
// 权限类型排序（用户定稿，从高到低）：公开 > 好友+(hidden) > 仅限好友(friends) > 邀请+(private+canRequestInvite) > 仅限邀请(private) > 群组房间
const TYPE_ORDER = { public: 0, 'friends+': 1, hidden: 1, friends: 2, 'invite+': 3, private: 4, group: 5, local: 6 };
const GROUP_ORDER = { public: 0, plus: 1, members: 2 };
const sortedInstances = computed(() =>
  [...instances.value].sort((a, b) => {
    const ta = TYPE_ORDER[a.type] ?? 9;
    const tb = TYPE_ORDER[b.type] ?? 9;
    if (ta !== tb) return ta - tb;
    if (a.type === 'group' && b.type === 'group') {
      const ga = GROUP_ORDER[a.groupAccessType] ?? 9;
      const gb = GROUP_ORDER[b.groupAccessType] ?? 9;
      return ga - gb;
    }
    return 0;
  })
);
const pubOcc = computed(() => (liveInst.value ? liveInst.value.publicOccupants : (w.value.publicOccupants || 0)));
const privOcc = computed(() => (liveInst.value ? liveInst.value.privateOccupants : (w.value.privateOccupants || 0)));
function instOwnerName(inst) {
  if (!inst.owner) return '';
  if (inst.owner.name) return inst.owner.name;
  return inst.owner.kind === 'group' ? '群组' : String(inst.owner.id).slice(0, 8) + '…';
}
// 实例权限类型标签（VRChat：公开/好友+/仅限好友/邀请+/仅限邀请/群组房间；群组内再分公开/+/成员）
function instTypeLabel(inst) {
  if (inst.type === 'group') {
    const m = { public: '群组公开', plus: '群组+', members: '群组成员' };
    return m[inst.groupAccessType] || '群组房间';
  }
  return instanceLabel(inst.type) || '房间';
}
function instIcon(inst) {
  const m = { group: 'pi-shield', public: 'pi-globe', friends: 'pi-users', 'friends+': 'pi-user-plus', private: 'pi-envelope', hidden: 'pi-lock' };
  return m[inst.type] || 'pi-map-marker';
}
function instOwnerClick(inst) {
  if (!inst.owner || !inst.owner.id) return;
  if (inst.owner.kind === 'group') openGroup(inst.owner.id);
  else openUser({ userId: inst.owner.id, displayName: inst.owner.name || '' });
}

const fmtMinutes = (m) => {
  if (!m || m <= 0) return '—';
  if (m < 60) return `${m} 分钟`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分钟`;
};

async function saveNote() {
  if (!world.value) return;
  noteSaving.value = true;
  try {
    await post('/api/dashboard/world-note', { worldId: world.value.worldId, note: noteText.value });
    if (world.value) world.value.note = noteText.value;
    toast('备注已保存', 'success');
  } catch (e) {
    toast('保存备注失败：' + (e.message || e), 'error');
  } finally { noteSaving.value = false; }
}

async function toggleFav() {
  if (!world.value || favBusy.value) return;
  favBusy.value = true;
  try {
    if (faved.value) {
      await post('/api/dashboard/favorite-remove', { type: 'world', id: world.value.worldId });
      faved.value = false;
      toast('已取消收藏', 'success');
    } else {
      const d = await post('/api/dashboard/favorite-add', { type: 'world', id: world.value.worldId });
      if (d.ok) { faved.value = true; toast('已收藏', 'success'); }
      else toast(d.error || '收藏失败', 'error');
    }
  } catch (e) {
    toast('操作失败：' + (e.message || e), 'error');
  } finally { favBusy.value = false; }
}

// 推荐反馈：评分/已逛（与推荐页同源路由）
const rateBusy = ref(0);
async function rateWorld(rating) {
  if (!world.value || rateBusy.value) return;
  rateBusy.value = rating;
  try {
    const r = await post('/api/dashboard/world/rate', { worldId: world.value.worldId, rating });
    if (r && r.error) throw new Error(r.error);
    toast(rating === 1 ? '已标记喜欢 👍' : rating === -1 ? '已标记不喜欢 👎' : '已清除评分', 'success');
  } catch (e) {
    toast('评分失败：' + (e.message || e), 'error');
  } finally { rateBusy.value = 0; }
}
async function markVisited() {
  if (!world.value || rateBusy.value) return;
  rateBusy.value = -2;
  try {
    const r = await post('/api/dashboard/world/visited', { worldId: world.value.worldId });
    if (r && r.error) throw new Error(r.error);
    toast('已标记为逛过', 'success');
  } catch (e) {
    toast('标记失败：' + (e.message || e), 'error');
  } finally { rateBusy.value = 0; }
}

// 此世界相册照片（get_prints 数据按 worldId 过滤，懒加载一次）
const worldPrints = ref([]);
const photosLoading = ref(false);
let printsLoaded = false;
const wpPreview = ref(null);
const wpPreviewOpen = ref(false);
function previewPrint(p) { wpPreview.value = p; wpPreviewOpen.value = true; }
async function loadWorldPrints() {
  if (printsLoaded || photosLoading.value || !world.value || !world.value.worldId) return;
  photosLoading.value = true;
  try {
    const r = await get('/api/dashboard/prints?limit=100');
    const all = (r && r.prints) || [];
    worldPrints.value = all.filter((p) => p.worldId === world.value.worldId);
    printsLoaded = true;
  } catch {
    /* 相册加载失败静默 */
  } finally {
    photosLoading.value = false;
  }
}
watch(() => [activeTab, world.value && world.value.worldId], ([t]) => {
  if (t === 'photos') loadWorldPrints();
});

// 该作者的其他世界（懒加载）
const authorWorlds = ref([]);
const authorLoading = ref(false);
let authorLoaded = false;
async function loadAuthorWorlds() {
  const aid = world.value && world.value.authorId;
  if (!aid || authorLoading.value) return;
  if (authorLoaded.value) return;
  authorLoading.value = true;
  try {
    const r = await get('/api/dashboard/worlds-by-author?authorId=' + encodeURIComponent(aid) + '&limit=10');
    authorWorlds.value = (r && r.worlds) || [];
    authorLoaded.value = true;
  } catch (e) {
    toast('加载作者世界失败：' + (e.message || e), 'error');
  } finally {
    authorLoading.value = false;
  }
}

const worldJson = computed(() => (world.value ? JSON.stringify(world.value, null, 2) : ''));
</script>

<template>
  <Dialog v-model:visible="visible" :style="{ width: 'min(680px, 95vw)' }" :dismissable-mask="true" :modal="true" :maximizable="!store.isMobile" :closeOnEscape="true">
    <template #header>
      <div class="wd-head">
        <div class="wd-cover">
          <img v-if="w.imageUrl" :src="w.imageUrl" alt="" loading="lazy" />
          <div v-else class="wd-cover-empty"><i class="pi pi-globe"></i></div>
        </div>
        <div class="wd-title">
          <b>{{ w.name || w.worldId }}</b>
          <Button icon="pi pi-copy" text size="small" rounded :aria-label="'复制世界名'" title="复制世界名" @click="copyText(w.name || w.worldId)" />
          <div class="wd-sub">
            <span v-if="w.authorName" class="link" @click="openUser({ userId: w.authorId || '', displayName: w.authorName })">{{ w.authorName }}</span>
            <Button v-if="w.authorId" size="small" text icon="pi pi-globe" label="其他世界" @click.stop="loadAuthorWorlds()" :loading="authorLoading" />
            <span v-if="w.releaseStatus" class="wd-badge" :class="w.releaseStatus === 'public' ? 'pub' : 'priv'">{{ w.releaseStatus === 'public' ? '公开' : w.releaseStatus }}</span>
            <span v-if="w.heat" class="wd-heat" :title="'热度 ' + w.heat">🔥{{ w.heat }}</span>
            <span v-if="w.version" class="wd-ver">v{{ w.version }}</span>
          </div>
          <div v-if="authorWorlds.length" class="aw-list">
            <button v-for="aw in authorWorlds.slice(0, 8)" :key="aw.worldId" class="aw-item" @click="openWorld(aw.worldId)">
              <img v-if="aw.imageUrl" :src="imgUrl(aw.imageUrl)" class="aw-thumb" alt="" loading="lazy" />
              <span class="aw-name" :title="aw.name">{{ aw.name }}</span>
              <span v-if="aw.favorites" class="aw-fav"><i class="pi pi-heart"></i>{{ aw.favorites }}</span>
            </button>
          </div>
        </div>
        <Button :icon="faved ? 'pi pi-star-fill' : 'pi pi-star'" :severity="faved ? 'warning' : 'secondary'" size="small" text rounded :loading="favBusy" :title="faved ? '取消收藏' : '收藏'"
          @click="toggleFav" />
        <Button icon="pi pi-thumbs-up" size="small" text rounded :loading="rateBusy === 1" :title="'喜欢（影响推荐）'" :aria-label="'喜欢'"
          @click="rateWorld(1)" />
        <Button icon="pi pi-thumbs-down" size="small" text rounded :loading="rateBusy === -1" :title="'不喜欢'" :aria-label="'不喜欢'"
          @click="rateWorld(-1)" />
        <Button icon="pi pi-check" size="small" text rounded :loading="rateBusy === -2" :title="'标记已逛（减少推荐）'" :aria-label="'标记已逛'"
          @click="markVisited()" />
      </div>
    </template>

    <div v-if="loading" class="loading-mini"><ProgressSpinner style="width:32px;height:32px" strokeWidth="4" /></div>
    <div v-else-if="!w.worldId" class="empty" style="padding:20px">世界信息不可用</div>
    <div v-else>
      <div v-if="w.description" class="wd-desc">{{ w.description }}</div>

      <Tabs v-model:value="activeTab" :scrollable="true">
        <TabList>
          <Tab value="info">信息</Tab>
          <Tab value="photos">照片<span v-if="worldPrints.length"> ({{ worldPrints.length }})</span></Tab>
          <Tab value="rooms">房间<span v-if="onlineHere.length"> ({{ onlineHere.length }})</span></Tab>
          <Tab value="json">原始 JSON 信息</Tab>
          <Tab value="note">备注</Tab>
        </TabList>
        <TabPanels>
          <!-- 信息 -->
          <TabPanel value="photos">
            <div v-if="photosLoading" class="loading-mini"><ProgressSpinner style="width:24px;height:24px" strokeWidth="4" /></div>
            <div v-else-if="!worldPrints.length" class="empty" style="padding:16px">此世界暂无相册照片（VRChat Plus 照片带世界记录）</div>
            <div v-else class="wp-grid">
              <button v-for="p in worldPrints" :key="p.printId" type="button" class="wp-card" @click="previewPrint(p)">
                <img v-if="p.downloadUrl" :src="imgUrl(p.downloadUrl)" class="wp-img" alt="照片" loading="lazy" />
                <small class="wp-date mono">{{ date(p.createdAt) }} {{ time(p.createdAt) }}</small>
              </button>
            </div>
            <Dialog v-model:visible="wpPreviewOpen" :header="'照片 · ' + (wpPreview ? date(wpPreview.createdAt) + ' ' + time(wpPreview.createdAt) : '')" :modal="true" :style="{ width: 'min(92vw, 640px)' }" dismissable-mask @hide="wpPreview = null">
              <img v-if="wpPreview && wpPreview.downloadUrl" :src="imgUrl(wpPreview.downloadUrl)" style="width:100%;border-radius:8px" alt="照片" />
            </Dialog>
          </TabPanel>
          <TabPanel value="info">
            <div class="facts">
              <div v-for="s in infoFacts" :key="s.k" class="fact">
                <span>{{ s.k }}</span>
                <span v-if="s.k === '世界 ID'"><span class="mono">{{ s.v }}</span>
                  <a class="wd-web" :href="'https://vrchat.com/home/world/' + s.v" target="_blank" rel="noopener" :title="'在 VRChat 网页版查看该世界'"><i class="pi pi-external-link"></i></a>
                  <Button icon="pi pi-link" text size="small" rounded :aria-label="'复制世界网页链接'" title="复制世界网页链接" @click="copyText('https://vrchat.com/home/world/' + s.v)" />
                  <Button icon="pi pi-copy" text size="small" rounded :aria-label="'复制世界 ID'" @click="copyText(s.v)" /></span>
                <span v-else>{{ s.v }}</span>
              </div>
            </div>
            <div class="wd-local" v-if="history">
              <div class="wd-local-head"><i class="pi pi-history"></i> 本地游玩记录</div>
              <div class="facts">
                <div class="fact"><span>最后游玩时间</span><span>{{ history.last ? dateTime(history.last) : '—' }}</span></div>
                <div class="fact"><span>游玩次数</span><span>{{ history.visits || 0 }}</span></div>
                <div class="fact"><span>总停留时长</span><span>{{ fmtMinutes(history.minutes) }}</span></div>
              </div>
            </div>
          </TabPanel>

          <!-- 房间：该世界实例列表（公开/群组/私密）+ 在线好友 -->
          <TabPanel value="rooms">
            <div class="inst-create">
              <div class="ic-title"><i class="pi pi-plus-circle"></i> 创建房间</div>
              <div class="ic-row">
                <span class="ic-label">类型</span>
                <button v-for="t in INST_TYPES" :key="t.v" class="chip" :class="{ active: instType === t.v }" @click="instType = t.v">{{ t.l }}</button>
              </div>
              <div class="ic-row">
                <span class="ic-label">区域</span>
                <button v-for="r in ['jp', 'us', 'eu']" :key="r" class="chip" :class="{ active: instRegion === r }" @click="instRegion = r">{{ r.toUpperCase() }}</button>
                <Button size="small" icon="pi pi-plus" :loading="instCreating" label="创建" class="ic-go" @click="createInstance()" />
              </div>
              <div v-if="instResult" class="ic-result">
                <span class="ic-loc mono">{{ instResult.location || instResult.shortName }}</span>
                <Button size="small" text icon="pi pi-copy" :aria-label="'复制房间位置'" @click="copyText(instResult.location || instResult.shortName)" />
                <small class="ic-note">在 VRChat 中打开该世界 → 加入此房间</small>
              </div>
            </div>
            <div class="inst-head">
              <span><i class="pi pi-globe"></i> 公开 {{ pubOcc }} 人</span>
              <span><i class="pi pi-lock"></i> 私密 {{ privOcc }} 人</span>
            </div>
            <div v-if="sortedInstances.length" class="inst-list">
              <div v-for="inst in sortedInstances" :key="inst.location" class="inst-row" role="button" tabindex="0" :title="'打开房间详情：' + inst.location" @click="openInstance(inst.location)" @keydown.enter="openInstance(inst.location)">
                <div class="inst-line1">
                  <i :class="['pi', instIcon(inst)]" class="inst-icon" :style="{ color: inst.type === 'group' ? 'var(--accent-2)' : 'var(--text-dim)' }"></i>
                  <span class="inst-type">{{ instTypeLabel(inst) }}</span>
                  <span v-if="inst.owner && inst.owner.instanceName" class="inst-title" :title="'实例标题：' + inst.owner.instanceName">{{ inst.owner.instanceName }}</span>
                  <span class="inst-cnt">{{ inst.count }} 人</span>
                </div>
                <div class="inst-line2">
                  <span v-if="inst.owner && inst.owner.id" class="inst-owner" :title="inst.owner.kind === 'group' ? '打开群组' : '打开用户'" @click.stop="instOwnerClick(inst)">
                    <img v-if="inst.owner.avatar" :src="inst.owner.avatar" class="inst-owner-av" alt="" loading="lazy" />
                    <i v-else :class="inst.owner.kind === 'group' ? 'pi pi-shield' : 'pi pi-user'" class="inst-owner-ic"></i>
                    <span class="inst-owner-name">{{ instOwnerName(inst) }}</span>
                  </span>
                  <span v-else class="inst-owner-no">—</span>
                  <span class="inst-loc mono">{{ inst.shortName }}</span>
                </div>
              </div>
            </div>
            <div v-else class="empty" style="padding:12px">当前无在线实例</div>
            <div v-if="onlineHere.length" class="wd-online-here">
              <div class="wd-local-head"><i class="pi pi-users"></i> 该世界的好友</div>
              <div class="mini-list">
                <div v-for="f in onlineHere" :key="f.userId" class="mini-row" role="button" tabindex="0" @click="openUser({ userId: f.userId, displayName: f.displayName, avatarUrl: f.avatarUrl || '' })" @keydown.enter="openUser({ userId: f.userId, displayName: f.displayName, avatarUrl: f.avatarUrl || '' })">
                  <img v-if="f.avatarUrl" :src="f.avatarUrl" class="mini-thumb" alt="" loading="lazy" />
                  <span class="mini-name">{{ f.displayName }}</span>
                  <span class="mini-loc text-dim">{{ f.instanceName || '' }}</span>
                </div>
              </div>
            </div>
          </TabPanel>

          <!-- 原始 JSON -->
          <TabPanel value="json">
            <pre class="json-pre">{{ worldJson }}</pre>
          </TabPanel>

          <!-- 备注 -->
          <TabPanel value="note">
            <div class="wd-note">
              <Textarea v-model="noteText" rows="4" placeholder="点击此处添加备注（本地保存，API 刷新不会覆盖）" style="width:100%" />
              <div class="wd-note-actions">
                <Button icon="pi pi-check" label="保存备注" size="small" :loading="noteSaving" @click="saveNote" />
                <Button icon="pi pi-times" label="清空" size="small" text severity="danger" @click="noteText = ''" />
              </div>
            </div>
          </TabPanel>
        </TabPanels>
      </Tabs>
    </div>
  </Dialog>
</template>

<style scoped>
.wd-head { display: flex; align-items: center; gap: 10px; width: 100%; min-width: 0; }
.wd-cover { width: 56px; height: 56px; border-radius: 10px; overflow: hidden; flex: none; background: var(--surface-3); }
.wd-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.wd-cover-empty { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: var(--text-dim); }
.wd-title { flex: 1; min-width: 0; }
.wd-title b { font-size: 14px; display: block; }
.wd-sub { display: flex; align-items: center; gap: 6px; margin-top: 3px; font-size: 11.5px; color: var(--text-dim); flex-wrap: wrap; }
.link { color: var(--accent-2); cursor: pointer; }
.link:hover { text-decoration: underline; }
.wd-badge { padding: 0 7px; border-radius: 7px; font-size: 10.5px; line-height: 16px; }
.wd-badge.pub { background: color-mix(in srgb, var(--ok) 18%, transparent); color: var(--ok); }
.wd-badge.priv { background: color-mix(in srgb, var(--warn) 18%, transparent); color: var(--warn); }
.wd-heat { font-size: 11px; }
.wd-ver { font-size: 10.5px; background: var(--surface-3); border-radius: 6px; padding: 0 6px; line-height: 15px; }
.wd-desc { font-size: 12.5px; color: var(--text-dim); background: var(--surface-2); border-radius: 8px; padding: 10px; margin-bottom: 10px; line-height: 1.5; white-space: pre-wrap; max-height: 120px; overflow-y: auto; }
.facts { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 18px; }
.fact { display: flex; justify-content: space-between; gap: 10px; font-size: 12.5px; padding: 4px 0; border-bottom: 1px dashed var(--border-soft); }
.fact > span:first-child { color: var(--text-dim); flex: none; }
.fact > span:last-child { text-align: right; overflow: hidden; text-overflow: ellipsis; }
.mono { font-family: ui-monospace, monospace; font-size: 11px; }
.wd-local { margin-top: 12px; }
.wd-local-head { font-size: 12px; font-weight: 700; color: var(--text-dim); margin-bottom: 6px; display: flex; align-items: center; gap: 5px; }
.mini-list { display: flex; flex-direction: column; gap: 4px; }
.mini-row { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 6px; cursor: pointer; font-size: 12.5px; }
.mini-row:hover { background: var(--surface-2); }
.mini-thumb { width: 26px; height: 26px; object-fit: cover; border-radius: 50%; flex: none; }
.mini-name { font-weight: 600; }
.mini-loc { font-size: 11px; margin-left: auto; }
.inst-head { display: flex; gap: 14px; font-size: 11.5px; color: var(--text-dim); margin-bottom: 8px; }
.inst-head span { display: inline-flex; align-items: center; gap: 4px; }
.inst-list { display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; }
.inst-row { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; border-radius: 8px; background: var(--surface); border: 1px solid var(--border-soft); cursor: pointer; font-size: 12.5px; transition: border-color 0.12s, background 0.12s; }
.inst-row:hover { border-color: var(--accent); background: var(--surface-2); }
.inst-line1 { display: flex; align-items: center; gap: 7px; min-width: 0; }
.inst-line2 { display: flex; align-items: center; gap: 7px; padding-left: 20px; min-width: 0; }
.inst-icon { flex: none; font-size: 12px; }
.inst-type { font-weight: 600; flex: none; }
.inst-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; color: var(--accent-2); }
.inst-owner { display: inline-flex; align-items: center; gap: 5px; flex: 1; min-width: 0; cursor: pointer; }
.inst-owner:hover .inst-owner-name { color: var(--accent-2); }
.inst-owner-av { width: 20px; height: 20px; border-radius: 50%; object-fit: cover; flex: none; }
.inst-owner-ic { font-size: 11px; color: var(--text-dim); flex: none; }
.inst-owner-name { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; transition: color 0.12s; }
.inst-owner-no { font-size: 11px; color: var(--text-dim); }
.inst-cnt { flex: none; font-size: 11px; color: var(--text); background: var(--surface-3); border-radius: 7px; padding: 1px 7px; line-height: 16px; }
.inst-loc { flex: none; font-size: 10.5px; color: var(--text-dim); }
.wd-online-here { margin-top: 10px; }
.wd-room-meta { margin-top: 10px; font-size: 11.5px; color: var(--text-dim); display: flex; align-items: center; gap: 5px; }
.json-pre { background: var(--surface-2); border-radius: 8px; padding: 10px; font-size: 11px; max-height: 320px; overflow: auto; white-space: pre-wrap; word-break: break-all; }
.wd-note-actions { display: flex; gap: 6px; margin-top: 8px; justify-content: flex-end; }

</style>
