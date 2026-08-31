<script setup>
import { computed, ref } from 'vue';
import { store, openUser, applyStatus, openInstance } from '../store.js';
import { trustColor, locLabel, statusLabels, avatarLabel, platformLabel, platformIcon } from '../utils.js';
import { toast } from '../toast.js';
import { useFriendGroups, statusColor, friendDotStyle } from '../composables/useFriendGroups.js';

const q = ref('');
const desc = ref('');

// 状态按钮顺序：欢迎加入(蓝) 在线(绿) 忙碌(橙) 请勿打扰(红)
const statusOrder = [
  { v: 'join me', l: '欢迎加入' },
  { v: 'active', l: '在线' },
  { v: 'ask me', l: '忙碌' },
  { v: 'busy', l: '请勿打扰' },
];
// 分组/折叠/签名/状态点统一走公共 composable（C5，与好友位置页一致，避免两边漂移）
const { collapsed, toggleGroup, isCollapsed, sameInstanceOf, sameWorldOf, groupByWorld, statusText, locText, avatarOf, groupIcon, nameFor } = useFriendGroups();

const friends = computed(() => store.friends || []);
const qf = computed(() => {
  const query = q.value.trim().toLowerCase();
  return friends.value.filter((f) => !query || (f.displayName || '').toLowerCase().includes(query) || (f.userId || '').includes(query));
});
// 收藏好友单独成区（去重）：在线/离线分组都排除收藏好友，收藏 section 作为唯一入口
const favorites = computed(() => qf.value.filter((f) => store.favFriendIds && store.favFriendIds.has(f.userId)));
const isFav = (f) => !!(store.favFriendIds && store.favFriendIds.has(f.userId));
const online = computed(() => qf.value.filter((f) => f.isOnline && !isFav(f)));
const offline = computed(() => qf.value.filter((f) => !f.isOnline && !isFav(f)));

// 同实例 / 同世界 / 世界分组（含网页端在线组）：来自公共 composable，与好友位置页同源
const sameInstance = computed(() => sameInstanceOf(online.value));
const sameWorld = computed(() => sameWorldOf(online.value));
const groups = computed(() => groupByWorld(online.value));

// 最近一起玩（store.coPlay 由 load() 10 分钟节流拉取；头像/昵称从好友列表与昵称映射补全）
const coSecOpen = ref(true);
const coAll = ref(false);
const coShown = computed(() => { const l = store.coPlay || []; return coAll.value ? l : l.slice(0, 8); });
const friendMap = computed(() => { const m = new Map(); for (const f of friends.value) m.set(f.userId, f); return m; });
function coAvatar(c) { const f = friendMap.value.get(c.userId); return (f && (f.avatarUrl || f.userIcon)) || ''; }
function coName(c) { return store.nicknameMap[c.userId] || c.displayName || '?'; }
function meStatusText() {
  const me = store.me;
  if (!me) return '';
  const loc = me.location || '';
  if (me.travelingToLocation) return '传送中';
  if (loc === 'offline') return '离线';
  if (me.statusDescription) return me.statusDescription;
  return statusLabels[me.status] || '在线';
}
function meLocText() {
  const me = store.me;
  if (!me) return '';
  const loc = me.location || '';
  if (loc === 'offline' || !loc || me.travelingToLocation) return '';
  return locLabel(loc) || '';
}
async function setStatus(v) {
  const msg = await applyStatus(v, desc.value);
  toast(msg, msg.includes('失败') ? 'error' : 'success');
}

/* ── 状态修改：选择（可选）→ 统一勾按钮提交 → 乐观更新 → 失败回滚 ── */
const selectedStatus = ref(null);   // 当前选中的状态（可选）
const applyingStatus = ref(false);  // 正在发送请求
const statusError = ref('');        // 失败提示

// 点击状态按钮 = 选择（再点相同取消，点别的切换）；不立即提交
function chooseStatus(v) {
  statusError.value = '';
  selectedStatus.value = selectedStatus.value === v ? null : v;
}

