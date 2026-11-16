// 工具函数（移植自旧 util.js，VRCX 对齐的标准值）
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 统一时间解析：后端 SQLite 的 datetime('now') 产出无时区 UTC 串 "YYYY-MM-DD HH:MM:SS"，
// 直接 new Date() 会被当成浏览器本地时间（UTC+8 设备偏移 8 小时，实测 tracked 列表"最近变化 8 小时前"）。
// 凡无时区标记的 SQLite 格式一律补 'Z' 按 UTC 解析；空格+Z 形态（YYYY-MM-DD HH:MM:SSZ）也按 UTC；
// ISO（带 Z/T/时区偏移）与数字时间戳原样交给 Date。
const SQLITE_UTC_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?Z?$/;
export function parseTs(s) {
  if (s === null || s === undefined || s === '') return new Date(NaN);
  if (typeof s === 'number') return new Date(s);
  const str = String(s);
  const norm = SQLITE_UTC_RE.test(str) ? str.replace(' ', 'T').replace(/Z$/, '') + 'Z' : str;
  return new Date(norm);
}

export const time = (s) => (s ? parseTs(s).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '--:--');
export const date = (s) => (s ? parseTs(s).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) : '--/--');
// 相对时间："X 分钟前 / X 小时前 / X 天前 / 日期"
export function reltime(ts) {
  if (!ts) return '';
  const t = parseTs(ts).getTime();
  if (!Number.isFinite(t)) return '';
  const diff = Date.now() - t;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
  if (diff < 7 * 86400000) return Math.floor(diff / 86400000) + ' 天前';
  return date(ts);
}
// VRCX 风格完整日期时间：YYYY/MM/DD HH:MM:SS
export function dateTime(s) {
  if (!s) return '—';
  const d = parseTs(s);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function worldLabel(x) {
  const v = String(x.worldName || x.worldId || '').toLowerCase();
  const special = { private: '私人房间', offline: '离线', traveling: '传送中', local: '本地房间' };
  if (special[v]) return special[v];
  if (x.worldName) return x.worldName;
  if (String(x.worldId || '').startsWith('wrld_')) return '未知世界';
  return x.worldId || '未公开位置';
}

/** 特殊位置的中文名（不是"世界:实例"格式的那些值）：private→私人房间 / offline→离线 / traveling→传送中 / local→本地房间。
 * 用途：位置行在拿不到世界名时的兜底标签（用户 2026-09-22 定：拿不到世界名就写"私人房间"）。 */
export function specialLocationLabel(loc) {
  const v = String(loc || "").toLowerCase();
  // 纯特殊值直接给中文名（本地图 / 离线 / 传送）
  const direct = {
    private: "私人房间",  // 纯值形态（1fdce1f 那天覆盖的情况，不能丢）
    offline: "离线", "offline:offline": "网页在线", traveling: "传送中",
    local: "本地房间", friends: "好友房间", group: "群组房间",
  }[v];
  if (direct) return direct;
  // 2026-09-24 用户定：拿不到信息的那种私人实例显示「私人房间」（能获取到的照常显示）
  // 两条判据【并存】：①纯值形态（private / offline / traveling…）由上面的 direct 映射覆盖——
  // 1fdce1f 那天修的就是它，不能删；②带 worldId 的实例串（wrld_xxx:12345~private(usr_xxx)）由下面 parseLoc 覆盖
  // 判据必须走 parseLoc —— 真实位置形如 wrld_xxx:12345~private(usr_xxx)，整串相等永远不命中
  // 且**统一走 isPrivateInstance()**：它只认 private / invite+（parseLoc 从不产出 invite）——
  // 这里原本内联的那份判据里 'invite' 恒假，属同类死判据（2026-10-18 复审 nixi 💡1 指出，已收敛）
  if (isPrivateInstance(v)) return "私人房间";
  return "";
}

/** 仅邀请 / 私人实例的**唯一判据入口**（位置行左右两端共用，别再各写一份）。
 *  ⚠️ 只管这两个类型：`parseLoc` 对真实位置串只会产出 `private`（`~private(usr)`）或 `invite+`（再带 `~canRequestInvite`）——
 *  **不会产出 `invite`**，所以写 p.type === 'invite' 是恒假死判据（2026-10-18 复审 💡1 指出）。
 *  纯值 `private` 走 specialLocationLabel 的 direct 映射，不进这里。 */
export function isPrivateInstance(loc) {
  const p = parseLoc(loc || '');
  return !!(p && (p.type === 'private' || p.type === 'invite+'));
}

/** 位置行左端「从哪来」的**兜底标签**（用户 2026-10-17 定）：只认**紧邻的上一个位置**。
 *  私人/仅邀请实例给「私人房间」这件事由 `specialLocationLabel()` 负责（它已覆盖 private / invite+），
 *  本函数**不再重复一套判据**（2026-10-18 复审 💡1：原来那段 parseLoc 判断因第一分支必然先命中而不可达）。
 *  抽成纯函数是为了能被 test/location-labels-pure.test.mjs 直接断言（源码正则钉不住行为）。 */
export function prevLocationLabel(previousLocation, previousWorldName) {
  // 私人实例优先于世界名：这是用户 2026-10-17 的定案「上次是私人房间就私人房间」；
  // 模板侧必须与这里一致（先把私人房渲染成「私人房间」，再考虑 worldId → 世界名）。
  return specialLocationLabel(previousLocation) || previousWorldName || '';
}

export function parseLoc(loc) {
  if (!loc) return null;
  // 特殊值：offline / offline:offline / traveling 表示离线/传送状态，不是"世界:实例"格式，
  // 不能被误解析成 worldId='offline' + type='public'（否则显示成 "Public · offline"）
  if (loc === 'offline' || loc === 'offline:offline' || loc === 'traveling') {
    return { worldId: loc, instanceId: null, type: null, ownerId: null, region: null, raw: loc };
  }
  const r = { worldId: null, instanceId: null, type: null, ownerId: null, region: null };
  const sep = loc.indexOf(':');
  r.worldId = sep >= 0 ? loc.slice(0, sep) : loc;
  const rest = sep >= 0 ? loc.slice(sep + 1) : '';
  const im = rest.match(/^([^~]+)/);
  if (im) r.instanceId = im[1];
  const tm = rest.match(/~((?:friends\+|private|hidden|friends|group|public))\(([^)]+)\)/);
  if (tm) {
    r.type = tm[1];
    r.ownerId = tm[2];
    // Luo locationParser 权威语义：private(usr) 基础上带 ~canRequestInvite = invite+（邀请+）
    if (r.type === 'private' && /~canRequestInvite\b/.test(rest)) r.type = 'invite+';
  } else if (/~local\b/.test(rest)) { r.type = 'local'; } else if (im) { r.type = 'public'; }
  const rm = rest.match(/~region\(([^)]+)\)/);
  if (rm) r.region = rm[1];
  return r;
}

