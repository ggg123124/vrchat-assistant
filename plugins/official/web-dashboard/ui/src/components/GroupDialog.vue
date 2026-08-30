<script setup>
import { ref, computed, watch } from 'vue';
import { store, closeGroup, copyText, openWorld } from '../store.js';
import { get, imgUrl } from '../api.js';
import { date } from '../utils.js';

const visible = computed({
  get: () => !!store.groupModal,
  set: (v) => { if (!v) closeGroup(); },
});

const g = ref({});
const announcements = ref([]);
const loading = ref(false);
const tab = ref('ann');

watch(visible, (v) => {
  if (v && store.groupModal) loadGroup();
});

async function loadGroup() {
  const gid = typeof store.groupModal === 'string' ? store.groupModal : (store.groupModal && store.groupModal.groupId);
  if (!gid) return;
  loading.value = true;
  try {
    // 群组信息（缓存 30min）+ 本地历史公告（秒回）并行
    const [d, a] = await Promise.allSettled([
      get(`/api/dashboard/group?groupId=${encodeURIComponent(gid)}`),
      get(`/api/dashboard/group-announcements?groupId=${encodeURIComponent(gid)}`),
    ]);
    g.value = (d.status === 'fulfilled' && d.value && !d.value.error) ? d.value : { groupId: gid };
    announcements.value = (a.status === 'fulfilled' && a.value && a.value.announcements) || [];
  } catch {
    g.value = { groupId: gid };
  }
  loading.value = false;
  // 默认 tab：有公告进公告，否则进房间
  tab.value = hasAnnouncements.value ? 'ann' : 'rooms';
}

// 当前公告（get_group_info includeAnnouncement）
const currentAnn = computed(() => (g.value.announcement && (g.value.announcement.text || g.value.announcement.title)) ? g.value.announcement : null);
// 历史公告（去重当前公告：通知 ID 相同）
const historyAnn = computed(() => announcements.value.filter((a) => !currentAnn.value || a.eventId !== currentAnn.value.id));
const hasAnnouncements = computed(() => !!currentAnn.value || historyAnn.value.length > 0);
const hasRooms = computed(() => (g.value.instances || []).length > 0);

// 群组横幅：bannerId 是 file_xxx
const bannerUrl = computed(() => {
  const b = g.value.bannerId || g.value.bannerUrl || '';
  return b.startsWith('file_') ? `https://api.vrchat.cloud/api/1/file/${b}/1/file` : b;
});

const joinLabels = { open: '开放', invite: '邀请制', closed: '关闭', request: '申请制' };
function joinLabel(s) { return joinLabels[s] || s || ''; }

// 群组房间：从 location/instanceId 解析实例类型与区域（groupAccessType(plus) / region(eu)）
function instInfo(inst) {
  const loc = inst.location || inst.instanceId || '';
  const am = loc.match(/groupAccessType\((\w+)\)/);
  const rm = loc.match(/region\((\w+)\)/);
  const accessLabels = { plus: '会员专属', public: '公开', members: '仅成员' };
  return {
    access: am ? am[1] : '',
    accessLabel: accessLabels[am ? am[1] : ''] || '',
    region: rm ? rm[1].toUpperCase() : '',
  };
}
</script>

<template>
  <Dialog v-model:visible="visible" :header="g.name || '群组'" :style="{ width: 'min(600px, 94vw)' }" :dismissable-mask="true" :modal="true" :maximizable="!store.isMobile" :closeOnEscape="true">
    <div v-if="loading" class="loading-mini"><ProgressSpinner style="width:28px;height:28px" strokeWidth="3" /></div>
    <div v-else-if="!g.groupId" class="empty" style="padding:20px">群组信息不可用</div>
    <div v-else class="gd">
      <div v-if="bannerUrl" class="gd-banner"><img :src="imgUrl(bannerUrl)" alt="" loading="lazy" /></div>
      <div class="gd-title">
        <h3>
          {{ g.name || g.groupId }}
          <Tag v-if="g.isVerified" value="已验证" severity="info" rounded />
        </h3>
        <div class="gd-meta">
          <span v-if="g.shortCode" class="mono">{{ g.shortCode }}</span>
          <span v-if="g.memberCount != null">{{ Number(g.memberCount).toLocaleString() }} 成员</span>
          <span v-if="g.joinState">{{ joinLabel(g.joinState) }}</span>
        </div>
        <div class="gd-uid">
          <span class="mono text-dim">{{ g.groupId }}</span>
          <Button icon="pi pi-copy" text size="small" rounded :aria-label="'复制群组 ID'" @click="copyText(g.groupId)" />
        </div>
      </div>

      <div v-if="(g.tags || []).length" class="gd-tags">
        <span v-for="t in g.tags" :key="t" class="gd-tag">{{ t }}</span>
      </div>

      <div v-if="g.description" class="gd-desc">{{ g.description }}</div>

      <!-- 选项卡：公告 / 群组房间（无内容则隐藏对应页） -->
      <Tabs v-if="hasAnnouncements || hasRooms" v-model:value="tab" class="gd-tabs">
        <TabList>
          <Tab v-if="hasAnnouncements" value="ann">公告</Tab>
          <Tab v-if="hasRooms" value="rooms">群组房间（{{ (g.instances || []).length }}）</Tab>
        </TabList>
        <TabPanels>
          <!-- 公告页 -->
          <TabPanel v-if="hasAnnouncements" value="ann">
            <div class="gd-ann-wrap">
              <div v-if="currentAnn" class="gd-ann">
                <div class="gd-sec-label">当前公告</div>
                <b>{{ currentAnn.title }}</b>
                <div class="gd-ann-text">{{ currentAnn.text }}</div>
              </div>
              <div v-if="historyAnn.length" class="gd-ann-list">
                <div class="gd-sec-label">历史公告（{{ historyAnn.length }}）</div>
                <div v-for="a in historyAnn" :key="a.eventId" class="gd-ann-item">
                  <div class="gd-ann-item-head">
                    <b>{{ a.title }}</b>
                    <span class="mono text-dim">{{ date(a.createdAt) }}</span>
                  </div>
                  <div class="gd-ann-text">{{ a.text }}</div>
                </div>
              </div>
            </div>
          </TabPanel>
          <!-- 房间页 -->
          <TabPanel v-if="hasRooms" value="rooms">
            <div class="gd-inst">
              <div v-for="(inst, i) in g.instances" :key="i" class="gd-inst-item" @click="inst.worldId && openWorld(inst.worldId)" role="button" tabindex="0" @keydown.enter="inst.worldId && openWorld(inst.worldId)" :title="inst.worldId ? '点击打开世界' : ''">
                <img v-if="inst.worldImageUrl" :src="imgUrl(inst.worldImageUrl)" class="gd-inst-img" alt="" loading="lazy" />
                <div class="gd-inst-body">
                  <b class="gd-inst-name">{{ inst.worldName || '群组房间' }}</b>
                  <div class="gd-inst-meta">
                    <span v-if="inst.memberCount != null"><i class="pi pi-users"></i> {{ inst.memberCount }}/{{ inst.worldCapacity || '?' }}</span>
                    <span v-if="instInfo(inst).region">{{ instInfo(inst).region }}</span>
                    <span v-if="instInfo(inst).accessLabel" class="gd-inst-access" :class="'access-' + instInfo(inst).access">{{ instInfo(inst).accessLabel }}</span>
                    <span v-if="inst.worldAuthor" class="text-dim">{{ inst.worldAuthor }}</span>
                  </div>
                </div>
                <Button v-if="inst.instanceId" icon="pi pi-copy" text size="small" rounded :aria-label="'复制实例 ID'" @click.stop="copyText(inst.instanceId)" />
              </div>
            </div>
          </TabPanel>
        </TabPanels>
      </Tabs>
    </div>
  </Dialog>