// 统一提交（勾按钮 / Enter）：
// - 选了状态 + 描述 → 同时提交状态和描述
// - 只选状态 → 提交状态（描述为空则不带描述）
// - 只填描述 → 只更新描述（保持当前状态）
// - 都没填 → 无操作
async function submitStatus() {
  if (applyingStatus.value) return;
  const hasSel = !!selectedStatus.value;
  const hasDesc = desc.value.trim() !== '';
  if (!hasSel && !hasDesc) return;
  const target = hasSel ? selectedStatus.value : (store.me.status || 'active');
  const prevStatus = store.me.status;
  const prevDesc = store.me.statusDescription;
  // 乐观更新：先改面板，不等 API
  if (hasSel) store.me.status = target;
  if (hasDesc) store.me.statusDescription = desc.value.trim();
  applyingStatus.value = true;
  statusError.value = '';
  try {
    const msg = await applyStatus(target, desc.value.trim());
    const failed = !msg || msg === '更新失败' || msg === '更新状态失败' || msg.startsWith('更新失败');
    if (failed) throw new Error(msg || '更新失败');
    desc.value = '';
    toast(msg, 'success');
  } catch {
    // 失败回滚（只回滚实际改过的字段）
    if (hasSel) store.me.status = prevStatus;
    if (hasDesc) store.me.statusDescription = prevDesc;
    statusError.value = '状态更新失败，已恢复原状态';
    toast(statusError.value, 'error');
  } finally {
    applyingStatus.value = false;
    selectedStatus.value = null;
  }
}
</script>

