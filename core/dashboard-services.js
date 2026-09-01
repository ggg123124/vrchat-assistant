/**
 * Dashboard 核心数据服务注册（dashboard.* 服务，owner='core'）
 *
 * 2026-08-30 架构债重构：从 start-monitor.js 的 registerCoreServices 中抽出。
 * 这些服务由 web-dashboard 插件经 api.consume('dashboard.*') 消费；实现需要
 * 直读核心表（events/friends/world_cache/planet_cache）+ 限流 API 调用，
 * 因此保留在 core 侧（插件契约禁止触碰 ctx 与核心表），仅把注册代码移出主入口，
 * 让 start-monitor.js 恢复"薄入口"定位。
 *
 * 纯搬移重构：服务名、owner、实现逐字节一致，无行为变更。
 */
import { isSafeModeEnabled } from './safe-mode.js';

// 把 VRChat CDN 图片 URL 改写成本地图片代理（浏览器经服务端缓存拉取，避免国内直连 CDN 被墙/慢）
const imgProxy = (u) => {
  if (!u) return u;
  if (!/^https:\/\/(api\.vrchat\.cloud|d348imysud55la\.cloudfront\.net|assets\.vrchat\.com|files\.vrchat\.cloud)\//.test(String(u))) return u;
  return '/api/dashboard/image-proxy?url=' + encodeURIComponent(u);
};

// 自己 userId 的权威推导：user-location/user-update 事件只会是自己的（事件管线保证），
// 种子导入/列表展示用它排除自己（/auth/user 在启动早期可能失败或缓存未就绪）
export function getSelfUserId(storage) {
  try {
    const row = storage.query(
      `SELECT user_id FROM events WHERE type IN ('user-location', 'user-update') AND user_id LIKE 'usr_%' LIMIT 1`);
    return (row[0] && row[0].user_id) || '';
  } catch { return ''; }
}

export function registerDashboardServices(loader, ctx) {
  // Dashboard 只通过只读服务取数，插件不直接触碰核心 ctx 或数据库文件。
  loader.services.set('dashboard.snapshot', () => ({
    auth: ctx.serverState.authUser && !ctx.serverState.needsTotp
      ? { authenticated: true, user: ctx.serverState.authUser }
      : { authenticated: false, needsOtp: ctx.serverState.needsOtp, needsTotp: ctx.serverState.needsTotp },
    ws: ctx.wsManager?.getState() || null,
    friendState: ctx.friendState?.getStats() || null,
    db: ctx.storage?.getStats() || null,
    plugins: ctx.pluginLoader?.getStatus() || [],
    safeMode: isSafeModeEnabled(),   // 安全模式指示（页脚 🔒 徽标；破坏性操作被拦截时用户可见原因）
    uptime: ctx.serverState.started ? Math.floor((Date.now() - new Date(ctx.serverState.started).getTime()) / 1000) : 0,
  }));
  loader.serviceOwners.set('dashboard.snapshot', 'core');
  function getDashboardFriend(userId) {
    if (!userId) return null;
    return ctx.storage.query(`SELECT display_name AS displayName,
      avatar_image_url AS avatarUrl, user_icon AS userIcon
      FROM friends WHERE user_id = $userId LIMIT 1`, { $userId: userId })[0] || null;
  }
  // Dashboard SSE 事件总线：核心事件落库后广播轻量 DTO，插件经 api.consume('dashboard.bus') 订阅
  const dashboardBus = {
    _subs: new Set(),
    subscribe(fn) { this._subs.add(fn); return () => this._subs.delete(fn); },
    emit(dto) { for (const fn of [...this._subs]) { try { fn(dto); } catch {} } },
    count() { return this._subs.size; },
  };
  loader.services.set('dashboard.bus', () => dashboardBus);
  loader.serviceOwners.set('dashboard.bus', 'core');
  ctx.dashboardBus = dashboardBus;
  if (ctx.eventPipeline) {
    ctx.eventPipeline.onStoredEvent = (dto) => dashboardBus.emit(dto);
  }
  loader.services.set('dashboard.friends', ({ limit = 100 } = {}) => {
    const rows = ctx.storage.query(`SELECT f.user_id AS userId, f.display_name AS displayName, f.is_online AS isOnline,
      f.location, f.world_id AS worldId, COALESCE(NULLIF(f.world_name,''), wc.name, '') AS worldName, wc.image_url AS worldImageUrl,
      f.platform, f.status, f.status_description AS statusDescription, f.bio, f.pronouns,
      f.trust_level AS trustLevel, f.memo, f.avatar_image_url AS avatarUrl, f.user_icon AS userIcon,
      f.last_seen AS lastSeen, f.last_online AS lastOnline, f.last_offline AS lastOffline
      FROM friends f LEFT JOIN world_cache wc ON wc.world_id = f.world_id
      ORDER BY f.is_online DESC, f.display_name COLLATE NOCASE LIMIT $limit`,
    { $limit: Math.min(Math.max(Number(limit) || 100, 1), 200) });
    // 后台预热：在线好友所在世界缺缓存时拉取填充 world_cache（限流+10s 超时，不阻塞响应；
    // 填充后下次请求 worldName/worldImageUrl 即有值，右侧栏显示世界名+头图）
    try {
      const missing = rows.filter((r) => r.isOnline && r.worldId && String(r.worldId).startsWith('wrld_') && !r.worldName);
      if (missing.length) {
        const worldSvc = loader.services.get('dashboard.world');
        (async () => {
          for (const r of missing.slice(0, 5)) {
            try { await worldSvc({ worldId: r.worldId }); } catch { /* 单个世界失败不影响 */ }
          }
        })();
      }
    } catch { /* 预热失败不影响响应 */ }
    return rows.map((r) => ({ ...r, avatarUrl: avatarOf(r.userIcon, r.avatarUrl) || '' }));
  });
  loader.serviceOwners.set('dashboard.friends', 'core');

  // VRChat 完整头像图(file 5MB) → 256px 缩略图(image)，列表显示用缩略图（代理/缓存秒载）
  // URL 规则（VRChat 真实缩略图）：/file/{file_id}/[version]/[/file|/] → /image/{file_id}/1/256
  // 注意：VRChat file URL 结尾有 /1/file、/1、/1/ 等变体（user_icon 常为 /1 或 /1/ 结尾），
  //       legacy 只匹配 /1/file 导致 user_icon 无法转缩略图 → 放宽为匹配 /file/{file_id}/ 前缀。
  //       生成缩略图固定 version=/1/256（曾错用 /3/256 导致部分 file 404）。
  //       已是 /image/ 缩略图则原样走代理。
  const avatarThumb = (u) => {
    if (!u) return u;
    const s = String(u);
    const m = s.match(/\/file\/(file_[a-f0-9-]+)\//);
    const thumbUrl = m ? `https://api.vrchat.cloud/api/1/image/${m[1]}/1/256` : s;
    return imgProxy(thumbUrl);
  };
  // 用户头像展示统一入口：优先用户资料里设置的图标头像(user_icon)，兜底当前模型外观缩略图(currentAvatar)。
  // 背景：currentAvatarImageUrl 语义是"穿戴的3D模型外观"，常为默认机器人图而非用户真实头像，
  //       user_icon 是用户主动设置的头像（XM1023 显示机器人而非金发女仆头像 bug 的根因，2026-09-01）。
  const avatarOf = (iconUrl, modelUrl) => avatarThumb(iconUrl) || avatarThumb(modelUrl);
  loader.services.set('dashboard.gameSessions', ({ days = 7 } = {}) => {
    const since = new Date(Date.now() - Number(days || 7) * 86400000).toISOString();
    // 取全部 user-location（含离开/传送 world_id=''），用 location 切分会话：
    // 进入世界（wrld_xxx:instance）→ 开新段；离开/传送（traveling/offline/空）→ 结束当前段
    const rows = ctx.storage.query(`SELECT e.world_id AS worldId, COALESCE(NULLIF(e.world_name,''), wc.name, '') AS worldName, e.created_at AS createdAt, e.content_json AS content
      FROM events e LEFT JOIN world_cache wc ON wc.world_id = e.world_id
      WHERE e.type = 'user-location' AND e.created_at >= $since
      ORDER BY e.created_at ASC`, { $since: since });
    const sessions = [];
    let cur = null;
    for (const r of rows) {
      let loc = '';
      try { loc = (JSON.parse(r.content || '{}').location) || ''; } catch { /* ignore */ }
      const inWorld = r.worldId && String(r.worldId).startsWith('wrld_');
      const isOffline = loc === 'offline:offline' || loc === 'offline';
      if (inWorld) {
        if (cur && cur.worldId === r.worldId) {
          // 同世界（含实例内传送后回来）：延续当前段，不切分
          cur.lastSeen = r.createdAt;
          continue;
        }
        if (cur) {
          // 进入不同世界 → 结束旧段
          cur.end = r.createdAt;
          cur.durationMinutes = Math.max(1, Math.round((Date.parse(cur.end) - Date.parse(cur.start)) / 60000));
        }
        cur = { worldId: r.worldId, worldName: r.worldName || r.worldId, start: r.createdAt, lastSeen: r.createdAt, end: null, durationMinutes: 0 };
        sessions.push(cur);
      } else if (isOffline && cur) {
        // 明确离线 → 结束当前段（traveling 传送中不结束，同世界回来合并）
        cur.end = r.createdAt;
        cur.durationMinutes = Math.max(1, Math.round((Date.parse(cur.end) - Date.parse(cur.start)) / 60000));
        cur = null;
      }
    }
    // 最后一段仍在世界（未记录离开）→ 时长到当前
    if (cur) {
      cur.end = new Date().toISOString();
      cur.durationMinutes = Math.max(1, Math.round((Date.parse(cur.end) - Date.parse(cur.start)) / 60000));
    }
    sessions.reverse();
    const totalMinutes = sessions.reduce((a, s) => a + (s.durationMinutes || 0), 0);
    return { count: sessions.length, totalMinutes, days: Number(days) || 7, sessions };
  });
  loader.serviceOwners.set('dashboard.gameSessions', 'core');

  // 自己最近一次状态（从本地 events 表取，即时反映别的客户端改状态，不依赖 /auth/user 缓存）
  loader.services.set('dashboard.latestSelfStatus', () => {
    try {
      const row = ctx.storage.query(
        `SELECT content_json FROM events WHERE type = 'user-update' AND content_json LIKE '%"type":"status"%' ORDER BY id DESC LIMIT 1`);
      if (!row[0]) return null;
      const c = JSON.parse(row[0].content_json || '{}');
      return { userId: c.userId || '', status: c.status || '', statusDescription: c.statusDescription || '' };
    } catch {
      return null;
    }
  });
  loader.serviceOwners.set('dashboard.latestSelfStatus', 'core');

  // 自己是否在线（issue #118 每日离线刷新的在线感知；events 插件经 api.consume 判定，
  // 插件契约禁止直读核心 events 表）。返回 true（明确在线）/ false（明确离线）/
  // null（无法判定——无 selfId/无 user-location 记录/异常）。
  // 护栏：WS 断链期间收不到 offline 推送，最近一条在线记录超过 1 小时无新事件时
  // 视为"可能仍在线"返回 null，由调用方保守推迟刷新（宁可晚刷不在可能在线时刷）。
  loader.services.set('dashboard.isSelfOnline', () => {
    try {
      const selfId = getSelfUserId(ctx.storage);
      if (!selfId) return null;
      const row = ctx.storage.query(
        `SELECT content_json, created_at FROM events WHERE type='user-location' AND user_id = $self ORDER BY created_at DESC LIMIT 1`,
        { $self: selfId }
      )[0];
      if (!row) return null;
      let loc = '';
      try { loc = (JSON.parse(row.content_json || '{}').location) || ''; } catch { return null; }
      // 明确离线/空 → false；其余任何 location 都视为"可能在线"（VRChat 在线时 location 可能是
      // private/friends/group/local/traveling/wrld_ 等，其中 private/friends/group/local 可为"无 worldId 独立值"，
      // 见 parseLocInfo 实例段解析）。绝不把在线状态误判为离线去触发重挖。
      if (loc === 'offline' || loc === 'offline:offline' || loc === '') return false;
      // 可确认的在线形式 + 新鲜度护栏 → true；无法确认/陈旧 → null（调用方保守推迟刷新）
      if (loc.startsWith('wrld_') || loc === 'traveling' || /^(private|friends|group|local)\b/.test(loc)) {
        const at = Date.parse(row.created_at);
        if (!Number.isFinite(at) || Date.now() - at > 60 * 60 * 1000) return null;
        return true;
      }
      return null;
    } catch { return null; }
  });
  loader.serviceOwners.set('dashboard.isSelfOnline', 'core');

  // 动态数据时间范围（最早/最新事件日期）：日历筛选的可选范围（VRCX 对齐）
  loader.services.set('dashboard.eventsRange', () => {
    try {
      const row = ctx.storage.query('SELECT MIN(created_at) AS mn, MAX(created_at) AS mx FROM events');
      return { min: (row[0] && row[0].mn) || null, max: (row[0] && row[0].mx) || null };
    } catch { return { min: null, max: null }; }
  });
  loader.serviceOwners.set('dashboard.eventsRange', 'core');

  loader.services.set('dashboard.events', async ({ limit = 50, offset = 0, dateFrom = '', dateTo = '' } = {}) => {
    // 日期范围过滤（VRCX 式日历范围选择）：只查首尾范围内的数据，分页也按范围
    const conds = [];
    const params = {};
    if (dateFrom) { conds.push('e.created_at >= $from'); params.$from = dateFrom; }
    if (dateTo) { conds.push('e.created_at <= $to'); params.$to = dateTo; }
    // 无子类型的原始重推副本必须在 SQL 层过滤：JS 层过滤会让每页不足 limit 条，
    // 前端 `length >= limit` 判定"数据库到底"→ 加载更多/自动加载消失（回归：用户反馈）
    conds.push(`NOT (e.type IN ('friend-update','user-update') AND json_extract(e.content_json,'$.type') IS NULL)`);
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const rows = ctx.storage.query(`SELECT e.*, f.display_name AS friendDisplayName,
      f.avatar_image_url AS avatarUrl, f.user_icon AS userIcon,
      COALESCE(NULLIF(e.world_name,''), wc.name, '') AS world_name,
      wc.image_url AS world_image_url
      FROM events e LEFT JOIN friends f ON f.user_id = e.user_id
      LEFT JOIN world_cache wc ON wc.world_id = e.world_id
      ${where}
      ORDER BY e.created_at DESC LIMIT $limit OFFSET $offset`,
    { ...params, $limit: Math.min(Math.max(Number(limit) || 50, 1), 200), $offset: Math.max(Number(offset) || 0, 0) });
    // 旧位置推断（对齐 VRCX GPS：本地历史里该用户在此事件之前最近一次 friend-location）
    // 内容库物品名/图缓存：planet_cache（invitem:{itemId}，后台拉取后落盘）本次请求预载
    const invItemCache = {};
    try {
      const invRows = ctx.storage.query(`SELECT key, payload FROM planet_cache WHERE key LIKE 'invitem:%'`);
      for (const r of invRows) {
        const iid = String(r.key).slice('invitem:'.length);
        try { invItemCache[iid] = JSON.parse(r.payload); } catch { /* ignore */ }
      }
    } catch { /* 无表则空 */ }
    const prevLocCache = new Map();
    // 「从哪来」：向前回溯找上一个**真实世界**位置。
    // VRChat 换房前几乎总先推一条 traveling（也是 friend-location 类型），若只取上一条事件，
    // 到达行的 prev 几乎都是 traveling（无 world 对象，名字为空）→「从哪」永远显示不出来（用户反馈）。
    // 规则：回溯最多 25 条，跳过 traveling/offline 行，取第一条带世界的位置；
    // 同世界重进的行（prev==当前世界）由前端 previousWorldName !== worldName 条件自然隐藏。
    // 兼容迁移数据（顶层 worldName）与实时数据（world 对象）两种字段形态。
    const previousLocationOf = (userId, eventId) => {
      const key = `${userId}:${eventId}`;
      if (prevLocCache.has(key)) return prevLocCache.get(key);
      let prev = null;
      try {
        const r = ctx.storage.query(
          `SELECT content_json FROM events WHERE user_id = $uid AND type IN ('friend-location', 'user-location') AND id < $id ORDER BY id DESC LIMIT 25`,
          { $uid: userId, $id: eventId });
        for (const row of r) {
          let cj = {};
          try { cj = JSON.parse(row.content_json || '{}'); } catch { /* malformed */ }
          const loc = cj.location || '';
          if (!loc || loc === 'traveling' || loc === 'offline' || loc === 'offline:offline') continue;
          const worldId = cj.world?.id || (loc.startsWith('wrld_') ? loc.split(':')[0] : '');
          const worldName = cj.world?.name || cj.worldName || '';
          if (!worldName && !worldId) continue;
          prev = {
            location: loc,
            worldName,
            worldId,
            worldImageUrl: imgProxy(cj.world?.imageUrl || cj.world?.thumbnailImageUrl || ''),
          };
          break;
        }
      } catch { prev = null; }
      prevLocCache.set(key, prev);
      return prev;
    };
    const parseLocInfo = (loc) => {
      if (!loc) return { instanceType: '', region: '', instanceId: '', ownerId: '' };
      // 特殊值：offline / offline:offline / traveling 不是"世界:实例"格式，不能误解析成 public
      if (loc === 'offline' || loc === 'offline:offline' || loc === 'traveling') {
        return { instanceType: '', region: '', instanceId: '', ownerId: '' };
      }
      const sep = loc.indexOf(':');
      const rest = sep >= 0 ? loc.slice(sep + 1) : '';
      const im = rest.match(/^([^~]+)/);
      const tm = rest.match(/~((?:friends\+|private|hidden|friends|group|public))\(([^)]+)\)/);
      const rm = rest.match(/~region\(([^)]+)\)/);
      // Luo 语义：private(usr)+canRequestInvite = invite+（邀请+）；hidden = 好友+（前端 instanceLabel 映射）
      let instType = tm ? tm[1] : (rest.includes('~local') ? 'local' : (im ? 'public' : ''));
      if (instType === 'private' && /~canRequestInvite\b/.test(rest)) instType = 'invite+';
      return {
        instanceId: im ? im[1] : '',
        instanceType: instType,
        ownerId: tm ? tm[2] : '',
        region: rm ? rm[1] : '',
      };
    };
    const result = rows.map((row) => {
      // 无子类型的原始 friend-update/user-update 重推副本：diff 子事件已带完整详情，
      // 原始副本只会显示成无详情的"资料变化"噪音 → 不进动态流
      if (row.type === 'friend-update' || row.type === 'user-update') {
        let ct = {};
        try { ct = JSON.parse(row.content_json || '{}'); } catch { /* malformed */ }
        if (!ct.type) return null;
      }
      let content = {};
      try { content = JSON.parse(row.content_json || '{}'); } catch { /* malformed historical payload */ }
      const user = content.user || {};
      const world = content.world || {};
      const worldId = row.world_id || content.worldId || world.id || '';
      const worldName = row.world_name || world.name || '';
      const location = content.location || '';
      const locInfo = parseLocInfo(location);
      const prev = (row.type === 'friend-location' || row.type === 'user-location') ? previousLocationOf(row.user_id, row.id) : null;
      // 群组名解析（缓存优先）：group-joined/group-member-updated 只有 groupId；
      // 未命中的丢后台限流拉 /groups/{id} 回填 group_cache，下次请求即有群名
      const gName = content.groupId ? (((ctx.storage.getGroupCached(content.groupId) || {}).name) || '') : '';
      // 通知更新事件（notification-v2-update/notification-update）只有 {id, updates}：
      // content.id 指向被更新的原通知（user_id），关联回原通知取群组信息与内容
      let src = content;
      if ((row.type === 'notification-v2-update' || row.type === 'notification-update') && content.id) {
        try {
          // 排除 update 事件自身（同 user_id，id 更大排前面）
          const rc = ctx.storage.query(`SELECT content_json AS c FROM events WHERE user_id = $id AND type NOT IN ('notification-v2-update','notification-update') ORDER BY id DESC LIMIT 1`, { $id: content.id });
          if (rc[0]) { try { const rcj = JSON.parse(rc[0].c || '{}'); if (rcj && rcj.type) src = rcj; } catch { /* ignore */ } }
        } catch { /* ignore */ }
      }
      return {
        eventId: row.id,
        type: row.type,
        userId: row.user_id,
        displayName: row.display_name || row.friendDisplayName || user.displayName || row.user_id || '系统',
        createdAt: row.created_at,
        worldId,
        worldName,
        worldImageUrl: imgProxy(row.world_image_url || world.imageUrl || world.thumbnailImageUrl || ''),
        groupName: ((content.groupName) || ''),
        // 通知事件字段（notification v1 / notification-v2）：好友申请/邀请/私信/群组消息；
        // 更新类事件（notification*-update）从关联的原通知（src）取群组信息与内容
        senderUserId: content.senderUserId || '',
        senderUsername: content.senderUsername || '',
        notiImageUrl: imgProxy(src.imageUrl || ''),
        notiMessage: src.message || '',
        notiTitle: src.title || '',
        notiGroupName: ((src.data && src.data.groupName) || gName || (src.title ? String(src.title).split(':')[0].trim() : '') || ''),
        notiGroupId: ((src.data && src.data.groupId) || ''),
        groupId: content.groupId || '',
        contentActionType: content.actionType || '',
        reconcile: !!content.reconcile,
        lastSeenAt: content.lastSeen || '',
        offlineWindowStart: content.offlineWindowStart || '',
        reconcileDetectedAt: content.detectedAt || '',
        unknownContent: row.type === 'unknown' ? JSON.stringify(content).slice(0, 400) : '',
        contentItemId: content.itemId || '',
        contentItemTypeLabel: ({ prop: '道具', bundle: '捆绑包', accessory: '配件', shared: '共享物品' }[content.itemType] || content.itemType || '物品'),
        contentItemName: (content.itemId && invItemCache[content.itemId]) ? invItemCache[content.itemId].name || '' : '',
        contentItemImageUrl: imgProxy((content.itemId && invItemCache[content.itemId]) ? invItemCache[content.itemId].imageUrl || '' : ''),
        avatarUrl: avatarOf(row.userIcon || user.iconUrl, row.avatarUrl || content.avatarImageUrl || user.currentAvatarImageUrl),
        location,
        summary: row.type === 'friend-location' ? '位置变化'
          : row.type === 'friend-update' ? ({ avatar: '更换模型', status: '状态变化', bio: '简介变化', user_icon: '更新头像图标', pronouns: '更新代词' }[content.type] || '资料变化')
          : row.type === 'friend-online' ? '上线'
          : row.type === 'friend-offline' ? (content.reconcile ? '掉线期间离线' : '离线')
          : row.type === 'friend-active' ? '状态变化'
          : row.type === 'notification' || row.type === 'notification-v2' ? (content.message || content.title || '通知')
          : row.type === 'notification-v2-update' || row.type === 'notification-update' ? (content.updates && content.updates.seen ? '通知已读' : '通知状态更新')
          : row.type === 'user-update' ? ({ status: '状态变化', bio: '简介变化', avatar: '更换模型', user_icon: '更新头像图标' }[content.type] || '资料变化')
          : row.type === 'user-location' ? '我的位置变化'
          : row.type === 'friend-add' ? '新增好友'
          : row.type === 'friend-delete' ? '已解除好友'
          : row.type === 'content-refresh' ? ('内容库：' + (content.actionType === 'add' ? '获得' : content.actionType === 'delete' ? '移除' : content.actionType || '更新') + ({ prop: '道具', bundle: '捆绑包', accessory: '配件', shared: '共享物品' }[content.itemType] || content.itemType || '物品'))
          : row.type === 'group-joined' ? ('加入群组' + (gName ? '：' + gName : ''))
          : row.type === 'group-member-updated' ? ('群组成员信息更新' + (gName ? '：' + gName : ''))
          : row.type === 'hide-notification' ? '通知已隐藏'
          : row.type === 'see-notification' ? '通知已读'
          : row.type === 'unknown' ? '未知事件'
          : '未分类事件: ' + row.type,
        // 对齐 VRCX Feed detail：各类型的具体字段
        updateType: content.type || '',
        status: user.status || content.status || '',
        statusDescription: user.statusDescription || content.statusDescription || '',
        previousStatus: content.previousStatus || '',
        previousStatusDescription: content.previousStatusDescription || '',
        avatarName: content.avatarName || user.currentAvatarName || '',
        previousAvatarName: content.previousAvatarName || '',
        // avatarId 富化：WS 推送不含 currentAvatar，从 planet_cache 的 imageUrl→avatarId 映射反查（_syncFriendAvatars 建立）
        avatarId: content.avatarId || user.currentAvatar || (() => {
          const fm = String(content.avatarImageUrl || '').match(/\/file\/(file_[a-f0-9-]+)/);
          if (!fm) return '';
          try {
            const avr = ctx.storage.query(`SELECT payload FROM planet_cache WHERE key = $k`, { $k: `avimg:${fm[1]}` });
            if (avr[0]) { const v = JSON.parse(avr[0].payload); if (v && v.avatarId) return v.avatarId; }
          } catch { /* ignore */ }
          return '';
        })(),
        avatarImageUrl: imgProxy(content.avatarImageUrl || user.currentAvatarImageUrl || ''),
        avatarThumbnailUrl: imgProxy(content.avatarThumbnailUrl || user.currentAvatarThumbnailImageUrl || ''),
        avatarTags: Array.isArray(content.avatarTags) ? content.avatarTags : (Array.isArray(user.currentAvatarTags) ? user.currentAvatarTags : []),
        previousAvatarImageUrl: imgProxy(content.previousAvatarImageUrl || ''),
        bio: content.bio || user.bio || '',
        previousBio: content.previousBio || '',
        userIcon: imgProxy(content.userIcon || user.userIcon || ''),
        previousUserIcon: content.previousUserIcon || '',
        pronouns: content.pronouns || user.pronouns || '',
        previousPronouns: content.previousPronouns || '',
        previousDisplayName: content.previousDisplayName || '',
        instanceType: locInfo.instanceType,
        region: locInfo.region,
        instanceId: locInfo.instanceId,
        previousLocation: prev ? prev.location : '',
        previousWorldName: prev ? prev.worldName : '',
        previousWorldId: prev ? prev.worldId : '',
        previousWorldImageUrl: imgProxy(prev ? prev.worldImageUrl : ''),
        canRequestInvite: !!content.canRequestInvite,
        travelingToLocation: content.travelingToLocation || '',
        // 平台（对齐 VRCX 网页端在线判断：platform === 'web'）：friend-location 事件 content 顶层带 platform
        platform: content.platform || '',
        source: row.source || '',  // 事件来源（websocket / poll / api），展开详情显示
      };
    }).filter(Boolean);
    // avatar 事件补模型名（非阻塞 + 持久化）：WebSocket 推送无 currentAvatar/currentAvatarName，
    // 从 avatarImageUrl 的 file ID 查 /file/{id}（file.name 形如 "Avatar - 模型名 - Image - ..."）。
    // 冷启动时不能阻塞 events 响应（限流器 2.6s/请求 + 路由器到 VRChat API 延迟大 → 首屏可等 1 分钟+）。
    // 策略：内存缓存 + planet_cache 落盘（重启不丢）；未命中的丢后台限流补，本次响应立即返回。
    const parseAvName = (n) => { if (!n) return ''; const m = String(n).match(/^Avatar\s*-\s*(.+?)(\s*-\s*(Image|File|Texture|Thumbnail|VRChat)?.*)?$/i); return m ? m[1].trim() : String(n); };
    const anCache = loader._avatarNameCache || (loader._avatarNameCache = new Map());
    if (!loader._avatarNameCacheLoaded) {
      loader._avatarNameCacheLoaded = true;
      try {
        const rows = ctx.storage.query(`SELECT key, payload FROM planet_cache WHERE key LIKE 'avatar_name:%'`);
        for (const r of rows) {
          const fid = String(r.key).slice('avatar_name:'.length);
          try { const v = JSON.parse(r.payload); if (v && v.name) anCache.set(fid, v.name); } catch { /* ignore */ }
        }
      } catch { /* 无表/查询失败则仅用内存缓存 */ }
    }
    const saveAvName = (fileId, name) => {
      anCache.set(fileId, name);
      try { ctx.storage.setPlanetCache(`avatar_name:${fileId}`, { name, at: Date.now() }); } catch { /* 落盘失败不影响响应 */ }
    };
    // 群组名后台补全（限流）：缓存未命中的群组事件拉 /groups/{id} 回填 group_cache，本次响应立即返回
    const needGroup = [...new Set(result
      .filter((e) => (e.type === 'group-joined' || e.type === 'group-member-updated') && e.groupId && !e.notiGroupName)
      .map((e) => e.groupId))].slice(0, 5);
    if (needGroup.length) {
      (async () => {
        for (const gid of needGroup) {
          try {
            const g = await ctx.rateLimiter.execute(() => ctx.api._request('GET', `/groups/${gid}`));
            const name = g && g.data && g.data.name;
            if (name) {
              try { ctx.storage.upsertGroupCache({ groupId: gid, name, description: g.data.description || '', memberCount: g.data.memberCount || 0 }); } catch { /* 落缓存失败忽略 */ }
              for (const ev of result) if (ev.groupId === gid) ev.notiGroupName = name;
            }
          } catch { /* 拉取失败下次再试 */ }
        }
      })();
    }
    // 内容库物品名/图补全（限流 + planet_cache 落盘）：GET /inventory/{id}。
    // add 的物品在库存内可解析；delete 已移除的可能 404 → 保留 ID 显示（如实）。
    const needInv = [...new Set(result
      .filter((e) => e.type === 'content-refresh' && e.contentItemId && !e.contentItemName)
      .map((e) => e.contentItemId))].slice(0, 5);
    if (needInv.length) {
      (async () => {
        for (const iid of needInv) {
          try {
            const r = await ctx.rateLimiter.execute(() => ctx.api._request('GET', `/inventory/${iid}`));
            const it = r && r.data;
            if (it && it.name) {
              const info = { name: it.name, imageUrl: it.imageUrl || '', itemType: it.itemType || '', at: Date.now() };
              try { ctx.storage.setPlanetCache(`invitem:${iid}`, info); } catch { /* 落盘失败忽略 */ }
              invItemCache[iid] = info;
              for (const ev of result) if (ev.contentItemId === iid) { ev.contentItemName = info.name; ev.contentItemImageUrl = info.imageUrl; }
            }
          } catch { /* 404（已移除）或失败：保留 ID 显示 */ }
        }
      })();
    }
    const needName = result.filter((e) => e.updateType === 'avatar');
    const pending = [];
    const seen = new Set();
    // 收集需要解析的模型名：新模型（avatarName）+ 旧模型（previousAvatarName），按 fileId 去重
    for (const ev of needName.slice(0, 10)) {
      const jobs = [
        { url: ev.avatarImageUrl, key: 'avatarName' },
        { url: ev.previousAvatarImageUrl, key: 'previousAvatarName' },
      ];
      for (const j of jobs) {
        if (!j.url) continue;
        const fm = String(j.url).match(/\/file\/(file_[a-f0-9-]+)/);
        if (!fm) continue;
        const fileId = fm[1];
        if (anCache.has(fileId)) { ev[j.key] = anCache.get(fileId); continue; }
        if (seen.has(fileId)) continue;
        seen.add(fileId);
        pending.push({ ev, fileId, key: j.key });
        if (pending.length >= 6) break;
      }
      if (pending.length >= 6) break;
    }
    if (pending.length) {
      // 后台补名字（走限流器，不阻塞本次响应；补完下次请求即命中）
      (async () => {
        for (const { ev, fileId, key } of pending) {
          try {
            const a = await ctx.rateLimiter.execute(() => ctx.api._request('GET', `/file/${fileId}`));
            const nm = parseAvName(a && a.data && a.data.name);
            if (nm) { ev[key] = nm; saveAvName(fileId, nm); }
          } catch { /* 查询失败保留空名，下次再试 */ }
        }
      })();
    }
    // 数据库事件总数（同日期范围条件，供前端"已加载/总数"显示）
    let total = 0;
    try {
      const tc = [];
      const tp = {};
      if (dateFrom) { tc.push('created_at >= $from'); tp.$from = dateFrom; }
      if (dateTo) { tc.push('created_at <= $to'); tp.$to = dateTo; }
      tc.push(`NOT (type IN ('friend-update','user-update') AND json_extract(content_json,'$.type') IS NULL)`);
      const tw = tc.length ? 'WHERE ' + tc.join(' AND ') : '';
      const trow = ctx.storage.query(`SELECT COUNT(*) AS c FROM events ${tw}`, tp);
      total = trow[0] ? trow[0].c : 0;
    } catch { total = 0; }
    return { events: result, total };
  });
  loader.serviceOwners.set('dashboard.events', 'core');
  loader.services.set('dashboard.friendEvents', ({ userId, limit = 12 } = {}) => {
    if (typeof userId !== 'string' || !userId) throw new Error('userId is required');
    const rows = ctx.storage.getEventsByUser(userId, {
      limit: Math.min(Math.max(Number(limit) || 12, 1), 50),
    });
    const friend = getDashboardFriend(userId);
    // 过滤无子类型的原始 friend-update/user-update 重推副本（diff 子事件已带详情，原始副本是"资料变化"噪音）
    const rowsFiltered = rows.filter((row) => {
      if (row.type !== 'friend-update' && row.type !== 'user-update') return true;
      try { return !!JSON.parse(row.content_json || '{}').type; } catch { return true; }
    });
    return rowsFiltered.map((row) => {
      let content = {};
      try { content = JSON.parse(row.content_json || '{}'); } catch { /* malformed historical payload */ }
      const world = content.world || {};
      return {
        eventId: row.id,
        type: row.type,
        userId: row.user_id,
        displayName: row.display_name || friend?.displayName || row.user_id || '系统',
        createdAt: row.created_at,
        worldId: row.world_id || content.worldId || world.id || '',
        worldName: row.world_name || world.name || '',
        avatarUrl: avatarOf(friend?.userIcon, friend?.avatarUrl),
        summary: row.type === 'friend-location' ? '位置变化' : row.type === 'friend-online' ? '上线' : row.type === 'friend-offline' ? '离线' : row.type === 'friend-active' ? '状态变化' : row.type === 'friend-update' ? ({ avatar: '更换模型', status: '状态变化', bio: '简介变化', user_icon: '更新头像图标', pronouns: '更新代词', displayName: '改名' }[content.type] || '资料变化') : row.type === 'notification' || row.type === 'notification-v2' ? (content.message || content.title || '通知') : row.type === 'notification-v2-update' || row.type === 'notification-update' ? (content.updates && content.updates.seen ? '通知已读' : '通知状态更新') : row.type === 'user-update' ? ({ status: '状态变化', bio: '简介变化', avatar: '更换模型', user_icon: '更新头像图标', pronouns: '更新代词', displayName: '改名' }[content.type] || '资料变化') : row.type === 'user-location' ? '我的位置变化' : row.type === 'friend-add' ? '新增好友' : row.type === 'friend-delete' ? '已解除好友' : row.type === 'content-refresh' ? ('内容库：' + (content.actionType === 'add' ? '获得' : content.actionType === 'delete' ? '移除' : content.actionType || '更新') + ({ prop: '道具', bundle: '捆绑包' }[content.itemType] || content.itemType || '物品')) : row.type === 'group-joined' ? '加入群组' : row.type === 'group-member-updated' ? '群组成员信息更新' : row.type === 'hide-notification' ? '通知已隐藏' : row.type === 'see-notification' ? '通知已读' : row.type === 'unknown' ? '未知事件' : '未分类事件: ' + row.type,
      };
    });
  });
  loader.serviceOwners.set('dashboard.friendEvents', 'core');

  // 最近访问世界（对齐 VRCX Dashboard Recently Visited）：事件里出现过的世界按最近出现排序去重
  loader.services.set('dashboard.recentWorlds', ({ limit = 12 } = {}) => {
    const l = Math.min(Math.max(Number(limit) || 12, 1), 60);
    const worlds = ctx.storage.query(`SELECT e.world_id AS worldId,
        COALESCE(NULLIF(e.world_name,''), wc.name, '') AS worldName,
        wc.image_url AS imageUrl,
        wc.favorited AS favorited,
        MAX(wc.note) AS note,
        MAX(e.created_at) AS lastSeen, COUNT(*) AS visits
      FROM events e LEFT JOIN world_cache wc ON wc.world_id = e.world_id
      WHERE e.world_id != '' AND e.type = 'user-location'
      GROUP BY e.world_id ORDER BY lastSeen DESC LIMIT $limit`,
      { $limit: l });
    // 游玩分钟：30 天窗口 user-location 会话切分（同 gameSessions 口径：进入世界开段、离开/传送关段、同世界延续）
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const rows = ctx.storage.query(
      `SELECT e.world_id AS worldId, e.created_at AS createdAt, e.content_json AS content FROM events e
       WHERE e.type = 'user-location' AND e.created_at >= $since ORDER BY e.created_at ASC`,
      { $since: since });
    const minutes = new Map();
    const segCount = new Map();   // 进入段数（与 worldHistory 同口径：一次连续停留 = 1 次进入）
    const addMin = (s) => {
      const m = Math.max(1, Math.round((Date.parse(s.end) - Date.parse(s.start)) / 60000));
      if (m > 0 && s.worldId && String(s.worldId).startsWith('wrld_')) {
        minutes.set(s.worldId, (minutes.get(s.worldId) || 0) + m);
        segCount.set(s.worldId, (segCount.get(s.worldId) || 0) + 1);
      }
    };
    let cur = null;
    for (const r of rows) {
      let loc = '';
      try { loc = (JSON.parse(r.content || '{}').location) || ''; } catch { /* 脏数据忽略 */ }
      const inWorld = r.worldId && String(r.worldId).startsWith('wrld_');
      if (inWorld) {
        if (cur && cur.worldId === r.worldId) { cur.lastSeen = r.createdAt; continue; }
        if (cur) { cur.end = r.createdAt; addMin(cur); }
        cur = { worldId: r.worldId, start: r.createdAt, lastSeen: r.createdAt };
      } else if (cur && (loc === 'offline:offline' || loc === 'offline' || loc === 'traveling')) {
        cur.end = r.createdAt; addMin(cur); cur = null;
      }
    }
    if (cur) { cur.end = cur.lastSeen; addMin(cur); }
    return worlds.map((w) => ({ ...w, visits: segCount.get(w.worldId) || 0, minutes: minutes.get(w.worldId) || 0 }));  // 保持数组契约（路由层再包 {worlds: [...]}）；visits 统一为进入段数
  });
  loader.serviceOwners.set('dashboard.recentWorlds', 'core');

  // 通知历史（对齐 VRCX Notifications 可回看已处理）：本地 events 里的通知类事件
  loader.services.set('dashboard.notificationEvents', ({ limit = 30 } = {}) =>
    ctx.storage.query(`SELECT e.* FROM events e
      WHERE e.type IN ('notification','notification-v2')
      ORDER BY e.created_at DESC LIMIT $limit`,
    { $limit: Math.min(Math.max(Number(limit) || 30, 1), 100) }).map(row => {
      let content = {};
      try { content = JSON.parse(row.content_json || '{}'); } catch { /* malformed */ }
      const n = (content && content.notification) || content || {};
      return {
        eventId: row.id, createdAt: row.created_at,
        notificationType: n.type || content.type || '',
        senderUserId: n.senderUserId || content.senderUserId || content.userId || '',
        senderUsername: n.senderUsername || (n.sender && n.sender.displayName) || '',
        message: n.message || content.message || content.details || '',
        title: n.title || content.title || '',
        imageUrl: imgProxy(n.imageUrl || (content.data && content.data.imageUrl) || ''),
        groupName: (content.data && content.data.groupName) || '',
        groupId: (content.data && content.data.groupId) || '',
      };
    })
  );
  loader.serviceOwners.set('dashboard.notificationEvents', 'core');

  // 群组历史公告（本地事件库：WS 推送过的 group.announcement 通知，按 content.data.groupId 匹配）
  loader.services.set('dashboard.groupAnnouncements', ({ groupId } = {}) => {
    if (!groupId || !String(groupId).startsWith('grp_')) return [];
    const rows = ctx.storage.query(
      `SELECT id, content_json AS c, created_at FROM events
       WHERE type='notification-v2' AND content_json LIKE '%' || $gid || '%'
       ORDER BY created_at DESC LIMIT 30`,
      { $gid: groupId });
    return rows.map((row) => {
      let content = {};
      try { content = JSON.parse(row.c || '{}'); } catch { /* malformed */ }
      const data = content.data || {};
      return {
        eventId: row.id,
        createdAt: row.created_at,
        groupId: data.groupId || groupId,
        groupName: data.groupName || (content.title ? String(content.title).split(':')[0].trim() : '') || '',
        title: data.announcementTitle || content.title || '',
        text: content.message || '',
      };
    });
  });
  loader.serviceOwners.set('dashboard.groupAnnouncements', 'core');

  // 全部群组公告时间线（跨群组汇总：type=group.announcement 的 notification-v2 事件）
  loader.services.set('dashboard.groupAnnouncementsAll', ({ limit = 100 } = {}) => {
    try {
      const rows = ctx.storage.query(
        `SELECT id, content_json AS c, created_at FROM events
         WHERE type='notification-v2' AND content_json LIKE '%group.announcement%'
         ORDER BY created_at DESC LIMIT $limit`,
        { $limit: Math.min(Math.max(Number(limit) || 100, 1), 200) });
      return {
        total: rows.length,
        announcements: rows.map((row) => {
          let content = {};
          try { content = JSON.parse(row.c || '{}'); } catch { /* malformed */ }
          const data = content.data || {};
          const t = content.title || data.announcementTitle || '';
          const groupName = data.groupName || String(t).split(':')[0].trim() || '';
          const annTitle = data.announcementTitle || (String(t).includes(':') ? String(t).split(':').slice(1).join(':').trim() : t);
          return {
            eventId: row.id,
            createdAt: row.created_at,
            groupId: data.groupId || content.groupId || '',
            groupName,
            title: annTitle,
            text: content.message || '',
          };
        }),
      };
    } catch {
      return { total: 0, announcements: [] };
    }
  });
  loader.serviceOwners.set('dashboard.groupAnnouncementsAll', 'core');

  // world_cache 中空名世界（占位记录，供插件按需 forceRefresh 回填真实名字）
  loader.services.set('dashboard.emptyWorldIds', () =>
    ctx.storage.query(`SELECT world_id AS worldId FROM world_cache
      WHERE (name IS NULL OR name = '') AND world_id LIKE 'wrld_%'
      ORDER BY updated_at DESC LIMIT 100`)
  );
  loader.serviceOwners.set('dashboard.emptyWorldIds', 'core');

  // 非好友追踪列表（tracked_non_friends：历史非好友，定时拉取资料/头像——VRCX-Luo 对齐；供 tracked 视图）
  loader.services.set('dashboard.trackedNonFriends', ({ limit = 200 } = {}) => {
    try {
      const rows = ctx.storage.query(
        `SELECT user_id AS userId, display_name AS displayName, avatar_image_url AS avatarUrl,
                status, status_description AS statusDescription, location,
                added_at AS addedAt, last_refresh_at AS lastRefreshAt
         FROM tracked_non_friends WHERE removed_at = '' ORDER BY last_refresh_at DESC, added_at DESC LIMIT $limit`,
        { $limit: Math.min(Math.max(Number(limit) || 200, 1), 500) });
      const selfId = getSelfUserId(ctx.storage);
      return { tracked: rows.filter((r) => r.userId !== selfId).map((r) => ({ ...r, avatarUrl: avatarThumb(r.avatarUrl) || '' })) };
    } catch {
      return { tracked: [] };
    }
  });
  loader.serviceOwners.set('dashboard.trackedNonFriends', 'core');

  // 添加追踪非好友（幂等 INSERT OR IGNORE；刷新循环自动接管新用户）
  loader.services.set('dashboard.trackedAdd', ({ userId, displayName = '' } = {}) => {
    if (typeof userId !== 'string' || !userId.startsWith('usr_')) {
      throw new Error('userId 必须是 usr_ 开头的用户 ID');
    }
    if (userId === getSelfUserId(ctx.storage)) throw new Error('不能追踪自己');
    const dn = String(displayName || '').slice(0, 64);
    const existing = ctx.storage.query(
      `SELECT user_id, display_name FROM tracked_non_friends WHERE user_id = $u`,
      { $u: userId });
    ctx.storage.run(
      `INSERT OR IGNORE INTO tracked_non_friends (user_id, display_name) VALUES ($u, $d)`,
      { $u: userId, $d: dn });
    // 重新添加：清除移除标记（若是历史移除过的用户）
    ctx.storage.run(`UPDATE tracked_non_friends SET removed_at = '' WHERE user_id = $u`, { $u: userId });
    const added = !existing.length;
    return { ok: true, added, userId, displayName: dn };
  });
  loader.serviceOwners.set('dashboard.trackedAdd', 'core');

  // 移除追踪非好友（DELETE；安全模式由路由层拦截）
  loader.services.set('dashboard.trackedRemove', ({ userId } = {}) => {
    if (typeof userId !== 'string' || !userId.startsWith('usr_')) {
      throw new Error('userId 必须是 usr_ 开头的用户 ID');
    }
    const r = ctx.storage.run(
      `UPDATE tracked_non_friends SET removed_at = datetime('now') WHERE user_id = $u AND removed_at = ''`,
      { $u: userId });
    return { ok: true, removed: r.changes > 0, userId };
  });
  loader.serviceOwners.set('dashboard.trackedRemove', 'core');

  // 非好友资料变化历史：start-monitor.js _recordNonFriendChange 把 bio/status 变化写成
  // friend-update 事件（content.type=bio/status，含 previousX 对比，source=poll）——此处只读查询展示
  loader.services.set('dashboard.trackedChanges', ({ userId, limit = 20 } = {}) => {
    if (typeof userId !== 'string' || !userId || !userId.startsWith('usr_')) return { changes: [] };
    try {
      const rows = ctx.storage.query(
        `SELECT id, created_at AS createdAt, content_json AS content FROM events
         WHERE user_id = $uid AND type = 'friend-update' AND source = 'poll'
         ORDER BY id DESC LIMIT $limit`,
        { $uid: userId, $limit: Math.min(Math.max(Number(limit) || 20, 1), 100) });
      return {
        changes: rows.map((r) => {
          let c = {};
          try { c = JSON.parse(r.content || '{}'); } catch { /* malformed */ }
          return {
            eventId: r.id,
            createdAt: r.createdAt,
            type: c.type || '',
            bio: c.bio || '',
            previousBio: c.previousBio || '',
            status: c.status || '',
            statusDescription: c.statusDescription || '',
            previousStatus: c.previousStatus || '',
            previousStatusDescription: c.previousStatusDescription || '',
            avatarImageUrl: c.avatarImageUrl ? avatarThumb(c.avatarImageUrl) : '',
            previousAvatarImageUrl: c.previousAvatarImageUrl ? avatarThumb(c.previousAvatarImageUrl) : '',
          };
        }),
      };
    } catch {
      return { changes: [] };
    }
  });
  loader.serviceOwners.set('dashboard.trackedChanges', 'core');

  loader.services.set('dashboard.stats', ({ days = 7 } = {}) => {
    const d = Math.min(Math.max(Number(days) || 7, 1), 90);
    const since = new Date(Date.now() - d * 86400000).toISOString();
    const params = { $since: since };
    const byType = ctx.storage.query(
      `SELECT type, COUNT(*) AS count FROM events WHERE created_at >= $since GROUP BY type ORDER BY count DESC`,
      params);
    const byDay = ctx.storage.query(
      `SELECT substr(created_at,1,10) AS day, COUNT(*) AS count FROM events
       WHERE created_at >= $since GROUP BY day ORDER BY day ASC`,
      params);
    const topFriends = ctx.storage.query(
      `SELECT user_id AS userId, display_name AS displayName, COUNT(*) AS count FROM events
       WHERE created_at >= $since GROUP BY user_id ORDER BY count DESC LIMIT 10`,
      params);
    // 上线时段分布（对齐 VRCX Charts：好友上线事件按小时统计）
    const byHour = ctx.storage.query(
      `SELECT CAST(strftime('%H', created_at) AS INTEGER) AS hour, COUNT(*) AS count FROM events
       WHERE type = 'friend-online' AND created_at >= $since GROUP BY hour ORDER BY hour ASC`,
      params).map(r => ({ label: `${String(r.hour).padStart(2, '0')}:00`, value: Number(r.count) || 0 }));
    const onlineRow = ctx.storage.get('SELECT COUNT(*) AS n FROM friends WHERE is_online = 1');
    return {
      days: d,
      onlineNow: onlineRow?.n || 0,
      totalEvents: byDay.reduce((a, x) => a + (Number(x.count) || 0), 0),
      byType,
      byDay,
      byHour,
      topFriends,
    };
  });
  loader.serviceOwners.set('dashboard.stats', 'core');
  loader.services.set('dashboard.activityHeatmap', ({ days = 7 } = {}) => {
    const d = Math.min(Math.max(Number(days) || 7, 1), 30);
    const since = new Date(Date.now() - d * 86400000).toISOString();
    const rows = ctx.storage.query(
      `SELECT e.world_id AS worldId, e.created_at AS createdAt, e.content_json AS content
       FROM events e WHERE e.type='user-location' AND e.created_at >= $since ORDER BY e.created_at ASC`,
      { $since: since });
    // 在线时段（同 gameSessions：进入 wrld 在线、offline 结束、traveling 合并）
    const segs = [];
    let cur = null;
    for (const r of rows) {
      let loc = ''; try { loc = (JSON.parse(r.content || '{}').location) || ''; } catch { /* ignore */ }
      const inWorld = r.worldId && String(r.worldId).startsWith('wrld_');
      const isOffline = loc === 'offline:offline' || loc === 'offline';
      if (inWorld) {
        if (cur && cur.worldId === r.worldId) { cur.lastSeen = r.createdAt; continue; }
        if (cur) { cur.end = r.createdAt; segs.push(cur); }
        cur = { worldId: r.worldId, start: r.createdAt, end: null };
      } else if (isOffline && cur) { cur.end = r.createdAt; segs.push(cur); cur = null; }
    }
    if (cur) { cur.end = new Date().toISOString(); segs.push(cur); }
    // 热图：date -> Set(hour)
    const byDay = {};
    for (const s of segs) {
      const start = Math.floor(Date.parse(s.start) / 3600000) * 3600000;
      const end = Date.parse(s.end);
      for (let t = start; t < end; t += 3600000) {
        const dt = new Date(t);
        const key = dt.toISOString().slice(0, 10);
        (byDay[key] = byDay[key] || new Set()).add(dt.getUTCHours());
      }
    }
    const out = [];
    for (let i = d - 1; i >= 0; i--) {
      const date = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      const set = byDay[date] || new Set();
      out.push({ date, hours: Array.from({ length: 24 }, (_, h) => set.has(h) ? 1 : 0) });
    }
    return { rangeDays: d, days: out };
  });
  loader.serviceOwners.set('dashboard.activityHeatmap', 'core');
  loader.services.set('dashboard.world', async ({ worldId } = {}) => {
    if (typeof worldId !== 'string' || !worldId.startsWith('wrld_')) return { worldId: worldId || '', name: '' };
    const pick = (w) => ({ worldId, name: w?.name || '', imageUrl: imgProxy(w?.image_url || w?.imageUrl || ''), thumbnailImageUrl: imgProxy(w?.thumbnail_image_url || w?.thumbnailImageUrl || ''), authorName: w?.author_name || w?.authorName || '', description: w?.description || '', tags: Array.isArray(w?.tags) ? w.tags : [], featured: !!w?.featured, releaseStatus: w?.release_status || w?.releaseStatus || '', capacity: w?.capacity || 0, recommendedCapacity: w?.recommended_capacity || w?.recommendedCapacity || 0, visits: w?.visits || 0, favorites: w?.favorites || 0, heat: w?.heat || 0, version: w?.version || 0, platforms: Array.isArray(w?.platforms) ? w.platforms : [], occupants: w?.occupants || 0, publicOccupants: w?.public_occupants || w?.publicOccupants || 0, privateOccupants: w?.private_occupants || w?.privateOccupants || 0, instances: Array.isArray(w?.instances) ? w.instances : [], createdAt: w?.created_at || w?.createdAt || '', updatedAt: w?.updated_at || w?.updatedAt || '', publicationDate: w?.publication_date || w?.publicationDate || '', labsPublicationDate: w?.labs_publication_date || w?.labsPublicationDate || '', performance: w?.performance || '' });
    const fetchFresh = async () => {
      if (!ctx.api || !ctx.rateLimiter) return null;
      try {
        // 10s 超时：限流排队 + API 网络慢时不让世界资料无限等待
        const result = await Promise.race([
          ctx.rateLimiter.execute(() => ctx.api._request('GET', `/worlds/${worldId}`)),
          new Promise((_, rej) => setTimeout(() => rej(new Error('world fetch timeout')), 10000)),
        ]);
        if (result.status === 200 && result.data) {
          const w = result.data;
          ctx.storage.upsertWorld({ worldId, name: w.name || '', authorId: w.authorId || '', authorName: w.authorName || '', imageUrl: w.imageUrl || '', description: w.description || '', tags: w.tags || [] });
          return pick(w);
        }
      } catch { /* 超时/失败返回 null，由调用方回退缓存或占位 */ }
      return null;
    };
    const cached = ctx.storage.getWorldName(worldId);
    if (cached?.name) {
      // world_cache.tags 存的是 JSON 字符串，解析后用于缓存完整性判断
      let cachedTags = cached.tags;
      if (typeof cachedTags === 'string') { try { cachedTags = JSON.parse(cachedTags || '[]'); } catch { cachedTags = []; } }
      // 缓存含标签且带 version 才视为完整（旧缓存缺 version/heat 等字段，需 fetchFresh 补齐一次）
      if (cached.description && Array.isArray(cachedTags) && cachedTags.length && cached.version != null) return { ...pick(cached), tags: cachedTags, note: cached.note || '' };
      const fresh = await fetchFresh().catch(() => null);
      return fresh ? { ...fresh, note: cached.note || '' } : { ...pick(cached), tags: cachedTags, note: cached.note || '' };
    }
    const fresh = await fetchFresh().catch(() => null);
    return fresh || { worldId, name: '' };
  });
  loader.serviceOwners.set('dashboard.world', 'core');

  // 世界本地游玩统计（VRCX 对齐：最后游玩时间 / 游玩次数 / 总停留时长）——events 里我的 user-location 记录
  loader.services.set('dashboard.worldHistory', ({ worldId } = {}) => {
    if (typeof worldId !== 'string' || !worldId.startsWith('wrld_')) return { visits: 0, minutes: 0, last: '' };
    try {
      // 会话切分（与 gameSessions 同口径）：进入世界开段、离线关段、同世界延续；
      // 跨世界间隔不计入（旧实现按 LIKE 事件时间差累加会把 A→B→A 的 B 段算进 A）
      const rows = ctx.storage.query(
        `SELECT e.world_id AS worldId, e.created_at AS createdAt, e.content_json AS content FROM events e
         WHERE e.type = 'user-location' ORDER BY e.created_at ASC`);
      const segs = [];
      let cur = null;
      for (const r of rows) {
        let loc = '';
        try { loc = (JSON.parse(r.content || '{}').location) || ''; } catch { /* 脏数据忽略 */ }
        const inWorld = r.worldId && String(r.worldId).startsWith('wrld_');
        if (inWorld) {
          if (cur && cur.worldId === r.worldId) { cur.lastSeen = r.createdAt; continue; }
          if (cur) { cur.end = r.createdAt; segs.push(cur); }
          cur = { worldId: r.worldId, start: r.createdAt, lastSeen: r.createdAt };
        } else if (cur && (loc === 'offline:offline' || loc === 'offline')) {
          cur.end = r.createdAt; segs.push(cur); cur = null;
        }
      }
      // 末段不封口修复：仍在世界（未记录离线）→ 封到 lastSeen（避免虚增未来时间）
      if (cur) { cur.end = cur.lastSeen; segs.push(cur); }
      let visits = 0, minutes = 0, last = '';
      for (const s of segs) {
        if (s.worldId !== worldId) continue;
        visits++;
        minutes += Math.max(1, Math.round((Date.parse(s.end) - Date.parse(s.start)) / 60000));
        if (s.lastSeen > last) last = s.lastSeen;
      }
      return { visits, minutes, last };
    } catch { return { visits: 0, minutes: 0, last: '' }; }
  });
  loader.serviceOwners.set('dashboard.worldHistory', 'core');

  // 世界实时实例（在线实例列表是实时数据，不缓存——每次拉最新 /worlds/{id}）
  loader.services.set('dashboard.worldInstances', async ({ worldId } = {}) => {
    if (typeof worldId !== 'string' || !worldId.startsWith('wrld_')) return { instances: [], publicOccupants: 0, privateOccupants: 0, occupants: 0 };
    if (!ctx.api || !ctx.rateLimiter) return { instances: [], publicOccupants: 0, privateOccupants: 0, occupants: 0 };
    const parseLoc = (loc) => {
      // world.instances 的 location 是纯实例部分（无 worldId 前缀）：如 "86595~group(grp_xxx)~groupAccessType(public)~region(jp)"
      const s = String(loc || '');
      const instId = (s.match(/^([^~]+)/) || [])[1] || '';
      // friends+ 必须排在 friends 前（交替从左到右，否则 friends 先吃掉 friends+ 前缀）
      const tm = s.match(/~((?:friends\+|private|hidden|friends|group|public))\(([^)]+)\)/);
      const gat = (s.match(/~groupAccessType\(([^)]+)\)/) || [])[1] || '';
      return { instId, type: tm ? tm[1] : 'public', ownerId: tm ? tm[2] : '', groupAccessType: gat };
    };
    try {
      const r = await Promise.race([
        ctx.rateLimiter.execute(() => ctx.api._request('GET', `/worlds/${worldId}`)),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10000)),
      ]);
      if (r.status === 200 && r.data) {
        const w = r.data;
        // 房主信息增强（用户显示头像+用户名；群组显示群组头像+群组名）：
        // - 群组房：拉 /groups/{id} 拿群组名/图标
        // - 普通房：world.instances 不给 owner，拉 /instances/{worldId}:{loc} 拿 ownerId
        // 并行拉取（弹窗低频，不走全局限流，8s 超时兜底）；结果 5 分钟内存缓存
        const friendMap = {};
        try {
          for (const fr of ctx.storage.query('SELECT user_id, display_name, avatar_image_url, user_icon FROM friends')) {
            friendMap[fr.user_id] = { name: fr.display_name || '', avatar: avatarOf(fr.user_icon, fr.avatar_image_url) };
          }
        } catch { /* 好友查询失败不影响实例 */ }
        const instOwnerCache = new Map();
        const IO_TTL = 5 * 60 * 1000;
        const fetchInstApi = async (path) => {
          if (!ctx.api) return null;
          try {
            const rr = await Promise.race([
              ctx.api._request('GET', path),
              new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
            ]);
            return rr.status === 200 && rr.data ? rr.data : null;
          } catch { return null; }
        };
        const ownerFor = async (p, loc) => {
          const key = p.type === 'group' ? 'g:' + p.ownerId : 'i:' + worldId + ':' + loc;
          const hit = instOwnerCache.get(key);
          if (hit && Date.now() - hit.t < IO_TTL) return hit.v;
          let v = null;
          try {
            if (p.type === 'group') {
              const g = await fetchInstApi(`/groups/${p.ownerId}`);
              v = { kind: 'group', id: p.ownerId, name: (g && (g.name || g.displayName)) || '', avatar: (g && (g.iconUrl || g.$thumbnailUrl)) || '' };
            } else if (p.ownerId) {
              const f = friendMap[p.ownerId];
              v = { kind: 'user', id: p.ownerId, name: f ? f.name : '', avatar: f ? f.avatar : '' };
            } else {
              const d = await fetchInstApi(`/instances/${worldId}:${loc}`);
              const uid = d && d.ownerId ? d.ownerId : '';
              if (uid) {
                const f = friendMap[uid];
                v = {
                  kind: 'user', id: uid,
                  name: f ? f.name : (d.displayName || ''),
                  avatar: f ? f.avatar : avatarThumb(d.currentAvatarThumbnailImageUrl || d.currentAvatarImageUrl || ''),
                  // 实例标题（VRChat+ 实例自定义名，如"#我俩岁了我告老师了"）
                  instanceName: (d && (d.displayName || d.name)) || '',
                };
              }
            }
            if (v) instOwnerCache.set(key, { t: Date.now(), v });
          } catch { /* owner 解析失败置空 */ }
          return v;
        };
        const raw = Array.isArray(w.instances) ? w.instances : [];
        const instances = await Promise.all(raw.map(async ([loc, cnt]) => {
          const p = parseLoc(loc);
          const owner = await ownerFor(p, loc);
          return { location: loc, count: cnt, type: p.type === 'group' ? 'group' : p.type, groupAccessType: p.groupAccessType || '', shortName: p.instId, owner };
        }));
        return {
          instances,
          publicOccupants: w.publicOccupants || w.public_occupants || 0,
          privateOccupants: w.privateOccupants || w.private_occupants || 0,
          occupants: w.occupants || 0,
        };
      }
    } catch { /* 失败返回空 */ }
    return { instances: [], publicOccupants: 0, privateOccupants: 0, occupants: 0 };
  });
  loader.serviceOwners.set('dashboard.worldInstances', 'core');

  // 实例详情（房主/容量/在线用户——VRChat /instances/{location}，world.instances 不给普通房房主）
  loader.services.set('dashboard.instance', async ({ location } = {}) => {
    if (typeof location !== 'string' || !location) return { error: 'location required' };
    if (!ctx.api || !ctx.rateLimiter) return { error: 'no api' };
    // VRChat /instances/{worldId}:{instanceId} 接受完整 location，且 ~ ( ) 需保持未编码（cURL 示例如此）
    try {
      const r = await Promise.race([
        ctx.rateLimiter.execute(() => ctx.api._request('GET', `/instances/${location}`)),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10000)),
      ]);
      if (r.status === 200 && r.data) {
        const d = r.data;
        let ownerName = '', ownerAvatar = '';
        if (d.ownerId) {
          try {
            const fr = ctx.storage.query('SELECT display_name, avatar_image_url FROM friends WHERE user_id=$u', { $u: d.ownerId })[0];
            if (fr) { ownerName = fr.display_name || ''; ownerAvatar = avatarThumb(fr.avatar_image_url || ''); }
          } catch { /* 房主名查询失败不影响 */ }
        }
        return {
          location,
          name: d.name || '',
          displayName: d.displayName || d.name || '',
          ownerId: d.ownerId || '',
          ownerName,
          ownerAvatar,
          capacity: d.capacity || 0,
          region: d.region || '',
          type: d.type || '',
          users: Array.isArray(d.users) ? d.users.map((u) => ({
            id: u.id || u.userId || '',
            displayName: u.displayName || u.username || '',
            avatarUrl: avatarOf(u.userIcon, u.currentAvatarThumbnailImageUrl || u.currentAvatarImageUrl),
          })) : [],
          worldId: (d.world && d.world.id) || '',
          worldName: (d.world && d.world.name) || '',
        };
      }
    } catch { /* 失败返回空 */ }
    return { location, error: 'instance fetch failed' };
  });
  loader.serviceOwners.set('dashboard.instance', 'core');

  // 用户详情聚合（VRCX-Luo UserDialog 对齐）：资料/共同好友/群组/创建的世界/模型 + 本地统计
  // 性能：API 部分 5 分钟内存缓存（弹窗重复打开秒开）；弹窗低频请求不走全局限流队列（避免 5 个串行排队 ~13s）
  const userProfileCache = new Map();
  const UP_TTL = 5 * 60 * 1000;
  loader.services.set('dashboard.userProfile', async ({ userId } = {}) => {
    if (typeof userId !== 'string' || !userId.startsWith('usr_')) return { error: 'invalid userId' };
    const fetchApi = async (path) => {
      if (!ctx.api) return null;
      try {
        const r = await Promise.race([
          ctx.api._request('GET', path),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
        ]);
        return r.status === 200 && r.data ? r.data : null;
      } catch { return null; }
    };
    const uid = encodeURIComponent(userId);
    let user, friendsList, groups, worlds, avatars, favoriteWorlds;
    const cached = userProfileCache.get(userId);
    if (cached && Date.now() - cached.time < UP_TTL) {
      ({ user, friendsList, groups, worlds, avatars, favoriteWorlds } = cached);
    } else {
      const selfId = (ctx.api && ctx.api.currentUser && ctx.api.currentUser.id) || '';
      const [u, fl, g, w, av] = await Promise.all([
        fetchApi(`/users/${uid}`),
        fetchApi(`/users/${uid}/friends`),
        fetchApi(`/users/${uid}/groups`),
        fetchApi(`/worlds?userId=${uid}&n=50`),
        // 他人模型列表 VRChat 403（只能查自己）——跳过避免白等，弹窗仍可看群组/世界/共同好友
        userId === selfId ? fetchApi(`/avatars?userId=${uid}&n=50`) : Promise.resolve(null),
      ]);
      user = u; friendsList = fl; groups = g; worlds = w; avatars = av;
      // 该用户的收藏世界（VRChat 公开收藏：/favorite/groups?ownerId + /worlds/favorites?ownerId&tag，VRCX 同款）
      favoriteWorlds = [];
      try {
        const favGroupsRaw = await fetchApi(`/favorite/groups?ownerId=${uid}&n=100&offset=0`);
        if (Array.isArray(favGroupsRaw)) {
          const groupTasks = favGroupsRaw
            .filter((gr) => gr && (gr.type === 'world' || gr.type === 'vrcPlusWorld'))
            .map(async (gr) => {
              // VRChat worlds/favorites 需同时传 ownerId + userId 才查他人收藏（VRCX getFavoriteWorlds 同款参数）
              const favs = await fetchApi(`/worlds/favorites?ownerId=${uid}&userId=${uid}&tag=${encodeURIComponent(gr.name || '')}&n=100&offset=0`);
              return {
                name: gr.displayName || gr.name || '',
                visibility: gr.visibility || '', // public / friends / private
                worlds: (Array.isArray(favs) ? favs : []).map((x) => ({
                  worldId: x.id || x.worldId || '',
                  name: x.name || x.worldName || '',
                  imageUrl: imgProxy(x.imageUrl || x.thumbnailImageUrl || ''),
                  authorName: x.authorName || '',
                })),
              };
            });
          favoriteWorlds = (await Promise.all(groupTasks)).filter(Boolean);
        }
      } catch { favoriteWorlds = []; }
      userProfileCache.set(userId, { time: Date.now(), user, friendsList, groups, worlds, avatars, favoriteWorlds });
    }
    // 共同好友：VRChat 专用端点 /users/{id}/mutuals/friends（服务器直接算共同好友，无需对方开启"共享好友列表"）
    // 旧实现用 /users/{id}/friends（对方全部好友）+ 本地交集，对方关闭共享时为空 → 共同好友不显示
    const mf = await fetchApi(`/users/${uid}/mutuals/friends`);
    const mutualFriends = Array.isArray(mf) ? mf : [];
    // 本地统计（events 表）
    const q1 = (sql, p) => { try { return ctx.storage.query(sql, p); } catch { return []; } };
    const lastActivityRow = q1(`SELECT MAX(created_at) v FROM events WHERE user_id=$u`, { $u: userId })[0];
    const lastOnlineRow = q1(`SELECT MAX(created_at) v FROM events WHERE user_id=$u AND type IN ('friend-online','friend-location')`, { $u: userId })[0];
    const joinCount = q1(`SELECT COUNT(*) c FROM events WHERE user_id=$u AND type='friend-online'`, { $u: userId })[0]?.c || 0;
    // 见面统计（VRCX 对齐）：
    // VRCX 桌面用本地 gamelog（世界内 OnPlayerJoined/Left）——我在场时对方进出，joinCount=COUNT(DISTINCT location)、timeSpent=SUM(停留时长)。
    // 服务端没有该数据源，用 WS 位置事件推算同屏：我的位置段 ∩ 对方位置段 且 instance 相同（段重叠）。
    const mySegRaw = q1(`SELECT json_extract(content_json,'$.location') loc, created_at at FROM events WHERE type='user-location' AND json_extract(content_json,'$.location') LIKE '%:%' ORDER BY created_at ASC`);
    const theirSegRaw = q1(`SELECT json_extract(content_json,'$.location') loc, created_at at FROM events WHERE user_id=$u AND type='friend-location' AND json_extract(content_json,'$.location') LIKE '%:%' ORDER BY created_at ASC`, { $u: userId });
    const buildSegs = (rows) => {
      const segs = [];
      for (let i = 0; i < rows.length; i++) {
        if (!rows[i].loc) continue;
        const start = new Date(rows[i].at).getTime();
        const end = (i + 1 < rows.length) ? new Date(rows[i + 1].at).getTime() : Date.now();
        if (Number.isFinite(start) && end >= start) segs.push({ loc: String(rows[i].loc), start, end });
      }
      return segs;
    };
    const mySegs = buildSegs(mySegRaw);
    const theirSegs = buildSegs(theirSegRaw);
    let timeSpentMs = 0;          // 同屏重叠时长（一起游玩的时长）
    let lastMeet = '';            // 最后一次同屏开始时间
    const meetLocSet = new Set(); // 同屏过的不同实例（见面的次数 ≈ DISTINCT location）
    for (const ts of theirSegs) {
      for (const ms of mySegs) {
        if (ts.loc !== ms.loc) continue;
        const s = Math.max(ts.start, ms.start);
        const e = Math.min(ts.end, ms.end);
        if (e > s) {
          meetLocSet.add(ts.loc);
          timeSpentMs += e - s;
          if (!lastMeet || ts.start > new Date(lastMeet).getTime()) lastMeet = new Date(ts.start).toISOString();
        }
      }
    }
    // 本地 friend 行（最近数据：位置/平台/签名/信任等）
    const localFriend = q1(`SELECT display_name displayName, is_online isOnline, location, world_name worldName, platform, status, status_description statusDescription, trust_level trustLevel, memo, last_seen lastSeen, avatar_image_url avatarUrl, user_icon userIcon, bio FROM friends WHERE user_id=$u`, { $u: userId })[0] || null;
    if (localFriend) localFriend.avatarUrl = avatarOf(localFriend.userIcon, localFriend.avatarUrl);
    // 模型名（currentAvatarImageUrl → file id → planet_cache avatar_name）
    let avatarName = '';
    try {
      const fm = String(user && (user.currentAvatarImageUrl || user.currentAvatarThumbnailImageUrl) || '').match(/\/file\/(file_[a-f0-9-]+)/);
      if (fm) {
        const anCache = loader._avatarNameCache || (loader._avatarNameCache = new Map());
        if (anCache.has(fm[1])) avatarName = anCache.get(fm[1]);
        else {
          const ar = ctx.storage.query(`SELECT payload FROM planet_cache WHERE key=$k`, { $k: `avatar_name:${fm[1]}` })[0];
          if (ar) { try { const v = JSON.parse(ar.payload); if (v && v.name) avatarName = v.name; } catch { /* ignore */ } }
        }
      }
    } catch { /* 模型名解析失败不影响 */ }
    // 展示群组：isRepresenting 优先，否则第一个
    const groupArr = Array.isArray(groups) ? groups : [];
    const representedGroup = groupArr.find((g) => g && g.isRepresenting) || groupArr[0] || null;
    // 本次在线时长（当前在线时：从最近 friend-online/location 或本地 last_seen 起算）
    let currentOnlineMs = 0;
    if (localFriend && localFriend.isOnline) {
      const t = (lastOnlineRow && lastOnlineRow.v) || localFriend.lastSeen || null;
      if (t) currentOnlineMs = Date.now() - new Date(t).getTime();
    }
    const dateFriendedRow = q1(`SELECT MIN(created_at) v FROM events WHERE user_id=$u AND type='friend-add'`, { $u: userId })[0];
    const pickGroup = (g) => ({ id: g.id || g.groupId || '', name: g.name || '', iconUrl: imgProxy(g.iconUrl || g.$thumbnailUrl || ''), memberCount: g.memberCount || 0, shortCode: g.shortCode || '', isRepresenting: !!g.isRepresenting });
    const pickWorld = (w) => ({ id: w.id || '', name: w.name || '', imageUrl: imgProxy(w.imageUrl || w.thumbnailImageUrl || ''), authorName: w.authorName || '', description: w.description || '', capacity: w.capacity || 0, favorites: w.favorites || 0, visits: w.visits || 0, releaseStatus: w.releaseStatus || '', createdAt: w.createdAt || '' });
    const pickAvatar = (a) => ({ id: a.id || '', name: a.name || '', thumbnailImageUrl: imgProxy(a.thumbnailImageUrl || ''), imageUrl: imgProxy(a.imageUrl || ''), releaseStatus: a.releaseStatus || '', tags: Array.isArray(a.tags) ? a.tags : [] });
    return {
      user,
      avatarName,
      representedGroup: representedGroup ? pickGroup(representedGroup) : null,
      mutualFriendCount: mutualFriends.length,
      mutualFriends: mutualFriends.map((f) => ({ id: f.id, displayName: f.displayName || '', avatarUrl: avatarOf(f.userIcon, f.currentAvatarImageUrl || f.currentAvatarThumbnailImageUrl) })),
      groups: groupArr.map(pickGroup),
      favoriteWorlds,
      worlds: Array.isArray(worlds) ? worlds.map(pickWorld) : [],
      avatars: Array.isArray(avatars) ? avatars.map(pickAvatar) : [],
      stats: {
        lastActivity: (user && user.last_activity) || (lastActivityRow && lastActivityRow.v) || '',
        lastOnline: (lastOnlineRow && lastOnlineRow.v) || '',
        joinCount,
        currentOnlineMs,
        meetCount: meetLocSet.size,
        lastMeet,
        timeSpentMs,
        dateJoined: (user && user.date_joined) || '',
        allowAvatarCopying: !!(user && user.allowAvatarCopying),
        dateFriended: (dateFriendedRow && dateFriendedRow.v) || '',
        onlineFriends: (user && Array.isArray(user.onlineFriends)) ? user.onlineFriends.length : 0,
      },
      localFriend,
    };
  });
  loader.serviceOwners.set('dashboard.userProfile', 'core');
}
