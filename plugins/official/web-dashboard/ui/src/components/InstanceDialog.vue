<script setup>
import { computed, ref, watch } from 'vue';
import { store, closeInstance, openWorld, openUser } from '../store.js';
import { get } from '../api.js';
import { parseLoc, instanceLabel, locLabelFull, avatarLabel, trustColor, statusLabels } from '../utils.js';

const visible = computed({
  get: () => !!store.instanceModal,
  set: (v) => { if (!v) closeInstance(); },
});

const inst = computed(() => {
  const m = store.instanceModal;
  if (!m || !m.location) return null;
  const p = parseLoc(m.location);
  if (!p) return null;
  // 同位置的好友（在线且 location 一致）
  const members = (store.friends || []).filter((f) => f.isOnline && f.location === m.location);
  // 世界名/图：从同位置好友或自己取
  const sample = members[0] || (store.me && store.me.location === m.location ? store.me : null);
  return {
    worldId: p.worldId || '',
    worldName: (sample && sample.worldName) || '',
    worldImageUrl: (sample && sample.worldImageUrl) || '',
    typeLabel: instanceLabel(p.type),
    region: p.region ? p.region.toUpperCase() : '',
    instanceId: p.instanceId || '',
    members,
  };
});

// 实例详情（房主/容量/在线用户）
const detail = ref(null);
const detailLoading = ref(false);
watch(() => store.instanceModal, async (m) => {
  detail.value = null;
  if (m && m.location) {
    detailLoading.value = true;
    try {
      const d = await get(`/api/dashboard/instance?location=${encodeURIComponent(m.location)}`);
      if (!d.error) detail.value = d;
    } catch { /* 保持空 */ }
    detailLoading.value = false;
  }
});
</script>

<template>
  <Dialog v-model:visible="visible" header="房间信息" :style="{ width: 'min(440px, 94vw)' }" :dismissable-mask="true" :modal="true" :closeOnEscape="true">
    <div v-if="inst" class="inst">
      <!-- 世界信息 -->
      <div class="inst-world" @click="openWorld(inst.worldId)" role="button" tabindex="0" @keydown.enter="openWorld(inst.worldId)">
        <img v-if="inst.worldImageUrl" :src="inst.worldImageUrl" class="inst-img" alt="" loading="lazy" />
        <div class="inst-wtext">
          <b>{{ inst.worldName || '未公开位置' }}</b>
          <small class="mono">{{ inst.worldId }}</small>
        </div>
        <i class="pi pi-angle-right inst-go"></i>
      </div>
      <!-- 实例信息 -->
      <div class="inst-meta">
        <span class="inst-tag">{{ inst.typeLabel }}</span>
        <span v-if="detail && detail.displayName && detail.displayName !== inst.instanceId" class="inst-tag inst-title-tag">{{ detail.displayName }}</span>
        <span v-if="inst.region" class="inst-tag">{{ inst.region }}</span>
        <span class="inst-tag mono">房间 {{ inst.instanceId }}</span>
        <span v-if="detail && detail.capacity" class="inst-tag">容量 {{ detail.capacity }}</span>
      </div>
      <!-- 房主（实例详情） -->
      <div v-if="detail && detail.ownerId" class="inst-owner-row" role="button" tabindex="0" @click="openUser(detail.ownerId)" @keydown.enter="openUser(detail.ownerId)">
        <img v-if="detail.ownerAvatar" :src="detail.ownerAvatar" class="io-av" alt="" loading="lazy" />
        <i v-else class="pi pi-user io-ic"></i>
        <div class="io-text">
          <b>{{ detail.ownerName || detail.ownerId.slice(0, 8) + '…' }}</b>
          <small class="text-dim">房主</small>
        </div>
      </div>
      <!-- 本房间用户（实例详情全量，失败兜底好友） -->
      <div class="inst-sec">本房间用户{{ detail && detail.users ? '（' + detail.users.length + '）' : inst.members.length ? '（' + inst.members.length + '）' : '' }}</div>
      <div v-if="detailLoading" class="inst-empty">加载中…</div>
      <div v-else-if="detail && detail.users && detail.users.length" class="inst-members">
        <div v-for="u in detail.users" :key="u.id" class="inst-member" role="button" tabindex="0" @click="openUser(u.id)" @keydown.enter="openUser(u.id)">
          <Avatar :image="u.avatarUrl" shape="circle" size="small" :label="(u.displayName || '?')[0]" />
          <div class="im-text">
            <b :style="{ color: trustColor(u.trustLevel) }">{{ store.nicknameMap[u.id] || u.displayName || '?' }}</b>
          </div>
        </div>
      </div>
      <div v-else-if="inst.members.length" class="inst-members">
        <div v-for="f in inst.members" :key="f.userId" class="inst-member" @click="openUser(f.userId)" role="button" tabindex="0" @keydown.enter="openUser(f.userId)">
          <Avatar :image="f.avatarUrl || f.userIcon" shape="circle" size="small" :label="avatarLabel(f.avatarUrl || f.userIcon, f.displayName)" />
          <div class="im-text">
            <b :style="{ color: trustColor(f.trustLevel) }">{{ store.nicknameMap[f.userId] || f.displayName || '?' }}</b>
            <small>{{ f.statusDescription || statusLabels[f.status] || '在线' }}</small>
          </div>
        </div>
      </div>
      <div v-else class="inst-empty">暂无其他用户在此房间</div>
    </div>
  </Dialog>
</template>

<style scoped>
.inst { display: flex; flex-direction: column; gap: 10px; }
.inst-world {
  display: flex;
  align-items: center;
  gap: 10px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px;
  cursor: pointer;
}
.inst-world:hover { border-color: var(--accent); }
.inst-img { width: 46px; height: 46px; object-fit: cover; border-radius: 6px; flex: none; }
.inst-wtext { min-width: 0; flex: 1; }
.inst-wtext b { display: block; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.inst-wtext small { color: var(--text-dim); font-size: 10px; display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.inst-go { color: var(--text-dim); flex: none; }
.inst-meta { display: flex; flex-wrap: wrap; gap: 6px; }
.inst-title-tag { color: var(--accent-2); font-weight: 600; }
.inst-owner-row { display: flex; align-items: center; gap: 8px; padding: 6px 9px; background: var(--surface-2); border-radius: 8px; cursor: pointer; }
.inst-owner-row:hover { border-color: var(--accent); }
.io-av { width: 26px; height: 26px; border-radius: 50%; object-fit: cover; flex: none; }
.io-ic { color: var(--text-dim); flex: none; }
.io-text { display: flex; flex-direction: column; line-height: 1.25; }
.io-text small { font-size: 10.5px; }
.inst-tag {
  font-size: 11px;
  color: var(--text);
  background: var(--surface-3);
  border: 1px solid var(--border);
  padding: 2px 9px;
  border-radius: 10px;
}
.inst-sec { font-size: 11px; font-weight: 700; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.4px; }
.inst-empty { color: var(--text-dim); font-size: 12px; padding: 6px 2px; }
.inst-members { display: flex; flex-direction: column; gap: 4px; max-height: 240px; overflow-y: auto; }
.inst-member {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border-radius: 6px;
  cursor: pointer;
}
.inst-member:hover { background: var(--surface-2); }
.im-text { min-width: 0; flex: 1; }
.im-text b { display: block; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.im-text small { display: block; color: var(--text-dim); font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