export function locLabel(loc) {
  const p = parseLoc(loc);
  if (!p) return '';
  const t = p.type ? instanceLabel(p.type) : '';
  const parts = [t, p.region ? p.region.toUpperCase() : ''].filter(Boolean);
  return parts.join(' · ');
}

// 实例标签 + 房间号（如 "Private · JP · 69002"）
export function locLabelFull(loc) {
  const p = parseLoc(loc);
  if (!p) return '';
  const t = p.type ? instanceLabel(p.type) : '';
  const parts = [t, p.region ? p.region.toUpperCase() : '', p.instanceId || ''].filter(Boolean);
  return parts.join(' · ');
}

// 实例类型标签（用户定稿：顺序 公开>好友+>仅限好友>邀请+>仅限邀请>群组房间）
export function instanceLabel(t) {
  // VRChat 实例权限类型（VRCX-Luo locationParser 权威语义，2026-08-30 实测纠正）：
  // ~hidden(usr) = friends+ 好友+；~friends(usr) = friends 仅限好友；
  // ~private(usr) = invite 仅限邀请；~private(usr)~canRequestInvite = invite+ 邀请+；
  // ~group(grp)~groupAccessType(x) = 群组房间；无 token = public 公开
  const m = {
    public: '公开',
    hidden: '好友+',
    'friends+': '好友+',
    friends: '仅限好友',
    'invite+': '邀请+',
    invite: '仅限邀请',
    private: '仅限邀请',
    group: '群组房间',
    local: '本地',
  };
  return m[t] || t || '';
}