<template>
  <div class="rb-inner">
    <div class="rb-head">
      <span class="rb-title">好友列表</span>
      <span class="rb-num">{{ online.length }} / {{ friends.length }}</span>
    </div>

    <!-- 我（含状态设置） -->
    <div v-if="store.me" class="me-item">
      <div class="me-top" @click="openUser(store.me.userId)" role="button" tabindex="0" @keydown.enter="openUser(store.me.userId)">
        <Avatar :image="store.me.avatarUrl || store.me.userIcon" shape="circle" :label="avatarLabel(store.me.avatarUrl || store.me.userIcon, store.me.displayName)" />
        <div class="me-text">
          <b :style="{ color: trustColor(store.me.trustLevel) }">{{ store.me.displayName || store.me.userId }}</b>
          <small><span class="me-dot" :style="{ background: statusColor(store.me.status) }"></span>{{ meStatusText() }}<span v-if="meLocText()"> · {{ meLocText() }}</span></small>
        </div>
      </div>
      <!-- 状态快速设置：点击选择 → 勾选确认 -->
      <div class="me-preset" @click.stop>
        <div class="mp-btns">
          <button v-for="s in statusOrder" :key="s.v" class="mp-btn"
            :class="{ active: store.me.status === s.v, selected: selectedStatus === s.v }"
            :title="'选择状态：' + s.l" @click="chooseStatus(s.v)">
            <span class="mp-dot" :style="{ background: statusColor(s.v) }"></span>
            {{ s.l }}
          </button>
        </div>
        <span v-if="statusError" class="mp-error">{{ statusError }}</span>
        <div class="mp-row">
          <input v-model="desc" placeholder="状态描述（可选）…" maxlength="32" class="mp-input" @keydown.enter="submitStatus()" />
          <Button icon="pi pi-check" size="small" rounded text :disabled="applyingStatus" :aria-label="'提交状态'" @click="submitStatus()" />
        </div>
      </div>
    </div>

    <div class="rb-search">
      <i class="pi pi-search"></i>
      <input v-model="q" placeholder="搜索好友…" class="rs-input" aria-label="搜索好友" />
      <i v-if="q" class="pi pi-times rs-clear" title="清空" @click="q = ''"></i>
    </div>

    <div class="rb-sec">
      <div class="rb-sec-head"><span>在线好友</span><span class="rb-cnt">{{ online.length }}</span></div>
      <div v-if="!online.length" class="rb-empty">暂无在线好友</div>
      <div v-else class="rb-groups">
        <!-- 同实例 -->
        <div v-if="sameInstance.length" class="wg accent">
          <div class="wg-head" role="button" tabindex="0" title="点击折叠/展开" @click="toggleGroup('same')" @keydown.enter="toggleGroup('same')">
            <i class="pi pi-map-marker"></i>
            <span>同实例好友</span>
            <span class="wg-num">{{ sameInstance.length }}</span>
            <i class="pi wg-arrow" :class="isCollapsed('same') ? 'pi-chevron-down' : 'pi-chevron-up'"></i>
          </div>
          <template v-if="!isCollapsed('same')">
            <div v-for="f in sameInstance" :key="f.userId" class="rb-friend" @click="openUser(f.userId)">
              <Avatar :image="avatarOf(f)" shape="circle" size="small" :label="avatarLabel(avatarOf(f), f.displayName)" />
              <div class="rf-text">
                <b :style="{ color: trustColor(f.trustLevel) }">{{ nameFor(f) }}</b><i v-if="store.watchlistIds.has(f.userId)" class="pi pi-eye rb-watch" title="关注名单"></i>
                <small><span class="rf-dot" :style="friendDotStyle(f)"></span>{{ statusText(f) }}<i v-if="platformIcon(f.platform)" class="pi rf-plat" :class="platformIcon(f.platform)" :title="platformLabel(f.platform)"></i></small>
              </div>
            </div>
          </template>
        </div>
        <!-- 同世界（同世界不同实例）：pi-compass 与同实例的 map-marker 区分 -->
        <div v-if="sameWorld.length" class="wg">
          <div class="wg-head" role="button" tabindex="0" title="同世界、不同实例的在线好友" @click="toggleGroup('sworld')" @keydown.enter="toggleGroup('sworld')">
            <i class="pi pi-compass"></i>
            <span>同世界好友</span>
            <span class="wg-num">{{ sameWorld.length }}</span>
            <i class="pi wg-arrow" :class="isCollapsed('sworld') ? 'pi-chevron-down' : 'pi-chevron-up'"></i>
          </div>
          <template v-if="!isCollapsed('sworld')">
            <div v-for="f in sameWorld" :key="f.userId" class="rb-friend" @click="openUser(f.userId)">
              <Avatar :image="avatarOf(f)" shape="circle" size="small" :label="avatarLabel(avatarOf(f), f.displayName)" />
              <div class="rf-text">
                <b :style="{ color: trustColor(f.trustLevel) }">{{ nameFor(f) }}</b><i v-if="store.watchlistIds.has(f.userId)" class="pi pi-eye rb-watch" title="关注名单"></i>
                <small><span class="rf-dot" :style="friendDotStyle(f)"></span>{{ statusText(f) }}<i v-if="platformIcon(f.platform)" class="pi rf-plat" :class="platformIcon(f.platform)" :title="platformLabel(f.platform)"></i></small>
              </div>
            </div>
          </template>
        </div>
        <div v-for="g in groups" :key="g.label" class="wg">
          <div class="wg-head" role="button" tabindex="0" title="点击折叠/展开" @click="toggleGroup('w:' + (g.worldId || g.label))" @keydown.enter="toggleGroup('w:' + (g.worldId || g.label))">
            <img v-if="groupIcon(g)" :src="groupIcon(g)" class="wg-thumb" alt="" loading="lazy" />
            <span :title="g.label">{{ g.label }}</span>
            <span v-if="g.loc" class="wg-loc" @click.stop="openInstance(g.list[0].location)" :title="'查看房间信息'">{{ g.loc }}</span>
            <span class="wg-num">{{ g.list.length }}</span>
            <i class="pi wg-arrow" :class="isCollapsed('w:' + (g.worldId || g.label)) ? 'pi-chevron-down' : 'pi-chevron-up'"></i>
          </div>
          <template v-if="!isCollapsed('w:' + (g.worldId || g.label))">
            <div v-for="f in g.list" :key="f.userId" class="rb-friend" @click="openUser(f.userId)">
              <Avatar :image="avatarOf(f)" shape="circle" size="small" :label="avatarLabel(avatarOf(f), f.displayName)" />
              <div class="rf-text">
                <b :style="{ color: trustColor(f.trustLevel) }">{{ nameFor(f) }}</b><i v-if="store.watchlistIds.has(f.userId)" class="pi pi-eye rb-watch" title="关注名单"></i>
                <small><span class="rf-dot" :style="friendDotStyle(f)"></span>{{ statusText(f) }}<i v-if="platformIcon(f.platform)" class="pi rf-plat" :class="platformIcon(f.platform)" :title="platformLabel(f.platform)"></i></small>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>

    <!-- 收藏好友为 0 时整个分组隐藏（用户要求） -->
    <div v-if="favorites.length" class="rb-sec">
      <div class="rb-sec-head"><span>收藏好友</span><span class="rb-cnt">{{ favorites.length }}</span></div>
      <div class="rb-groups">
        <div v-for="f in favorites" :key="f.userId" class="rb-friend" @click="openUser(f.userId)">
          <Avatar :image="avatarOf(f)" shape="circle" size="small" :label="avatarLabel(avatarOf(f), f.displayName)" />
          <div class="rf-text">
            <b :style="{ color: trustColor(f.trustLevel) }">{{ nameFor(f) }}</b><i v-if="store.watchlistIds.has(f.userId)" class="pi pi-eye rb-watch" title="关注名单"></i>
            <small><span class="rf-dot" :style="friendDotStyle(f)"></span>{{ statusText(f) }}<i v-if="platformIcon(f.platform)" class="pi rf-plat" :class="platformIcon(f.platform)" :title="platformLabel(f.platform)"></i></small>
          </div>
        </div>
      </div>
    </div>

    <!-- 最近一起玩：7 天内同屏过的好友（含离线），默认前 8，可展开全部；区头可折叠 -->
    <div v-if="coShown.length" class="rb-sec">
      <div class="rb-sec-head rb-sec-toggle" role="button" tabindex="0" title="点击折叠/展开" @click="coSecOpen = !coSecOpen" @keydown.enter="coSecOpen = !coSecOpen">
        <span>最近一起玩</span><span class="rb-cnt">{{ (store.coPlay || []).length }}</span>
        <i class="pi co-arrow" :class="coSecOpen ? 'pi-chevron-up' : 'pi-chevron-down'"></i>
      </div>
      <div v-if="coSecOpen" class="rb-groups">
        <div v-for="c in coShown" :key="c.userId" class="rb-friend" @click="openUser(c.userId)" role="button" tabindex="0" @keydown.enter="openUser(c.userId)">
          <Avatar :image="coAvatar(c)" shape="circle" size="small" :label="avatarLabel(coAvatar(c), c.displayName)" />
          <div class="rf-text">
            <b>{{ coName(c) }}</b>
            <small class="co-sub">{{ c.matchCount }} 次<span v-if="c.daysCount > 1"> · {{ c.daysCount }} 天</span><span v-if="c.lastDay"> · 最近 {{ c.lastDay }}</span></small>
          </div>
        </div>
        <div v-if="(store.coPlay || []).length > 8" class="co-more" role="button" tabindex="0" @click="coAll = !coAll" @keydown.enter="coAll = !coAll">
          {{ coAll ? '收起' : '展开全部 ' + (store.coPlay || []).length + ' 人' }}
        </div>
      </div>
    </div>

    <div class="rb-sec">
      <div class="rb-sec-head"><span>离线好友</span><span class="rb-cnt">{{ offline.length }}</span></div>
      <div v-if="!offline.length" class="rb-empty">暂无离线好友</div>
      <div v-else class="rb-groups">
        <div v-for="f in offline" :key="f.userId" class="rb-friend" @click="openUser(f.userId)">
          <Avatar :image="avatarOf(f)" shape="circle" size="small" :label="avatarLabel(avatarOf(f), f.displayName)" />
          <div class="rf-text">
            <b :style="{ color: trustColor(f.trustLevel) }">{{ nameFor(f) }}</b><i v-if="store.watchlistIds.has(f.userId)" class="pi pi-eye rb-watch" title="关注名单"></i>
            <small><span class="rf-dot" :style="friendDotStyle(f)"></span>{{ statusText(f) }}<i v-if="platformIcon(f.platform)" class="pi rf-plat" :class="platformIcon(f.platform)" :title="platformLabel(f.platform)"></i></small>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.rb-inner { display: flex; flex-direction: column; height: 100%; overflow-y: auto; padding: 0 10px 14px; }
