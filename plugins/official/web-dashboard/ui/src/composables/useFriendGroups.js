// composables/useFriendGroups.js — RightBar 与 FriendsView 共享的好友分组/状态逻辑（C5 去重）
// 曾因两份独立实现导致"两边不一致"被用户抓到；状态色/签名/分组/折叠统一在此。
import { computed, ref } from 'vue';
import { store } from '../store.js';
import { isWebOnline, locLabel, locLabelFull, statusLabels } from '../utils.js';

export const STATUS_COLORS = { active: '#52c41a', 'join me': '#4287f5', 'ask me': '#fa8c16', busy: '#f5222d', offline: '#596778' };
export function statusColor(s) { return STATUS_COLORS[s] || '#596778'; }
// 状态点：离线=空心描边 / 在线（含网页在线）=实际在线状态色（用户定稿）
export function friendDotStyle(f) {
  if (!f.isOnline) return { background: 'transparent', border: '1px solid #4a4f5a' };
  const c = STATUS_COLORS[f.status] || '#2bcf5c';
  return { background: c, border: '1px solid ' + c };
}

export function useFriendGroups() {
  // 分组折叠（默认展开，点分组头折叠）
  const collapsed = ref(new Set());
  function toggleGroup(key) {
    const s = new Set(collapsed.value);
    if (s.has(key)) s.delete(key); else s.add(key);
    collapsed.value = s;
  }
  function isCollapsed(key) { return collapsed.value.has(key); }

  // 同实例好友：自己位置相同的在线好友（list 由调用方决定来源——右侧栏排除收藏、好友页含收藏）
  function sameInstanceOf(list) {
    const me = store.me;
    if (!me || !me.location) return [];
    const myLoc = me.location;
    if (myLoc === 'offline' || myLoc === 'traveling' || !myLoc.includes(':')) return [];
    return (list || []).filter((f) => f.location === myLoc);
  }

  // 我当前所在世界 ID（location 首段 wrld_xxx），不在世界中返回空串
  function myWorldId() {
    const loc = store.me && store.me.location;
    if (!loc || loc === 'offline' || loc === 'traveling' || !loc.includes(':')) return '';
    const wid = loc.split(':')[0];
    return wid.startsWith('wrld_') ? wid : '';
  }

  // 同世界好友：与我同一世界但不同实例的在线好友（排除同实例与网页在线；收藏去重同同实例约定——由调用方的入参决定）
  function sameWorldOf(list) {
    const wid = myWorldId();
    if (!wid) return [];
    const myLoc = store.me.location;
    const si = new Set(sameInstanceOf(list).map((f) => f.userId));
    return (list || []).filter((f) => f.worldId === wid && f.location !== myLoc && !si.has(f.userId) && !isWebOnline(f));
  }

  // 世界分组：按 worldId 分组 + 网页端在线独立组（签名优先规则在 statusText）
  // 同实例 / 同世界好友不进世界分组（各自有专属分组区，避免同一人出现两处）
  function groupByWorld(list) {
    const si = new Set(sameInstanceOf(list).map((f) => f.userId));
    const sw = new Set(sameWorldOf(list).map((f) => f.userId));
    const web = (list || []).filter((f) => !si.has(f.userId) && !sw.has(f.userId) && isWebOnline(f));
    const inGame = (list || []).filter((f) => !si.has(f.userId) && !sw.has(f.userId) && !isWebOnline(f));
    const m = new Map();
    for (const f of inGame) {
      const k = f.worldId || 'none';
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(f);
    }
    const gs = [...m.entries()].map(([wid, l]) => ({
      label: (l[0].worldName && l[0].worldName !== wid) ? l[0].worldName : '未公开位置',
      list: l,
      worldId: wid,
      loc: (l[0].worldName && l[0].worldName !== wid) ? locLabelFull(l[0].location) : '',
    }));
    if (web.length) gs.push({ label: '网页端在线', list: web });
    return gs;
  }

  // 好友行文案：签名优先（离线有签名也显示签名，用户定稿）；网页在线归"网页端在线"组
  function statusText(f) {
    if (isWebOnline(f)) return f.statusDescription || '网页在线';
    if (f.statusDescription) return f.statusDescription;
    if (!f.isOnline) return '离线';
    return statusLabels[f.status] || '在线';
  }
  function locText(f) {
    if (isWebOnline(f) || !f.isOnline) return '';
    return locLabel(f.location) || '';
  }
  function avatarOf(f) { return f.avatarUrl || f.userIcon || ''; }
  function groupIcon(g) {
    const f = g.list && g.list[0];
    return (f && f.worldImageUrl) ? f.worldImageUrl : '';
  }
  function nameFor(f) { return store.nicknameMap[f.userId] || f.displayName || '?'; }

  return { collapsed, toggleGroup, isCollapsed, sameInstanceOf, sameWorldOf, myWorldId, groupByWorld, statusText, locText, avatarOf, groupIcon, nameFor };
}