// PrimeVue Avatar 的渲染优先级是 label > icon > image：传了 label 就不会渲染图片。
// 所以 label（首字母兜底）只在没有头像 URL 时传入。
export function avatarLabel(url, name) {
  return url ? undefined : String(name || '?').charAt(0).toUpperCase();
}

export function statusCls(s) {
  const v = String(s || '').toLowerCase().replace(/[^a-z]/g, '');
  if (v.includes('web')) return 's-web';
  if (v.includes('joinme')) return 's-joinme';
  if (v.includes('askme')) return 's-askme';
  if (v.includes('busy')) return 's-busy';
  if (v.includes('active')) return 's-active';
  if (v.includes('offline')) return 's-offline';
  return '';
}

export function isWebOnline(x) {
  if (!x.isOnline) return false;
  const p = String(x.platform || '').toLowerCase();
  if (p.includes('web')) return true;
  // 兜底判据：在线但**不在任何真实世界里** ⇒ 网页/移动端在线（VRChat 网页端不在世界）
  //
  // 2026-11-17 修：原实现只认 'offline' / 'offline:offline'，漏掉两种真实形态 ——
  //   ① location 为空串（本地缓存 hydrate 出来的旧数据、或后端字段缺失）
  //   ② location 为 'traveling'（不是 'traveling:xxx'）
  // 漏判的后果：这些人既不进「网页端在线」组，也没有 worldId ⇒ 掉进 'none' 组，
  // 显示成一个凭空发明的标签（原为「未公开位置」）。参照 VRCX 的 isRealInstance 判据：
  // 只有 location 是真实世界（wrld_ 前缀）时才算在游戏里。
  const loc = String(x.location || '');
  // 正在传送 = 在游戏里（traveling:wrld_xxx 是传送到某世界的过程）
  if (loc.startsWith('traveling:')) return false;
  // 空 / offline / offline:offline ⇒ 不在世界
  if (!loc || loc === 'offline' || loc === 'offline:offline' || loc === 'traveling') {
    // 但若平台字段明确写着是游戏客户端（standalone/安卓/iOS），说明人在游戏里、
    // 只是位置字段丢了（陈旧缓存）⇒ 不能判成网页在线，否则会把「在游戏中」的人
    // 错误地归到网页在线组。此时按「位置未知」处理。
    if (/standalonewindows|standalone|android|ios/.test(p)) return false;
    return true;
  }
  // private / private:private = 在私密房间里，属于游戏内（VRCX 的 isRealInstance 同样排除这两值）
  if (loc === 'private' || loc === 'private:private') return false;
  // 其余：以 wrld_ 开头 = 真在游戏世界；否则（local 测试房等）也算网页端在线
  return !loc.startsWith('wrld_');
}

// 平台标签（VRChat platform：standalonewindows=PC桌面+VR / web=网页 / android=安卓 / ios=iOS）
export function platformLabel(p) {
  const v = String(p || '').toLowerCase();
  if (!v) return '';
  if (v.includes('web')) return '网页';
  if (v.includes('android')) return '安卓';
  if (v.includes('ios')) return 'iOS';
  if (v.includes('standalone')) return 'PC';
  return v;
}
// 平台图标（PrimeIcons，已随构建内联）：PC/网页/安卓/iOS 各对应一个，title 显示文字
export function platformIcon(p) {
  const v = String(p || '').toLowerCase();
  if (v.includes('web')) return 'pi-globe';
  if (v.includes('android')) return 'pi-android';
  if (v.includes('ios')) return 'pi-apple';
  if (v.includes('standalone')) return 'pi-desktop';
  return '';
}