.rb-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 4px 8px; font-weight: 700; font-size: 13px; }
.rb-num { font-size: 11px; color: var(--text-dim); background: var(--surface-3); padding: 1px 7px; border-radius: 10px; }
.me-item {
  padding: 8px;
  margin-bottom: 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-2);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.me-top { display: flex; align-items: center; gap: 9px; cursor: pointer; }
.me-top:hover .me-text b { color: var(--accent); }
.me-text { min-width: 0; flex: 1; }
.me-text b { display: block; font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.me-text small { display: flex; align-items: center; gap: 4px; color: var(--text-dim); font-size: 10.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.me-model { opacity: 0.85; }
.me-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; transform: translateY(1px); }

/* 状态快速设置 */
.me-preset { border-top: 1px dashed var(--border); padding-top: 7px; display: flex; flex-direction: column; gap: 6px; }
.mp-btns { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; }
.mp-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  font-size: 10.5px;
  padding: 4px 1px;
  white-space: nowrap;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--surface-3);
  color: var(--text-dim);
  cursor: pointer;
  font-family: inherit;
  transition: all 0.12s;
}
.mp-btn:hover { border-color: var(--accent); color: var(--text); }
.mp-btn.active { border-color: var(--accent); color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); }
.mp-btn.selected { border-color: var(--accent); color: var(--text); background: color-mix(in srgb, var(--accent) 22%, transparent); box-shadow: 0 0 0 1px var(--accent) inset; }
.mp-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.mp-confirm { display: flex; align-items: center; gap: 6px; padding: 5px 8px; border-radius: 6px; background: color-mix(in srgb, var(--accent) 10%, transparent); border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent); }
.mp-confirm-txt { font-size: 11px; color: var(--text); flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mp-ok { flex: none; display: inline-flex; align-items: center; gap: 4px; font-size: 11px; padding: 3px 10px; border-radius: 5px; border: none; background: var(--accent); color: #fff; cursor: pointer; font-family: inherit; }
.mp-ok:disabled, .mp-cancel:disabled { opacity: 0.5; cursor: not-allowed; }
.mp-cancel { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 5px; border: 1px solid var(--border); background: transparent; color: var(--text-dim); cursor: pointer; font-size: 11px; }
.mp-cancel:hover { color: var(--text); border-color: var(--accent); }
.mp-error { display: block; font-size: 10.5px; color: #f87171; padding: 3px 4px 0; }
.mp-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.mp-row { display: flex; align-items: center; gap: 6px; }
.mp-input {
  flex: 1;
  min-width: 0;
  background: var(--surface-3);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 4px 8px;
  color: var(--text);
  font-size: 11px;
  outline: none;
  font-family: inherit;
  transition: border-color 0.12s;
}
.mp-input:focus { border-color: var(--accent); }
.rb-search {
  width: 100%;
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 0 10px;
  height: 32px;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.rb-search:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 22%, transparent);
}
.rb-search > .pi-search { font-size: 11px; color: var(--text-dim); flex: none; }
.rs-clear { font-size: 10px; color: var(--text-dim); cursor: pointer; padding: 2px; flex: none; }
.rs-clear:hover { color: var(--text); }
.rb-sec { margin-top: 10px; }
.rb-sec-head { display: flex; justify-content: space-between; align-items: center; font-size: 11px; font-weight: 700; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.4px; padding: 2px 2px 6px; }
.rb-cnt { font-size: 10px; background: var(--surface-3); padding: 0 6px; border-radius: 8px; }
/* 最近一起玩：区头可折叠 + 展开更多 */
.rb-sec-toggle { cursor: pointer; user-select: none; border-radius: 6px; }
.rb-sec-toggle:hover span:first-child { color: var(--text); }
.co-arrow { font-size: 9px; opacity: 0.7; margin-left: auto; }
.co-sub { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.co-more { font-size: 10.5px; color: var(--accent); text-align: center; padding: 4px 0 2px; cursor: pointer; user-select: none; }
.co-more:hover { text-decoration: underline; }
.rb-empty { color: var(--text-dim); font-size: 11px; padding: 6px 4px; }
.rb-groups { display: flex; flex-direction: column; gap: 6px; }
.wg { border: 1px solid var(--border-soft); border-radius: 8px; overflow: hidden; }
.wg.accent { border-color: var(--accent); }
.wg-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10.5px;
  font-weight: 600;
  padding: 5px 8px;
  background: var(--surface-2);
  color: var(--text-dim);
  cursor: pointer;
  user-select: none;
  transition: background 0.1s, color 0.1s;
}
.wg-head:hover { background: var(--surface-3); color: var(--text); }
.wg-arrow { flex: none; font-size: 9px; opacity: 0.7; transition: transform 0.12s; }
.wg-thumb {
  width: 16px;
  height: 16px;
  object-fit: cover;
  border-radius: 4px;
  flex: none;
}
.wg.accent .wg-head { background: color-mix(in srgb, var(--accent) 14%, var(--surface-2)); color: var(--text); }
.wg-head span:nth-child(2) { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wg-loc {
  font-size: 9.5px;
  color: var(--text-dim);
  background: var(--surface-3);
  border: 1px solid var(--border);
  padding: 0 5px;
  border-radius: 8px;
  flex: 0 1 auto;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 42%;
  min-width: 0;
}
.wg-num { font-size: 10px; flex: none; }
.rb-friend {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  cursor: pointer;
  border-radius: 6px;
  transition: background 0.1s;
}
.rb-friend:hover { background: var(--surface-3); }
.rb-friend .p-avatar { flex: none; }
.rf-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; transform: translateY(1px); }
.rf-text { min-width: 0; flex: 1; }
.rf-text b { display: block; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rf-text small { display: flex; align-items: center; gap: 4px; color: var(--text-dim); font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rf-plat {
  flex: none;
  font-size: 10px;
  color: var(--text-dim);
  line-height: 1;
  cursor: help;
}
.rf-plat:hover { color: var(--text); }
/* C1/C2：移动端触屏目标加大 + 字号提升（好友抽屉） */
@media (max-width: 899px) {
  /* 我卡片 + 状态设置：2×2 大按钮，描述框加高 */
  .mp-btns { grid-template-columns: repeat(2, 1fr); gap: 6px; }
  .mp-btn { padding: 9px 4px; font-size: 11.5px; border-radius: 8px; }
  .mp-input { padding: 8px 10px; font-size: 12.5px; }
  .me-text b { font-size: 13px; }
  .me-item { padding: 10px; }
  .mp-row .p-button { width: 34px; height: 34px; }
  .wg-head { padding: 8px; }
  .wg-head span:nth-child(2) { font-size: 11px; }
  .rb-friend { padding: 8px 9px; }
  .rb-friend b { font-size: 12.5px; }
  .rf-text small { font-size: 10.5px; }
  /* 搜索框全端统一 36px（桌面+移动一致，不再分裂） */
}
</style>
