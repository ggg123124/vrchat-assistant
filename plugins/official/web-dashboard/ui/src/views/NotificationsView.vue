<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { get, post } from '../api.js';
import { time, date, trustColor, avatarLabel, notificationTypeLabels } from '../utils.js';
import { store, openUser, openGroup, loadNotifCount } from '../store.js';
import { toast } from '../toast.js';

// 通知中心（对齐 VRCX Notifications）：当前可操作（好友申请接受/拒绝、已读/隐藏）+ 历史回看
// 数据：/api/dashboard/notifications（social.js 富版：get_notifications 当前通知 + notificationEvents 历史）
const tab = ref('current');       // current | history
const current = ref(null);
const history = ref(null);
const loading = ref(false);
const acting = ref(new Set());
const kindSel = ref('all');
const onlyUnseen = ref(false);   // 只看未读

const KINDS = [
  { v: 'all', l: '全部' },
  { v: 'friendRequest', l: '好友申请' },
  { v: 'invite', l: '邀请' },
  { v: 'requestInvite', l: '请求邀请' },
  { v: 'group', l: '群组' },
  { v: 'message', l: '私信' },
  { v: 'other', l: '其他' },
];

function kindOf(x) {
  const t = String(x.type || x.notificationType || '').toLowerCase();
  if (t.includes('friendrequest')) return 'friendRequest';
  if (t === 'invite' || t.includes('invite')) return 'invite';
  if (t === 'requestinvite' || t.includes('requestinvite')) return 'requestInvite';
  if (t.startsWith('group')) return 'group';
  if (t === 'message' || t === 'privatemessage') return 'message';
  return 'other';
}
function typeLabel(x) {
  const t = x.type || x.notificationType || '';
  return notificationTypeLabels[t] || KINDS.find(k => k.v === kindOf(x))?.l || '通知';
}

const currentShown = computed(() => {
  let list = current.value || [];
  if (kindSel.value !== 'all') list = list.filter(x => kindOf(x) === kindSel.value);
  if (onlyUnseen.value) list = list.filter(x => !x.seen);
  return list;
});
const historyShown = computed(() => {
  const list = history.value || [];
  if (kindSel.value === 'all') return list;
  return list.filter(x => kindOf(x) === kindSel.value);
});

// 全部已读（VRChat API 无批量端点：逐个标记未读，最多 15 条避免拖慢限流）
const seeingAll = ref(false);
async function markAllSeen() {
  if (seeingAll.value) return;
  seeingAll.value = true;
  try {
    const r = await post('/api/dashboard/notifications/see-all');
    if (r && r.error) throw new Error(r.error);
    toast(`已标记 ${r.seen || 0} 条为已读`, r.seen ? 'success' : 'info');
    await reload();
  } catch (e) {
    toast('标记失败：' + (e.message || e), 'error');
  } finally {
    seeingAll.value = false;
  }
}

async function load() {
  if (loading.value) return;
  loading.value = true;
  try {
    const r = await get('/api/dashboard/notifications?limit=60');
    current.value = (r && r.notifications) || [];
    history.value = (r && r.history) || [];
  } catch (e) {
    current.value = current.value || [];
    history.value = history.value || [];
    toast('加载通知失败：' + (e.message || e), 'error');
  } finally {
    loading.value = false;
    loadNotifCount();  // 查看后重算未读徽标
  }
}
function reload() { current.value = null; history.value = null; load(); }
function setKind(v) { kindSel.value = v; }

// 当前通知操作（好友申请接受/拒绝、已读、隐藏）：乐观移除 + 失败回滚
async function act(x, action) {
  const key = x.id + ':' + action;
  if (acting.value.has(key)) return;
  acting.value.add(key);
  const prev = current.value;
  if (action !== 'see') current.value = (current.value || []).filter(i => i.id !== x.id);
  try {
    const r = await post('/api/dashboard/notification-action', { action, notificationId: x.id });
    if (r && r.error) throw new Error(r.error);
    toast(action === 'accept' ? '已接受好友申请' : action === 'decline' ? '已拒绝' : action === 'see' ? '已标为已读' : '已隐藏', 'success');
  } catch (e) {
    current.value = prev;
    toast('操作失败：' + (e.message || e), 'error');
  } finally {
    acting.value.delete(key);
  }
}