// ── 信用等级（对齐 VRCX，已核对 VRCX-Luo 源码 stores/settings/appearance.js TRUST_COLOR_DEFAULTS）──
// VRChat tag 与等级名语义反直觉：system_trust_veteran=Trusted User(紫)、system_trust_trusted=Known User(橙)
export const TRUST_COLORS = {
  visitor: '#CCCCCC',
  basic: '#1778FF',     // New User 蓝
  known: '#2BCF5C',     // User 绿
  trusted: '#FF7B42',   // Known User 橙
  veteran: '#B18FFF',   // Trusted User 紫
  vip: '#FF2626',       // 团队/管理员 红
  troll: '#782F2F',     // 劣迹玩家 暗红
};
export function trustColor(t) {
  const s = String(t || '').toLowerCase();
  if (!s) return '';
  if (s.includes('troll')) return TRUST_COLORS.troll;
  if (s.includes('team') || s.includes('moderator') || s.includes('vip') || s.includes('admin')) return TRUST_COLORS.vip;
  if (s.includes('veteran') || s.includes('trusted')) return TRUST_COLORS.veteran;   // Trusted User
  if (s.includes('known')) return TRUST_COLORS.trusted;                               // Known User
  if (s.includes('new') || s.includes('basic')) return TRUST_COLORS.basic;            // New User
  if (s.includes('user')) return TRUST_COLORS.known;                                  // User
  return TRUST_COLORS.visitor;                                                        // Visitor/未知
}

// 等级名标准化为 VRCX 英文名（tags / 旧推断值 Visitor·New·User·Known·Trusted·Veteran → 规范名）
export const TRUST_TAG_NAMES = {
  veteran: 'Trusted User',
  legend: 'Trusted User',   // #222 审核 💡4：与 DB 侧写入值对齐（否则弹窗会显示原样 'legend'）
  trusted: 'Known User',
  known: 'User',
  basic: 'New User',
  new: 'New User',
  user: 'User',
  visitor: 'Visitor',
};
export function trustName(t) {
  let s = String(t || '').trim();
  if (!s) return '';
  const m = s.match(/^system_trust_(\w+)$/);
  if (m) s = m[1];
  if (/^[a-z_]+$/i.test(s)) {
    const key = s.toLowerCase();
    if (TRUST_TAG_NAMES[key]) return TRUST_TAG_NAMES[key];
    if (TRUST_TAG_NAMES[s.toLowerCase().replace(/_/g, '')]) return TRUST_TAG_NAMES[s.toLowerCase().replace(/_/g, '')];
  }
  return s;
}

export function fmtMin(m) {
  if (!m && m !== 0) return '';
  m = Math.round(m);
  if (m < 60) return m + ' 分钟';
  const h = Math.floor(m / 60), r = m % 60;
  return r ? h + ' 小时 ' + r + ' 分钟' : h + ' 小时';
}

// 状态中文标签
export const statusLabels = { active: '在线', 'join me': '欢迎加入', 'ask me': '忙碌', busy: '请勿打扰', offline: '离线' };

// 事件类型中文
export const eventTypeLabels = {
  'friend-online': '上线',
  'friend-offline': '离线',
  'friend-location': '位置',
  'friend-active': '状态',
  'friend-update': '资料',
  'friend-update-avatar': '模型',
  'friend-update-bio': '简介',
  'friend-update-status': '状态',
  'user-location': '我',
};

// 通知类型中文（VRCX 对齐）
export const notificationTypeLabels = {
  friendRequest: '好友请求',
  invite: '房间邀请',
  requestInvite: '请求加入',
  requestInviteResponse: '加入响应',
  friendRequestResponse: '好友响应',
  giftSub: '订阅礼物',
  votetokick: '投票踢人',
  groupInvite: '群组邀请',
  groupJoinRequest: '群组加入请求',
  groupAnnouncement: '群公告',
  'group.event.started': '群活动开始',
  'group.event.ended': '群活动结束',
  'group.event.scheduled': '群活动计划',
  moderationWarning: '警告',
  message: '消息',
  boop: '戳一戳',
  'twitchdrop.fulfilled': 'Twitch 掉宝到账',
  'group.event.created': '群活动创建',
};
