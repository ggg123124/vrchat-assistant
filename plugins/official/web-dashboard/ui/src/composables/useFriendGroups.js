// composables/useFriendGroups.js — RightBar 与 FriendsView 共享的好友分组/状态逻辑（C5 去重）
// 曾因两份独立实现导致"两边不一致"被用户抓到；状态色/签名/分组/折叠统一在此。
import { computed, ref } from 'vue';
import { store } from '../store.js';
import { isWebOnline, locLabel, locLabelFull, statusLabels, specialLocationLabel, parseLoc } from '../utils.js';

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

  // 实例键（location 里 `worldId:` 之后整段，含 ~region/~hidden 等修饰）——判断「是否同一房间」
  // 实例键（房间号 + 修饰段）—— 判断「是否同一房间」。
  // 2026-11-17（复审 EMeowAGENT 💡）：改用 parseLoc 而不是「第一个冒号之后整段」。
  // 原实现把 traveling:wrld_abc:1 的房间键算成 'wrld_abc:1'，而 locLabelFull 已按 '1' 渲染 ⇒
  // 同组内「传送中的同一实例」与「已到达的同一实例」被算成两间房，误显示「（N 房间）」。
  function instanceKeyOf(f) {
    const raw = String((f && f.location) || '');
    const p = parseLoc(raw);
    if (!p || !p.instanceId) return '';
    // 保留修饰段（~region/~hidden 等）：同号不同 region 是不同实例，不能合并
    const i = raw.indexOf(':');
    const rest = i > 0 ? raw.slice(i + 1) : '';
    const tilde = rest.indexOf('~');
    return p.instanceId + (tilde >= 0 ? rest.slice(tilde) : '');
  }
  // 房间标签（如「好友+ · JP · 41317」）——世界分组内每张卡片用它标明自己所在的房间
  function roomLabelOf(f) {
    const loc = (f && f.location) || '';
    return loc && loc !== 'offline' && loc !== 'traveling' ? locLabelFull(loc) : '';
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
    const gs = [...m.entries()].map(([wid, l]) => {
      // 世界名：组内**任一人**有名字就用（2026-11-17 修）——
      // 原实现只看 l[0]，同一世界里只要排在第一的那个人 worldName 为空（缓存尚未回填），
      // 整组就掉 fallback，即使组内其他人明明有名字。
      const namedOne = l.find((f) => f.worldName && f.worldName !== wid);
      // 真实世界 ID：必须是 wrld_ 前缀（复审 EMeowAGENT ⚠️1）——
      // 原判据只排除 'none' / 'private'，于是 traveling / offline / local 这类**特殊纯值**
      // 会被当成世界 ID 直接上屏（实测标题出现英文裸值 "traveling" / "offline"）。
      const isRealWorld = String(wid || '').startsWith('wrld_');
      // 组标题（参照 VRCX 的 getLocationText：有真实 worldId 就显示它，绝不发明「未知」标签）：
      //   ① 有名字             → 世界名
      //   ② 真实 worldId 无名字 → 直接显示 worldId（准确、可复制去查，VRCX 同做法）
      //   ③ private            → 私密实例（VRChat 不公开房间号，无从得知）
      //   ④ 其余特殊纯值        → 复用 specialLocationLabel（传送中 / 离线 / 本地房间…），
      //                          不另造第三套标签表（复审 EMeowAGENT ⚠️1）
      //   ⑤ wid === 'none'     → 「位置未知」。
      //      ⚠️ 不能写「网页端在线」（复审 Lian-Hu 🔴1 / EMeowAGENT 🔴1）：
      //      落进这个桶的是「游戏端在线但 location 字段丢了」的人，而 isWebOnline 对他们返回 false
      //      （那是本 PR 自己新增的判据）⇒ 两处打架，且会与真正的网页在线组**撞成两个同名分组**。
      let fallback;
      if (wid === 'private') fallback = '私密实例';
      else if (isRealWorld) fallback = wid;
      //   ⑤ wid 是 offline / offline:offline → 「位置未知」，**不能**走 specialLocationLabel（'离线'）。
      //      落进这个桶的人 isOnline=true、platform 是游戏客户端、只是位置字段丢了（刚登录/在菜单），
      //      行文案会写「在线」而组标题写「离线」= 自相矛盾（复审 EMeowAGENT ⚠️2 独立探针复现）。
      //      'offline:offline' 更糟：会落进 else 分支变成「位置未知」，但若无此判断则会与真网页组并列。
      else if (wid === 'offline' || wid === 'offline:offline') fallback = '位置未知';
      else if (wid && wid !== 'none') fallback = specialLocationLabel(wid) || '位置未知';
      else fallback = '位置未知';
      // 房间维度（2026-09-15）：同一世界的不同实例此前会被当成一个组、组标题只有世界名，
      // 用户看到两人像在一起、实际不在同一房间（实测实例号 41317 vs 03806）。这里补出房间数，
      // 由视图在组头标注「N 个房间」、并在成员卡片上显示各自房间标签。
      const roomKeys = new Set(l.map((f) => instanceKeyOf(f)).filter(Boolean));
      // 位置标签（房间号 · 实例类型 · 区域）：只要有真实 worldId 就展示，
      // 与「有没有世界名」解耦 —— 名字查不到不代表位置信息拿不到。
      // 取源也解耦（复审 EMeowAGENT 💡1）：**优先组内 location 是真实实例串的人**，
      // 原实现取 namedOne 或 l[0]，若那个人 location 是过期 offline，realLoc 仍为空、
      // 即使别人带完整实例串 —— 与「名字查不到 ≠ 位置拿不到」的初衷不符。
      const locSource = l.find((f) => {
        const loc = String(f.location || '');
        return loc.startsWith('wrld_');
      }) || namedOne || l[0];
      const realLoc = isRealWorld && locSource && locSource.location ? locLabelFull(locSource.location) : '';
      return {
        label: namedOne ? namedOne.worldName : fallback,
        list: l,
        worldId: wid,
        loc: realLoc,
        roomCount: roomKeys.size,
        mixedRooms: roomKeys.size > 1,
        // 供组头提示「世界名待补」——真实世界但没人知道名字（视图已接入，见 RightBar）
        nameUnavailable: !namedOne && isRealWorld,
      };
    });
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
  function avatarOf(f) { return f.userIcon || f.avatarUrl || ''; }
  function groupIcon(g) {
    const f = g.list && g.list[0];
    return (f && f.worldImageUrl) ? f.worldImageUrl : '';
  }
  function nameFor(f) { return store.nicknameMap[f.userId] || f.displayName || '?'; }

  return { collapsed, toggleGroup, isCollapsed, sameInstanceOf, sameWorldOf, myWorldId, groupByWorld, statusText, locText, avatarOf, groupIcon, nameFor, instanceKeyOf, roomLabelOf };
}