function friendAvatarOf(userId) {
  const f = (store.friends || []).find(fr => fr.userId === userId);
  return (f && (f.avatarUrl || f.userIcon)) || '';
}
function nameOf(x) {
  const f = (store.friends || []).find(fr => fr.userId === (x.senderUserId || x.userId));
  return (f && (f.memo || f.displayName)) || x.senderUsername || x.displayName || '?';
}
// 通知类型 → 图标（对齐 VRCX 通知样式：好友申请/邀请/私信/群组/系统）
function typeIcon(x) {
  const k = kindOf(x);
  if (k === 'friendRequest') return 'pi-user-plus';
  if (k === 'invite') return 'pi-arrow-right-arrow-left';
  if (k === 'requestInvite') return 'pi-arrow-right';
  if (k === 'group') return 'pi-users';
  if (k === 'message') return 'pi-comment';
  return 'pi-bell';
}

onMounted(load);
let timer = null;
onMounted(() => { timer = setInterval(load, 60_000); });
onUnmounted(() => clearInterval(timer));
</script>

<template>
  <div class="nt">
    <div class="nt-head">
      <h2><i class="pi pi-bell"></i> 通知</h2>
      <span class="nt-count">当前 {{ currentShown.length }} · 历史 {{ historyShown.length }}</span>
      <Button size="small" icon="pi pi-check-double" :loading="seeingAll" label="全部已读" title="标记当前未读通知为已读（最多 15 条）" @click="markAllSeen" />
      <Button size="small" text icon="pi pi-refresh" title="刷新" @click="reload" />
    </div>

    <div class="nt-chips" role="group" aria-label="通知类型筛选">
      <button v-for="k in KINDS" :key="k.v" class="chip" :class="{ active: kindSel === k.v }" @click="setKind(k.v)">{{ k.l }}</button>
      <button class="chip nt-unseen" :class="{ active: onlyUnseen }" @click="onlyUnseen = !onlyUnseen"><i class="pi pi-bell"></i> 只看未读</button>
    </div>

    <div v-if="loading && !current && !history" class="loading-mini"><ProgressSpinner style="width:28px;height:28px" strokeWidth="4" /></div>

    <template v-else>
      <!-- 当前通知（可操作） -->
      <div class="nt-sec"><i class="pi pi-bell"></i> 当前通知</div>
      <div v-if="!currentShown.length" class="empty" style="padding:14px">
        <i class="pi pi-bell empty-icon" aria-hidden="true"></i>暂无待处理通知</div>
      <div v-else class="nt-list">
        <div v-for="x in currentShown" :key="x.id" class="nt-row" :class="{ unseen: !x.seen }">
        <span v-if="!x.seen" class="nt-dot" aria-hidden="true"></span>
          <img v-if="friendAvatarOf(x.senderUserId) || x.imageUrl" class="nt-av" :src="friendAvatarOf(x.senderUserId) || x.imageUrl" alt="" loading="lazy" />
          <div v-else class="nt-av nt-av-empty">{{ avatarLabel('', nameOf(x)) }}</div>
          <div class="nt-body">
            <div class="nt-top">
              <b class="nt-name" :style="{ color: trustColor((store.friends || []).find(fr => fr.userId === x.senderUserId)?.trustLevel) }" @click="x.senderUserId?.startsWith('usr_') && openUser({ userId: x.senderUserId, displayName: nameOf(x) })" role="button" tabindex="0" @keydown.enter="x.senderUserId?.startsWith('usr_') && openUser({ userId: x.senderUserId, displayName: nameOf(x) })">{{ nameOf(x) }}</b>
              <span class="nt-type"><i class="pi nt-ico" :class="typeIcon(x)"></i>{{ typeLabel(x) }}</span>
              <span class="nt-time mono" :title="date(x.created_at)">{{ time(x.created_at) }}</span>
            </div>
            <div class="nt-msg">{{ x.message || x.details || typeLabel(x) }}</div>
          </div>
          <div class="nt-acts">
            <template v-if="kindOf(x) === 'friendRequest'">
              <Button size="small" icon="pi pi-check" rounded :loading="acting.has(x.id + ':accept')" aria-label="接受好友申请" title="接受" @click.stop="act(x, 'accept')" />
              <Button size="small" icon="pi pi-times" rounded text severity="secondary" :loading="acting.has(x.id + ':decline')" aria-label="拒绝好友申请" title="拒绝" @click.stop="act(x, 'decline')" />
            </template>
            <template v-else>
              <Button size="small" icon="pi pi-envelope" rounded text severity="secondary" :loading="acting.has(x.id + ':see')" aria-label="标为已读" title="标为已读" @click.stop="act(x, 'see')" />
              <Button size="small" icon="pi pi-trash" rounded text severity="secondary" :loading="acting.has(x.id + ':hide')" aria-label="隐藏" title="隐藏" @click.stop="act(x, 'hide')" />
            </template>
          </div>
        </div>
      </div>

      <!-- 历史通知（只读回看） -->
      <div class="nt-sec"><i class="pi pi-history"></i> 历史通知</div>
      <div v-if="!historyShown.length" class="empty" style="padding:14px">暂无历史通知</div>
      <div v-else class="nt-list">
        <div v-for="x in historyShown" :key="x.eventId" class="nt-row nt-ro">
          <div v-if="x.senderUsername" class="nt-av nt-av-empty">{{ avatarLabel('', x.senderUsername) }}</div>
          <div v-else class="nt-av nt-av-empty">{{ avatarLabel('', '?') }}</div>
          <div class="nt-body">
            <div class="nt-top">
              <b class="nt-name">{{ x.senderUsername || '系统' }}</b>
              <span class="nt-type"><i class="pi nt-ico" :class="typeIcon(x)"></i>{{ typeLabel(x) }}</span>
              <span class="nt-time mono" :title="date(x.createdAt)">{{ time(x.createdAt) }}<small>{{ date(x.createdAt) }}</small></span>
            </div>
            <div class="nt-msg">{{ x.message || x.title || typeLabel(x) }}</div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.nt { padding: 4px; }