</template>

<style scoped>
.loading-mini { display: flex; justify-content: center; padding: 30px; }
.gd { display: flex; flex-direction: column; gap: 12px; }
.gd-banner {
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid var(--border);
  max-height: 180px;
}
.gd-banner img { width: 100%; object-fit: cover; display: block; max-height: 180px; }
.gd-title h3 { margin: 0; font-size: 18px; display: flex; align-items: center; gap: 8px; }
.gd-meta { display: flex; gap: 10px; color: var(--text-dim); font-size: 12px; margin-top: 4px; flex-wrap: wrap; }
.gd-uid { display: flex; align-items: center; gap: 4px; margin-top: 2px; }
.gd-tags { display: flex; gap: 6px; flex-wrap: wrap; }
.gd-tag {
  font-size: 10.5px;
  color: var(--text-dim);
  background: var(--surface-3);
  border: 1px solid var(--border);
  padding: 2px 8px;
  border-radius: 999px;
}
.gd-desc { color: var(--text-dim); font-size: 12.5px; line-height: 1.6; white-space: pre-wrap; max-height: 140px; overflow-y: auto; }

/* 选项卡 */
.gd-tabs { margin-top: 2px; }
.gd-tabs :deep(.p-tablist-tab) { font-size: 12.5px; padding: 8px 14px; }

.gd-sec-label { font-size: 11px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.4px; margin-bottom: 6px; }

/* 公告 */
.gd-ann-wrap { display: flex; flex-direction: column; gap: 12px; }
.gd-ann {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.gd-ann-list { display: flex; flex-direction: column; gap: 8px; }
.gd-ann-item {
  background: var(--surface);
  border: 1px solid var(--border-soft);
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.gd-ann-item-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.gd-ann-item-head .mono { font-size: 11px; white-space: nowrap; }
.gd-ann-text { color: var(--text); font-size: 12.5px; line-height: 1.6; white-space: pre-wrap; max-height: 180px; overflow-y: auto; }

/* 群组房间 */
.gd-inst { display: flex; flex-direction: column; gap: 6px; }
.gd-inst-item {
  display: flex;
  align-items: center;
  gap: 10px;
  background: var(--surface-2);
  border: 1px solid var(--border-soft);
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 12.5px;
  cursor: pointer;
  transition: border-color 0.12s, background 0.12s;
}
.gd-inst-item:hover { border-color: var(--accent); background: var(--surface-3); }
.gd-inst-img {
  width: 42px;
  height: 42px;
  object-fit: cover;
  border-radius: 6px;
  border: 1px solid var(--border);
  flex: none;
}
.gd-inst-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.gd-inst-name { color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gd-inst-meta { display: flex; align-items: center; gap: 8px; color: var(--text-dim); font-size: 11.5px; flex-wrap: wrap; }
.gd-inst-meta .pi-users { font-size: 10px; }
.gd-inst-access {
  font-size: 10.5px;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--surface-3);
  border: 1px solid var(--border);
}
.gd-inst-access.access-plus { color: #ffca28; border-color: color-mix(in srgb, #ffca28 40%, var(--border)); }
.gd-inst-access.access-public { color: #2bcf5c; border-color: color-mix(in srgb, #2bcf5c 40%, var(--border)); }
.gd-inst-access.access-members { color: var(--accent-2); border-color: color-mix(in srgb, var(--accent-2) 40%, var(--border)); }
</style>