.nt-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.nt-count { font-size: 11px; color: var(--text-dim); flex: 1; }
.nt-row.unseen { background: color-mix(in srgb, var(--accent) 6%, var(--surface)); }
.nt-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); flex: none; }
.nt-chips { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; }




.nt-sec { display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 700; color: var(--text-dim); margin: 14px 0 8px; text-transform: uppercase; letter-spacing: 0.4px; }
.nt-list { display: flex; flex-direction: column; gap: 6px; }
.nt-row { display: flex; align-items: flex-start; gap: 9px; padding: 8px 9px; border-radius: 8px; background: var(--surface); border: 1px solid var(--border-soft); }
.nt-row:hover { border-color: var(--accent); }
.nt-ro { opacity: 0.92; }
.nt-av { width: 34px; height: 34px; border-radius: 50%; object-fit: cover; flex: none; }
.nt-av-empty { display: flex; align-items: center; justify-content: center; background: var(--surface-3); color: var(--text-dim); font-weight: 600; }
.nt-body { min-width: 0; flex: 1; }
.nt-top { display: flex; align-items: center; gap: 7px; min-width: 0; }
.nt-name { font-size: 12.5px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.nt-name:hover { text-decoration: underline; }
.nt-type { font-size: 10px; color: var(--text-dim); background: var(--surface-3); border-radius: 8px; padding: 0 6px; flex: none; }
.nt-ico { font-size: 9px; margin-right: 4px; opacity: 0.8; }
.nt-time { font-size: 10px; color: var(--text-dim); margin-left: auto; flex: none; font-family: var(--font-mono, monospace); }
.nt-time small { margin-left: 4px; }
.nt-msg { font-size: 11.5px; color: var(--text-dim); margin-top: 3px; overflow-wrap: anywhere; }
.nt-acts { display: flex; flex-direction: column; gap: 4px; flex: none; }

@media (max-width: 899px) {
  .nt-chips { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; -webkit-overflow-scrolling: touch; padding-bottom: 2px; }
  .nt-chips::-webkit-scrollbar { display: none; }
  .nt-acts { flex-direction: row; }
}
</style>
